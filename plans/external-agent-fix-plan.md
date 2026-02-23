# 外控角色行为修复综合方案（修正版）

## 0. 目标对齐（以用户预期为准）

本修正版将会话模型与用户预期强绑定，替换旧版“按事件类型拆分 session_id”的设计。

### 0.1 会话隔离目标

- 关闭 AstrBot 会话隔离（[`platform_settings.unique_session=false`](AstrBot-master/astrbot/core/config/default.py:25)）：**整个 world 一个会话**。
- 开启 AstrBot 会话隔离（[`platform_settings.unique_session=true`](AstrBot-master/astrbot/core/config/default.py:25)）：**一个 NPC 一个会话**。

### 0.2 本次修正的核心原则

1. `session_id` 只用于“会话边界”，不再承载降噪职责。
2. `queue_refill` 降噪改为“唤醒门控 + 频率阈值（配置化）”。
3. 邀请处理策略配置化：支持“LLM 判断”与“自动接受”开关。
4. Convex 记忆系统不依赖 AstrBot `session_id`，不因 sid 格式调整而直接失效（记忆检索链路按 `playerId`）。

---

## 1. 诊断与验证（先验证，再落地行为）

### 1.1 候选问题来源（6项）

1. 旧方案把 sid 设计成“按事件类型拆分”，导致单 NPC 多会话。
2. `conversation.message` 使用 `conv:{conversationId}`，导致对话会话进一步细碎化。
3. `queue_refill_requested` 高频事件统一 `is_wake=True`，噪声进入 LLM 上下文。
4. 邀请链路依赖 LLM 从文本提取参数，受历史污染影响大。
5. 邀请策略文案前后不一致（“保留 LLM 决策”与“自动接受”并存）。
6. AstrBot 原生 unique_session 机制未直接覆盖 astrtown 自定义 sid 语义。

### 1.2 最可能根因（2项）

- 根因 A：会话模型目标定义错误（事件隔离）与业务期望（world/NPC 二态）不一致。
- 根因 B：降噪策略与会话策略耦合（用拆 sid 降噪），导致语义偏移。

### 1.3 必加验证日志（用于确认诊断）

在 [`astrbot_plugin_astrtown/adapter/astrtown_adapter.py`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py) 增加以下日志：

1. 在 [`_build_session_id()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:585)：
   - 记录 `unique_session`、`event_type`、`player_id`、`world_id`、最终 `session_id`。
2. 在 [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:478)：
   - 记录 `event_type`、是否唤醒、命中频率门控与门控原因。
3. 在邀请分支：
   - 记录配置策略（`llm_judge` / `auto_accept`）与最终动作（调用 LLM 或直发命令）。
4. 在 LLM 请求入口侧确认会话键：
   - 可关联 [`req.session_id = event.unified_msg_origin`](AstrBot-master/astrbot/core/astr_main_agent.py:1073) 观察是否符合 world/NPC 二态。

---

## 2. 修复项（修正版）

### 修复 1：邀请策略配置化（替代旧版冲突口径）

**问题**：旧方案中邀请策略口径冲突（既写“LLM 决策”，又写“自动接受”）。

**修改位置**：
- [`astrbot_plugin_astrtown/_conf_schema.json`](astrbot_plugin_astrtown/_conf_schema.json)
- [`astrbot_plugin_astrtown/main.py`](astrbot_plugin_astrtown/main.py)
- [`astrbot_plugin_astrtown/adapter/astrtown_adapter.py`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py)

**新增配置项**：

- `astrtown_invite_decision_mode`（string，默认 `llm_judge`）
  - `llm_judge`：保留 LLM 判断接受/拒绝
  - `auto_accept`：收到邀请后自动执行 `command.accept_invite`

**行为定义**：

1. `llm_judge`：保留现有 `conversation.invited -> commit_event -> LLM` 路径。
2. `auto_accept`：在适配器内直接调用 `send_command("command.accept_invite", ...)`，不走 LLM 决策。
3. 两种模式都保留事件 ACK 闭环（ACK 时机不变：先 commit 或完成直通逻辑，再 ACK）。

---

### 修复 2：sid 语义修正为 world/NPC 二态（替代“按事件类型分离 sid”）

**问题**：旧方案按事件类型拆 sid（`conv/refill/state/world`）会让单 NPC 变成多会话，偏离预期。

**修改位置**：[`_build_session_id()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:585)

**新规则（唯一生效规则）**：

1. 读取 [`platform_settings.unique_session`](AstrBot-master/astrbot/core/config/default.py:25)（通过 adapter 的 `self.settings`）。
2. 当 `unique_session=false`：
   - `session_id = astrtown:world:{world_id}`
3. 当 `unique_session=true`：
   - `session_id = astrtown:world:{world_id}:player:{player_id}`
4. 删除旧方案中所有“按事件类型分流 sid”的规则（不再使用 `conv/refill/state` 后缀）。

**预期效果**：

- 关闭隔离：同 world 事件汇总到单会话。
- 开启隔离：同 NPC 固定单会话，不受事件类型影响。

---

### 修复 3：queue_refill 降噪改为“唤醒门控 + 频率阈值配置化”

**问题**：[`event.is_wake = True`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:548) 对所有事件一刀切，`queue_refill` 高频触发导致噪声。

**修改位置**：[`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:478)

**新增配置项**：

- `astrtown_refill_wake_enabled`（bool，默认 `false`）
- `astrtown_refill_min_wake_interval_sec`（int，默认 `30`）

**行为定义**：

1. 当事件类型为 `agent.queue_refill_requested`：
   - 若 `astrtown_refill_wake_enabled=false`：仅入事件链但不唤醒 LLM（`is_wake=false`）。
   - 若 `astrtown_refill_wake_enabled=true`：仅当距离上次唤醒超过阈值时 `is_wake=true`。
2. 无论是否唤醒，ACK 语义与闭环保持不变。
3. **不再通过拆 sid 达成降噪**。

---

### 修复 4：上下文防护（作为兜底，不改变会话语义）

**原则**：

1. 主手段是修复 2（正确会话边界）+ 修复 3（唤醒门控）。
2. 兜底手段是在插件侧对高频事件减少进入 LLM 的机会，避免 world 模式下历史膨胀。
3. 不改 AstrBot 核心，仅插件侧控制进入 LLM 的事件量。

---

### 修复 5：command.ack 语义标注（低优先级）

保持原提案：在 [`gateway/src/commandRouter.ts`](gateway/src/commandRouter.ts) 给 ack 增加 `semantics: 'enqueued'`，避免“入队成功”被误解为“执行成功”。

---

### 修复 6：accept_invite 参数精简

保持原提案：将 [`accept_invite`](astrbot_plugin_astrtown/main.py:196) 改为仅需 `conversation_id`，去掉 `inviter_player_id`。

---

## 3. 配置项清单（修正版）

以下配置需同时定义于 [`_conf_schema.json`](astrbot_plugin_astrtown/_conf_schema.json) 与 [`_astrtown_items`](astrbot_plugin_astrtown/main.py:15)：

| 配置项 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `astrtown_invite_decision_mode` | string | `llm_judge` | 邀请处理策略：LLM判断/自动接受 |
| `astrtown_refill_wake_enabled` | bool | `false` | queue_refill 是否允许唤醒 LLM |
| `astrtown_refill_min_wake_interval_sec` | int | `30` | queue_refill 唤醒最小间隔（秒） |

---

## 4. 实施顺序（修正版）

1. 先加“验证日志”并观察一轮真实流量（确认诊断）。
2. 修复 6（`accept_invite` 参数精简）。
3. 修复 2（sid world/NPC 二态）+ 配置接入。
4. 修复 1（邀请策略配置化）。
5. 修复 3（queue_refill 门控与频率参数）。
6. 修复 4（上下文兜底）。
7. 修复 5（ack 语义，低优先级）。

---

## 5. 与旧方案差异（必须替换）

| 项目 | 旧方案 | 修正版 |
|---|---|---|
| sid 设计 | 按事件类型拆分（`conv/refill/state/world`） | 按 `unique_session` 二态：world 单会话 / NPC 单会话 |
| queue_refill 降噪 | 依赖拆 sid + 频率限制 | 仅用唤醒门控 + 频率阈值配置，不拆 sid |
| 邀请策略 | 文案冲突（LLM 与自动接受并存） | 单一配置项控制，语义一致 |

---

## 6. 风险评估（修正版）

1. sid 语义切换后，历史会话键会变化，旧上下文不会自动并入新键（可接受，属预期）。
2. world 单会话模式下上下文增长更快，需依赖修复 3/4 兜底。
3. 邀请策略默认值建议 `llm_judge`，避免行为突变；对“自动接受”由用户显式开启。

---

## 7. 验收标准

1. `unique_session=false` 时，同一 world 的事件进入同一 `session_id`。
2. `unique_session=true` 时，同一 NPC 事件固定 `session_id`，且不因事件类型变化。
3. `queue_refill` 在默认配置下不触发 LLM；开启后按阈值触发。
4. 邀请处理可通过配置在“LLM 判断”与“自动接受”间切换。
5. ACK 闭环与时序不被破坏（先 commit/完成处理，再 ACK）。
