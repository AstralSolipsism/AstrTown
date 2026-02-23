# 架构分析：convex 根目录轻量文件模块

> 范围：`AstrTown/convex/` 根目录下的轻量 TS 文件（不含子目录与生成代码）。
>
> 文件清单来源：任务描述中给出的 11 个文件列表。

## 1. 模块概述

convex 根目录轻量文件模块主要承担 **Convex 后端的“入口/胶水层”职责**：

- **全局常量**：提供世界运行、对话、清理任务等跨模块共享的参数（见 [`constants.ts`](../AstrTown/convex/constants.ts)）。
- **定时任务(crons)**：注册周期性维护任务（停止闲置世界、重启“死掉”的世界、清理旧数据）（见 [`crons.ts`](../AstrTown/convex/crons.ts)）。
- **HTTP 路由入口**：将外部 HTTP 请求分发到各业务 httpAction handler（鉴权、bot API、NPC 服务、Replicate webhook）（见 [`http.ts`](../AstrTown/convex/http.ts)）。
- **初始化入口**：创建默认世界与引擎，并按需注入 createAgent 输入（见 [`init.ts`](../AstrTown/convex/init.ts)）。
- **消息读写**：对 messages 表提供查询/写入，并把“发送消息完成”作为输入推入引擎（见 [`messages.ts`](../AstrTown/convex/messages.ts)）。
- **音乐生成与 webhook**：对 Replicate 生成音乐进行入队与 webhook 回调落库，并提供背景音乐读取（见 [`music.ts`](../AstrTown/convex/music.ts)）。
- **NPC 对话历史查询**：基于归档表与关系边表，提供 NPC 历史对话分组与详情查询（见 [`npcHistory.ts`](../AstrTown/convex/npcHistory.ts)）。
- **Schema 聚合**：将根目录新增表（music/messages/users/sessions/oauthAccounts/botTokens）与子模块表（agent/aiTown/engine）合并为全局 schema（见 [`schema.ts`](../AstrTown/convex/schema.ts)）。
- **测试/运维工具函数集**：批量清库、分页删除、启动/停止/恢复引擎、调试创建玩家、随机位置、LLM embedding/completion 测试等（见 [`testing.ts`](../AstrTown/convex/testing.ts)）。
- **世界生命周期与玩家交互**：默认世界状态、心跳、自动停机/重启、加入/离开、世界状态查询、描述查询、查找上一段对话等（见 [`world.ts`](../AstrTown/convex/world.ts)）。
- **轻量鉴权模块**：用户注册/登录/登出/查询我是谁，session token 提取（header/cookie）、PBKDF2 密码哈希、CORS 与 HTTP action 封装（见 [`auth.ts`](../AstrTown/convex/auth.ts)）。

在整体项目中，这些文件位于 Convex 后端的最外层：

- 与前端/外部系统交互：HTTP 路由（[`http.ts`](../AstrTown/convex/http.ts)）和面向前端的 query/mutation（如 [`world.ts`](../AstrTown/convex/world.ts) / [`messages.ts`](../AstrTown/convex/messages.ts)）。
- 与底层引擎/子模块协作：通过 `insertInput`、`startEngine/stopEngine/kickEngine`、`internal.*` 调度等桥接到 `aiTown`、`engine`、`agent` 子目录实现。
- 与数据模型协作：通过 [`schema.ts`](../AstrTown/convex/schema.ts) 定义/聚合所有表与索引。

## 2. 文件清单

> 行数来自本次读取结果的行号范围；字符数以仓库文件列表中的 `# chars` 为准（environment_details）。

| 文件 | 功能摘要 | 行数 | 字符数 |
|---|---|---:|---:|
| [`AstrTown/convex/constants.ts`](../AstrTown/convex/constants.ts) | 全局常量（超时、节拍、对话参数、清理策略、外控队列阈值等） | 86 | 3301 |
| [`AstrTown/convex/crons.ts`](../AstrTown/convex/crons.ts) | Cron 注册 + vacuum 逻辑（按表分页删除旧数据） | 89 | 3037 |
| [`AstrTown/convex/http.ts`](../AstrTown/convex/http.ts) | HTTP 路由入口：bot/auth/npc/replicate webhook 分发 | 138 | *（未在截断列表中显示 chars）* |
| [`AstrTown/convex/init.ts`](../AstrTown/convex/init.ts) | 初始化默认世界/引擎 + 按需创建 agents 输入 | 113 | *（未在截断列表中显示 chars）* |
| [`AstrTown/convex/messages.ts`](../AstrTown/convex/messages.ts) | messages 查询/写入 + 写入后插入引擎输入 | 54 | 1661 |
| [`AstrTown/convex/music.ts`](../AstrTown/convex/music.ts) | Replicate 音乐生成：背景音乐读取、入队、webhook 存储落库 | 135 | 4802 |
| [`AstrTown/convex/npcHistory.ts`](../AstrTown/convex/npcHistory.ts) | NPC 对话历史：分组摘要 + 对话详情消息列表 | 230 | 7126 |
| [`AstrTown/convex/schema.ts`](../AstrTown/convex/schema.ts) | Convex schema 聚合定义（根目录新增表 + 子模块表） | 70 | 2074 |
| [`AstrTown/convex/testing.ts`](../AstrTown/convex/testing.ts) | 内部测试/运维 mutations/actions：清表、停机/恢复、调试数据 | 232 | 7532 |
| [`AstrTown/convex/world.ts`](../AstrTown/convex/world.ts) | 世界生命周期与玩家交互：心跳、停机、重启、join/leave、state | 257 | 8333 |
| [`AstrTown/convex/auth.ts`](../AstrTown/convex/auth.ts) | 用户鉴权：注册/登录/登出/我是谁 + session token 提取 + CORS | 425 | 12923 |

## 3. 文件详细分析

### 3.1 [`constants.ts`](../AstrTown/convex/constants.ts)

**文件基本信息**
- 类型：常量导出文件
- 导入：无
- 导出：全部为 `export const`（以及 `ACTIVITIES` 常量数组）

**导出的内容（核心分组）**
- 引擎/世界节拍与超时：
  - [`ACTION_TIMEOUT`](../AstrTown/convex/constants.ts:1)
  - [`IDLE_WORLD_TIMEOUT`](../AstrTown/convex/constants.ts:4)
  - [`WORLD_HEARTBEAT_INTERVAL`](../AstrTown/convex/constants.ts:5)
  - [`MAX_STEP`](../AstrTown/convex/constants.ts:7)、[`TICK`](../AstrTown/convex/constants.ts:8)、[`STEP_INTERVAL`](../AstrTown/convex/constants.ts:9)
- 对话/行为控制：
  - [`CONVERSATION_DISTANCE`](../AstrTown/convex/constants.ts:13)
  - [`TYPING_TIMEOUT`](../AstrTown/convex/constants.ts:15)
  - [`CONVERSATION_COOLDOWN`](../AstrTown/convex/constants.ts:22)
  - [`PLAYER_CONVERSATION_COOLDOWN`](../AstrTown/convex/constants.ts:28)
  - [`AWKWARD_CONVERSATION_TIMEOUT`](../AstrTown/convex/constants.ts:37)
  - [`MAX_CONVERSATION_DURATION`](../AstrTown/convex/constants.ts:41)
  - [`MAX_CONVERSATION_MESSAGES`](../AstrTown/convex/constants.ts:45)
  - [`MESSAGE_COOLDOWN`](../AstrTown/convex/constants.ts:56)
  - [`AGENT_WAKEUP_THRESHOLD`](../AstrTown/convex/constants.ts:59)
- 清理/vacuum：
  - [`VACUUM_MAX_AGE`](../AstrTown/convex/constants.ts:62)
  - [`DELETE_BATCH_SIZE`](../AstrTown/convex/constants.ts:63)
- 人类玩家/默认名：
  - [`MAX_HUMAN_PLAYERS`](../AstrTown/convex/constants.ts:19)
  - [`DEFAULT_NAME`](../AstrTown/convex/constants.ts:78)
- 活动配置：
  - [`ACTIVITIES`](../AstrTown/convex/constants.ts:67)
- 外控 NPC 事件队列（注释标明用途）：
  - [`EXTERNAL_QUEUE_LOW_WATERMARK`](../AstrTown/convex/constants.ts:81)
  - [`EXTERNAL_QUEUE_PREFETCH_TIMEOUT`](../AstrTown/convex/constants.ts:82)
  - [`EXTERNAL_QUEUE_PREFETCH_MIN_INTERVAL`](../AstrTown/convex/constants.ts:83)
  - [`EXTERNAL_QUEUE_LEAVE_THRESHOLD`](../AstrTown/convex/constants.ts:84)
  - [`EXTERNAL_QUEUE_SLEEP_WINDOW`](../AstrTown/convex/constants.ts:85)
  - [`EXTERNAL_QUEUE_MAX_SIZE`](../AstrTown/convex/constants.ts:86)

**文件内部关系**
- 无函数/类型间依赖；按主题分段组织常量。

**文件间关系**
- 被多个模块引用：
  - [`crons.ts`](../AstrTown/convex/crons.ts) 使用 [`DELETE_BATCH_SIZE`](../AstrTown/convex/constants.ts:63) / [`IDLE_WORLD_TIMEOUT`](../AstrTown/convex/constants.ts:4) / [`VACUUM_MAX_AGE`](../AstrTown/convex/constants.ts:62)
  - [`init.ts`](../AstrTown/convex/init.ts) 使用 [`ENGINE_ACTION_DURATION`](../AstrTown/convex/constants.ts:73)
  - [`testing.ts`](../AstrTown/convex/testing.ts) 使用 [`DELETE_BATCH_SIZE`](../AstrTown/convex/constants.ts:63) 与 [`CONVERSATION_DISTANCE`](../AstrTown/convex/constants.ts:13)
  - [`world.ts`](../AstrTown/convex/world.ts) 使用 [`DEFAULT_NAME`](../AstrTown/convex/constants.ts:78) / [`ENGINE_ACTION_DURATION`](../AstrTown/convex/constants.ts:73) / [`IDLE_WORLD_TIMEOUT`](../AstrTown/convex/constants.ts:4) / [`WORLD_HEARTBEAT_INTERVAL`](../AstrTown/convex/constants.ts:5)

---

### 3.2 [`crons.ts`](../AstrTown/convex/crons.ts)

**文件基本信息**
- 类型：cron 定义 + 内部 mutation（vacuum）

**导入的模块**
- Convex：`cronJobs`（`convex/server`）、`internalMutation`（[`_generated/server`](../AstrTown/convex/_generated/server.d.ts)）、`v`（`convex/values`）
- 项目内部：
  - 常量：[`DELETE_BATCH_SIZE`](../AstrTown/convex/constants.ts:63)、[`IDLE_WORLD_TIMEOUT`](../AstrTown/convex/constants.ts:4)、[`VACUUM_MAX_AGE`](../AstrTown/convex/constants.ts:62)
  - API 路由：[`internal`](../AstrTown/convex/_generated/api.d.ts)
  - 数据模型类型：`TableNames`（[`_generated/dataModel.d.ts`](../AstrTown/convex/_generated/dataModel.d.ts)）

**导出的内容**
- `export default crons`：注册了三个 cron：
  - interval：stop inactive worlds → `internal.world.stopInactiveWorlds`
  - interval：restart dead worlds → `internal.world.restartDeadWorlds`
  - daily：vacuum old entries → `internal.crons.vacuumOldEntries`
- `export const vacuumOldEntries`：扫描 `TablesToVacuum`，对存在旧数据的表调度 vacuumTable（见 [`vacuumOldEntries`](../AstrTown/convex/crons.ts:40)）
- `export const vacuumTable`：分页删除（见 [`vacuumTable`](../AstrTown/convex/crons.ts:63)）

**定义的函数/变量**
- 顶层常量：[`TablesToVacuum`](../AstrTown/convex/crons.ts:22)（当前包含 `inputs/memories/memoryEmbeddings`）

**文件内部关系**
- [`vacuumOldEntries`](../AstrTown/convex/crons.ts:40) 计算 `before` → 对每张表先 `.first()` 判断是否存在旧数据 → 若存在用 `ctx.scheduler.runAfter` 调度 [`vacuumTable`](../AstrTown/convex/crons.ts:63)
- [`vacuumTable`](../AstrTown/convex/crons.ts:63) 用 `.paginate({ cursor, numItems: DELETE_BATCH_SIZE })` 分页删除；未结束则继续调度自身，结束则 log 总数

**文件间关系**
- 依赖：[`constants.ts`](../AstrTown/convex/constants.ts) 提供 vacuum/idle 参数
- 调用目标（通过 `internal.*`）：
  - `internal.world.stopInactiveWorlds` / `internal.world.restartDeadWorlds`（见 [`world.ts`](../AstrTown/convex/world.ts) 内部导出）
  - `internal.crons.vacuumOldEntries` / `internal.crons.vacuumTable`（本文件内部导出）

---

### 3.3 [`http.ts`](../AstrTown/convex/http.ts)

**文件基本信息**
- 类型：HTTP Router 入口

**导入的模块**
- Convex：`httpRouter`（`convex/server`）
- 项目内部 handler：
  - 鉴权：[`getAuthMe`](../AstrTown/convex/auth.ts:413)、[`optionsAuth`](../AstrTown/convex/auth.ts:325)、[`postAuthLogin`](../AstrTown/convex/auth.ts:358)、[`postAuthLogout`](../AstrTown/convex/auth.ts:384)、[`postAuthRegister`](../AstrTown/convex/auth.ts:329)
  - 音乐 webhook：[`handleReplicateWebhook`](../AstrTown/convex/music.ts:61)
  - bot API（来自 [`botApi.ts`](../AstrTown/convex/botApi.ts)）：`postCommand/postCommandBatchHttp/postDescriptionUpdate/postEventAck/getWorldState/getAgentStatus/postControl/postTokenValidate/postTokenCreate`
  - npc 服务（来自 [`npcService.ts`](../AstrTown/convex/npcService.ts)）：`postNpcCreate/getNpcList/postNpcResetToken/getNpcTokenById/optionsNpc`

**导出的内容**
- `export default http`：包含一系列 `http.route({ path, method, handler })` 注册。

**文件内部关系**
- 本文件仅组装路由，无业务逻辑。

**文件间关系（路由 → handler）**
- `/replicate_webhook` POST → [`handleReplicateWebhook`](../AstrTown/convex/music.ts:61)
- `/api/bot/*` → `botApi.ts` 中对应 handler
- `/api/auth/*` → [`auth.ts`](../AstrTown/convex/auth.ts) 中对应 handler
- `/api/npc/*` → `npcService.ts` 中对应 handler

---

### 3.4 [`init.ts`](../AstrTown/convex/init.ts)

**文件基本信息**
- 类型：默认导出 mutation（初始化入口）+ 2 个内部 helper 函数

**导入的模块**
- Convex：`v`（`convex/values`），`mutation/DatabaseReader/MutationCtx`（[`_generated/server`](../AstrTown/convex/_generated/server.d.ts)）
- 项目内部：
  - `internal`（[`_generated/api.d.ts`](../AstrTown/convex/_generated/api.d.ts)）用于 scheduler 调度 `internal.aiTown.main.runStep`
  - 数据：`Descriptions`（[`AstrTown/data/characters`](../AstrTown/data/characters)）、`map`（[`AstrTown/data/gentle.js`](../AstrTown/data/gentle.js)）
  - 引擎输入：[`insertInput`](../AstrTown/convex/aiTown/insertInput.ts:1)
  - 类型：`Id`（[`_generated/dataModel.d.ts`](../AstrTown/convex/_generated/dataModel.d.ts)）
  - 创建引擎：`createEngine`（[`aiTown/main.ts`](../AstrTown/convex/aiTown/main.ts)）
  - 常量：[`ENGINE_ACTION_DURATION`](../AstrTown/convex/constants.ts:73)
  - 检查 LLM provider：`detectMismatchedLLMProvider`（[`util/llm`](../AstrTown/convex/util/llm)；本次未读取文件内容）

**导出的内容**
- `export default init`：mutation，参数 `numAgents?: number`（见 [`init`](../AstrTown/convex/init.ts:12)）

**定义的函数/变量**
- [`getOrCreateDefaultWorld`](../AstrTown/convex/init.ts:42)
- [`shouldCreateAgents`](../AstrTown/convex/init.ts:90)

**文件内部关系（执行链）**
- [`init`](../AstrTown/convex/init.ts:12)
  1. 调用 [`detectMismatchedLLMProvider`](../AstrTown/convex/init.ts:17)
  2. 调用 [`getOrCreateDefaultWorld`](../AstrTown/convex/init.ts:42)
  3. 若 worldStatus 非 running：仅 warn 并 return
  4. 调用 [`shouldCreateAgents`](../AstrTown/convex/init.ts:90) 判断是否需要注入 createAgent 输入
  5. 若需要：按 `numAgents ?? Descriptions.length` 循环调用 [`insertInput`](../AstrTown/convex/init.ts:33) 写入 `createAgent`
- [`getOrCreateDefaultWorld`](../AstrTown/convex/init.ts:42)
  - 先查 `worldStatus` 表中 `isDefault=true`；有则返回 `{ worldStatus, engine }`
  - 无则：
    - `createEngine` → insert `worlds/worldStatus/maps`
    - `ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, { worldId, generationNumber, maxDuration })` 启动第一步引擎运行
- [`shouldCreateAgents`](../AstrTown/convex/init.ts:90)
  - world.agents 非空 → false
  - inputs 表中存在未处理的 `createAgent` 输入 → false
  - 否则 true

**文件间关系**
- 强依赖引擎子模块：`aiTown/main`、`aiTown/insertInput`
- 依赖数据模块：`data/characters`、`data/gentle`

---

### 3.5 [`messages.ts`](../AstrTown/convex/messages.ts)

**文件基本信息**
- 类型：query + mutation（消息读写）

**导入的模块**
- Convex：`v`（`convex/values`）、`query/mutation`（[`_generated/server`](../AstrTown/convex/_generated/server.d.ts)）
- 项目内部：
  - 引擎输入：[`insertInput`](../AstrTown/convex/aiTown/insertInput.ts:1)
  - ID 校验器：`conversationId/playerId`（[`aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts)）

**导出的内容**
- [`listMessages`](../AstrTown/convex/messages.ts:6)：按索引 `conversationId` 查询 messages，并补充 authorName
- [`writeMessage`](../AstrTown/convex/messages.ts:31)：插入 messages 表 + 插入引擎输入 `finishSendingMessage`

**定义的函数和变量**
- 无额外 helper

**文件内部关系**
- [`listMessages`](../AstrTown/convex/messages.ts:6)
  - `ctx.db.query('messages').withIndex('conversationId', ...)` 收集该对话消息
  - 对每条消息查询 `playerDescriptions` 获取作者名称；缺失则 throw
- [`writeMessage`](../AstrTown/convex/messages.ts:31)
  - `ctx.db.insert('messages', ...)`
  - `insertInput(..., 'finishSendingMessage', { conversationId, playerId, text, timestamp })`

**文件间关系**
- 与 schema：messages 表与索引在 [`schema.ts`](../AstrTown/convex/schema.ts:14) 定义
- 与引擎：通过 `insertInput` 把“发消息完成”事件交给引擎处理

---

### 3.6 [`music.ts`](../AstrTown/convex/music.ts)

**文件基本信息**
- 类型：query + internalMutation + internalAction + httpAction + 纯 TS helper

**导入的模块**
- Convex：`v`、[`query`](../AstrTown/convex/music.ts:2)、[`internalMutation`](../AstrTown/convex/music.ts:2)、[`httpAction`](../AstrTown/convex/music.ts:61)、[`internalAction`](../AstrTown/convex/music.ts:46)
- Replicate SDK：`Replicate`、`WebhookEventType`
- 项目内部：`internal/api`（[`_generated/api.d.ts`](../AstrTown/convex/_generated/api.d.ts)）

**导出的内容**
- [`insertMusic`](../AstrTown/convex/music.ts:18)：内部落库 `music` 表
- [`getBackgroundMusic`](../AstrTown/convex/music.ts:28)：取最新 background 音乐，无则返回默认静态路径
- [`enqueueBackgroundMusicGeneration`](../AstrTown/convex/music.ts:46)：内部 action：有 token 且存在默认世界时调用 [`generateMusic`](../AstrTown/convex/music.ts:100)
- [`handleReplicateWebhook`](../AstrTown/convex/music.ts:61)：webhook：拉取 prediction output → fetch 音频 → storage.store → runMutation insertMusic
- [`generateMusic`](../AstrTown/convex/music.ts:100)：直接调用 replicate predictions.create

**定义的函数/变量/枚举**
- helper：[`client`](../AstrTown/convex/music.ts:7)、[`replicateAvailable`](../AstrTown/convex/music.ts:14)
- 枚举：[`MusicGenNormStrategy`](../AstrTown/convex/music.ts:73)、[`MusicGenFormat`](../AstrTown/convex/music.ts:80)

**文件内部关系**
- [`enqueueBackgroundMusicGeneration`](../AstrTown/convex/music.ts:46) → `ctx.runQuery(api.world.defaultWorldStatus)`（见 [`world.ts`](../AstrTown/convex/world.ts:15)）→ [`generateMusic`](../AstrTown/convex/music.ts:100)
- [`handleReplicateWebhook`](../AstrTown/convex/music.ts:61) → `client().predictions.get(req.id)` → `fetch(prediction.output)` → `ctx.storage.store(blob)` → `ctx.runMutation(internal.music.insertMusic, ...)`

**文件间关系**
- 与 [`http.ts`](../AstrTown/convex/http.ts) 的 `/replicate_webhook` 路由绑定
- 与 schema：`music` 表在 [`schema.ts`](../AstrTown/convex/schema.ts:9) 定义
- 与 world：通过 `api.world.defaultWorldStatus` 判断是否有默认世界

---

### 3.7 [`npcHistory.ts`](../AstrTown/convex/npcHistory.ts)

**文件基本信息**
- 类型：query（历史摘要与详情）+ 若干本地类型与 helper

**导入的模块**
- Convex：`v`、`query`
- 项目内部：`conversationId/playerId`（[`aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts)）

**导出的内容**
- [`getNpcConversationHistory`](../AstrTown/convex/npcHistory.ts:56)
- [`getConversationDetail`](../AstrTown/convex/npcHistory.ts:171)

**定义的函数/类型/变量**
- helper：[`getTimeLabel`](../AstrTown/convex/npcHistory.ts:7)
- 类型：`TimeLabel`、`ConversationSummary`、`ConversationGroup`、`MessageWithAuthor`

**文件内部关系（核心流程）**
- [`getNpcConversationHistory`](../AstrTown/convex/npcHistory.ts:56)
  1. 计算 `now`（`referenceTime ?? Date.now()`）与 `timezoneOffsetMinutes`
  2. 读取 `worlds` 获取 `world.agents` 快照，建立 NPC `playerId` 集合
  3. 查询 `archivedAgents` 补齐已离开世界的 NPC
  4. 通过 `participatedTogether` 的 `playerHistory` 索引，按 `ended` 倒序取 memberEdges
  5. 用 `seenConversationIds` 去重同一 conversation
  6. 对每条 edge：
     - 查 `archivedConversations`（按 `worldId + id` 索引）
     - 过滤掉不存在或 `numMessages<=0`
     - 构建 summary，并对 participants 中“除 npc 自身外的每个 otherPlayer”分组
     - `playerDescriptions` 做 name cache
  7. 对每个 group 的各时间桶按 `ended` 降序
  8. 返回 `{ npcPlayerId, npcName, groups }`
- [`getConversationDetail`](../AstrTown/convex/npcHistory.ts:171)
  1. 查询 `archivedConversations`，不存在返回 null
  2. 若 npc 不在 participants 内，返回空数组
  3. 查询 `messages`（按 `conversationId` 索引）
  4. 为每条 message 查询作者 `playerDescriptions`（带 cache）并组装 `MessageWithAuthor`
  5. 按 `_creationTime` 升序排序并返回聚合对象

**文件间关系**
- 强依赖数据表：`worlds/archivedAgents/participatedTogether/archivedConversations/messages/playerDescriptions`
- 其中 `messages` 表由 [`schema.ts`](../AstrTown/convex/schema.ts:14) 定义；其余表来自子模块 schema（本次范围外，仅在 [`schema.ts`](../AstrTown/convex/schema.ts) 通过 spread 聚合）。

---

### 3.8 [`schema.ts`](../AstrTown/convex/schema.ts)

**文件基本信息**
- 类型：schema 聚合

**导入的模块**
- Convex：`defineSchema/defineTable`、`v`
- 项目内部：
  - `agentTables`（[`./agent/schema`](../AstrTown/convex/agent/schema)；未读取具体内容）
  - `aiTownTables`（[`./aiTown/schema`](../AstrTown/convex/aiTown/schema.ts)；未读取具体内容）
  - `engineTables`（[`./engine/schema`](../AstrTown/convex/engine/schema)；未读取具体内容）
  - validators：`conversationId/playerId/agentId`（[`aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts)）

**导出的内容**
- `export default defineSchema({...})`（见 [`default`](../AstrTown/convex/schema.ts:8)）

**schema 内定义的表与索引（根目录部分）**
- `music`：`storageId/type`
- `messages`：`conversationId/messageUuid/author/text/worldId?` + 索引：
  - `conversationId`：`['worldId','conversationId']`
  - `messageUuid`：`['conversationId','messageUuid']`
- `users`：`username/passwordHash/salt/role/createdAt` + `by_username`
- `sessions`：`userId/token/expiresAt/createdAt` + `by_token`、`by_userId`
- `oauthAccounts`：`userId/provider/providerUserId/createdAt` + `by_provider_user`
- `botTokens`：`token/agentId/playerId/userId?/worldId/createdAt/expiresAt/isActive/lastUsedAt?/lastIdempotencyKey?/lastIdempotencyResult?/description?` + 索引：
  - `token`
  - `agentId`：`['worldId','agentId']`
  - `worldId`
  - `by_userId`
- 扩展：`...agentTables/...aiTownTables/...engineTables`

**文件间关系**
- [`auth.ts`](../AstrTown/convex/auth.ts) 读写 `users/sessions/oauthAccounts`
- [`messages.ts`](../AstrTown/convex/messages.ts) 读写 `messages`
- [`music.ts`](../AstrTown/convex/music.ts) 读写 `music`
- `botApi.ts`/`npcService.ts` 等可能使用 `botTokens`（具体使用在本次范围外）

---

### 3.9 [`testing.ts`](../AstrTown/convex/testing.ts)

**文件基本信息**
- 类型：内部测试/运维聚合

**导入的模块**
- 数据模型：`Id/TableNames`（[`_generated/dataModel.d.ts`](../AstrTown/convex/_generated/dataModel.d.ts)）
- API：`internal`（[`_generated/api.d.ts`](../AstrTown/convex/_generated/api.d.ts)）
- Convex server：`DatabaseReader/internalAction/internalMutation/mutation/query`、`v`
- schema：默认导出 schema（[`schema.ts`](../AstrTown/convex/schema.ts)）
- 常量：[`DELETE_BATCH_SIZE`](../AstrTown/convex/constants.ts:63)、[`CONVERSATION_DISTANCE`](../AstrTown/convex/constants.ts:13)
- 引擎：`kickEngine/startEngine/stopEngine`（[`aiTown/main.ts`](../AstrTown/convex/aiTown/main.ts)）
- 输入：[`insertInput`](../AstrTown/convex/aiTown/insertInput.ts:1)
- LLM：`fetchEmbedding/chatCompletion`（[`util/llm`](../AstrTown/convex/util/llm)；未读取）
- agent：`startConversationMessage`（[`agent/conversation`](../AstrTown/convex/agent/conversation)；未读取）
- ids：`GameId`（[`aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts)）
- 几何：`distance`（[`util/geometry`](../AstrTown/convex/util/geometry.test.ts)；此处仅用于计算距离）

**导出的内容（按用途分组）**
- 清表：
  - [`wipeAllTables`](../AstrTown/convex/testing.ts:25)：遍历 schema.tables，排除 embeddingsCache，调度分页删除
  - [`deletePage`](../AstrTown/convex/testing.ts:36)：分页删除指定表
- 引擎控制：
  - [`kick`](../AstrTown/convex/testing.ts:57)
  - [`stopAllowed`](../AstrTown/convex/testing.ts:64)
  - [`stop`](../AstrTown/convex/testing.ts:70)
  - [`resume`](../AstrTown/convex/testing.ts:87)
  - [`archive`](../AstrTown/convex/testing.ts:133)
- 调试数据：
  - [`debugCreatePlayers`](../AstrTown/convex/testing.ts:159)
  - [`randomPositions`](../AstrTown/convex/testing.ts:175)
- LLM 测试：
  - [`testEmbedding`](../AstrTown/convex/testing.ts:201)
  - [`testCompletion`](../AstrTown/convex/testing.ts:208)
  - [`testConvo`](../AstrTown/convex/testing.ts:220)

**关键内部函数**
- [`getDefaultWorld`](../AstrTown/convex/testing.ts:144)：从 `worldStatus` 找 `isDefault=true`，并读取 engine

**文件内部关系（代表性链路）**
- [`wipeAllTables`](../AstrTown/convex/testing.ts:25) → 对每张表 `ctx.scheduler.runAfter(0, internal.testing.deletePage, ...)`
- [`resume`](../AstrTown/convex/testing.ts:87)
  - patch worldStatus 为 running
  - 对外控 agent：根据玩家位置筛选近邻（`distance <= CONVERSATION_DISTANCE`），调度 `internal.aiTown.worldEventDispatcher.scheduleAgentStateChanged`
  - 最后 `startEngine`

**文件间关系**
- 通过 `internal.testing.deletePage` 形成自我调度分页删除
- 强依赖 `aiTown/main` 引擎控制与 `aiTown/worldEventDispatcher` 的内部调度（后者不在本次范围）

---

### 3.10 [`world.ts`](../AstrTown/convex/world.ts)

**文件基本信息**
- 类型：query/mutation/internalMutation（世界生命周期/状态接口）

**导入的模块**
- Convex：`ConvexError/v`、`internalMutation/mutation/query`
- 数据：`characters`（[`AstrTown/data/characters`](../AstrTown/data/characters)）
- 引擎输入：[`insertInput`](../AstrTown/convex/aiTown/insertInput.ts:1)
- 常量：[`DEFAULT_NAME`](../AstrTown/convex/constants.ts:78)、[`ENGINE_ACTION_DURATION`](../AstrTown/convex/constants.ts:73)、[`IDLE_WORLD_TIMEOUT`](../AstrTown/convex/constants.ts:4)、[`WORLD_HEARTBEAT_INTERVAL`](../AstrTown/convex/constants.ts:5)
- ids：`playerId`（[`aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts)）
- 引擎控制：`kickEngine/startEngine/stopEngine`（[`aiTown/main.ts`](../AstrTown/convex/aiTown/main.ts)）
- engine 抽象：`engineInsertInput`（[`engine/abstractGame`](../AstrTown/convex/engine/abstractGame)；未读取）

**导出的内容（接口面）**
- 默认世界：[`defaultWorldStatus`](../AstrTown/convex/world.ts:15)
- 心跳与自恢复：[`heartbeatWorld`](../AstrTown/convex/world.ts:25)
- cron 调用目标：[`stopInactiveWorlds`](../AstrTown/convex/world.ts:59)、[`restartDeadWorlds`](../AstrTown/convex/world.ts:74)
- 用户与世界交互：
  - [`userStatus`](../AstrTown/convex/world.ts:97)
  - [`joinWorld`](../AstrTown/convex/world.ts:111)
  - [`leaveWorld`](../AstrTown/convex/world.ts:142)
  - [`sendWorldInput`](../AstrTown/convex/world.ts:167)
- 状态读取：
  - [`worldState`](../AstrTown/convex/world.ts:182)
  - [`gameDescriptions`](../AstrTown/convex/world.ts:206)
  - [`previousConversation`](../AstrTown/convex/world.ts:230)

**文件内部关系（关键逻辑）**
- [`heartbeatWorld`](../AstrTown/convex/world.ts:25)
  - 读取 `worldStatus`（`withIndex('worldId')`）并根据 `WORLD_HEARTBEAT_INTERVAL/2` 频率 patch `lastViewed`
  - 若 status 为 `inactive`：patch 为 `running` 并 `startEngine`
  - 若 status 为 `stoppedByDeveloper`：仅 debug，不自动重启
- [`stopInactiveWorlds`](../AstrTown/convex/world.ts:59)
  - cutoff = now - `IDLE_WORLD_TIMEOUT`
  - 遍历 `worldStatus`：满足 lastViewed 过旧且 status=running → patch 为 inactive 并 `stopEngine`
- [`restartDeadWorlds`](../AstrTown/convex/world.ts:74)
  - engineTimeout = now - `ENGINE_ACTION_DURATION*2`
  - 若 engine.currentTime < engineTimeout → `kickEngine`
- [`joinWorld`](../AstrTown/convex/world.ts:111) / [`leaveWorld`](../AstrTown/convex/world.ts:142)
  - 当前实现绕过真实 identity（注释保留），使用 [`DEFAULT_NAME`](../AstrTown/convex/constants.ts:78)
  - 通过 [`insertInput`](../AstrTown/convex/world.ts:132) 写入引擎输入 `join/leave`
- [`sendWorldInput`](../AstrTown/convex/world.ts:167)
  - 直接转发到 `engineInsertInput`（engine 子模块抽象层）

**文件间关系**
- 被 [`crons.ts`](../AstrTown/convex/crons.ts) 以 `internal.world.*` 定时调用
- 被 [`music.ts`](../AstrTown/convex/music.ts) 通过 `api.world.defaultWorldStatus` 调用

---

### 3.11 [`auth.ts`](../AstrTown/convex/auth.ts)

**文件基本信息**
- 类型：query/mutation/httpAction + 鉴权工具函数

**导入的模块**
- Convex：`v`、`httpAction/mutation/query` + ctx 类型（ActionCtx/MutationCtx/QueryCtx）
- API：`api`（[`_generated/api.d.ts`](../AstrTown/convex/_generated/api.d.ts)）用于 httpAction 内 `runMutation/runQuery`
- 数据模型：`Id`（[`_generated/dataModel.d.ts`](../AstrTown/convex/_generated/dataModel.d.ts)）

**导出的内容**
- types：`export type UserInfo`（见 [`UserInfo`](../AstrTown/convex/auth.ts:20)）
- session 工具：
  - [`extractSessionToken`](../AstrTown/convex/auth.ts:121)
  - [`validateSession`](../AstrTown/convex/auth.ts:174)
  - [`generateSalt`](../AstrTown/convex/auth.ts:184)
  - [`generateSessionToken`](../AstrTown/convex/auth.ts:190)
  - [`hashPassword`](../AstrTown/convex/auth.ts:196)
- mutations/queries：
  - [`register`](../AstrTown/convex/auth.ts:214)
  - [`login`](../AstrTown/convex/auth.ts:257)
  - [`logout`](../AstrTown/convex/auth.ts:296)
  - [`getMe`](../AstrTown/convex/auth.ts:316)
- http actions（与 [`http.ts`](../AstrTown/convex/http.ts) 路由绑定）：
  - [`optionsAuth`](../AstrTown/convex/auth.ts:325)
  - [`postAuthRegister`](../AstrTown/convex/auth.ts:329)
  - [`postAuthLogin`](../AstrTown/convex/auth.ts:358)
  - [`postAuthLogout`](../AstrTown/convex/auth.ts:384)
  - [`getAuthMe`](../AstrTown/convex/auth.ts:413)

**关键内部函数/变量**
- 常量：`USERNAME_REGEX/SESSION_TTL_MS/PASSWORD_MIN_LENGTH/PBKDF2_*`、CORS headers 常量
- CORS/响应封装：
  - [`buildCorsHeaders`](../AstrTown/convex/auth.ts:26)
  - [`corsPreflightResponse`](../AstrTown/convex/auth.ts:37)
  - [`jsonResponse`](../AstrTown/convex/auth.ts:52)
  - [`badRequest`](../AstrTown/convex/auth.ts:63)、[`unauthorized`](../AstrTown/convex/auth.ts:67)、[`internalError`](../AstrTown/convex/auth.ts:71)
- token 解析：
  - [`parseBearerToken`](../AstrTown/convex/auth.ts:90)
  - [`parseCookieToken`](../AstrTown/convex/auth.ts:99)
- 安全相关：
  - [`equalsConstantTime`](../AstrTown/convex/auth.ts:81)
  - [`hashPassword`](../AstrTown/convex/auth.ts:196)：PBKDF2(SHA-256) + pepper（`AUTH_SECRET`）
- session：
  - [`createSession`](../AstrTown/convex/auth.ts:137)
  - [`validateSessionWithDb`](../AstrTown/convex/auth.ts:149)
  - [`isDbCtx`](../AstrTown/convex/auth.ts:170)

**文件内部关系（HTTP → mutation/query）**
- [`postAuthRegister`](../AstrTown/convex/auth.ts:329) → `ctx.runMutation(api.auth.register, ...)`
- [`postAuthLogin`](../AstrTown/convex/auth.ts:358) → `ctx.runMutation(api.auth.login, ...)`
- [`postAuthLogout`](../AstrTown/convex/auth.ts:384) → 从 header/cookie/JSON body 提取 token → `ctx.runMutation(api.auth.logout, ...)`
- [`getAuthMe`](../AstrTown/convex/auth.ts:413) → `extractSessionToken` → `ctx.runQuery(api.auth.getMe, ...)`

**文件间关系**
- 与 [`schema.ts`](../AstrTown/convex/schema.ts) 的 `users/sessions/oauthAccounts` 表对应
- 与 [`http.ts`](../AstrTown/convex/http.ts) 形成 auth 路由入口

## 4. 模块关系图（文字依赖图）

以“根目录轻量文件”为节点的依赖关系概览：

- [`http.ts`](../AstrTown/convex/http.ts)
  - → [`auth.ts`](../AstrTown/convex/auth.ts)（auth 路由 handler）
  - → [`music.ts`](../AstrTown/convex/music.ts)（replicate webhook handler）
  - → `botApi.ts`、`npcService.ts`（非本次 11 文件范围，但为根目录业务文件）
- [`crons.ts`](../AstrTown/convex/crons.ts)
  - → [`constants.ts`](../AstrTown/convex/constants.ts)
  - → [`world.ts`](../AstrTown/convex/world.ts)（通过 `internal.world.*`）
  - → 自身内部：`internal.crons.vacuumOldEntries/vacuumTable`
- [`init.ts`](../AstrTown/convex/init.ts)
  - → [`constants.ts`](../AstrTown/convex/constants.ts)
  - → `aiTown/main`（createEngine + runStep 调度）
  - → `aiTown/insertInput`（createAgent 输入）
- [`messages.ts`](../AstrTown/convex/messages.ts)
  - → `aiTown/insertInput`（finishSendingMessage 输入）
  - → schema 中 `messages` 表（见 [`schema.ts`](../AstrTown/convex/schema.ts)）
- [`music.ts`](../AstrTown/convex/music.ts)
  - → [`world.ts`](../AstrTown/convex/world.ts)（通过 `api.world.defaultWorldStatus`）
  - → schema 中 `music` 表（见 [`schema.ts`](../AstrTown/convex/schema.ts)）
  - → Replicate 外部服务（SDK + webhook）
- [`npcHistory.ts`](../AstrTown/convex/npcHistory.ts)
  - → schema 聚合出的多张表（messages/playerDescriptions 等）
- [`testing.ts`](../AstrTown/convex/testing.ts)
  - → [`schema.ts`](../AstrTown/convex/schema.ts)（遍历 tables）
  - → [`constants.ts`](../AstrTown/convex/constants.ts)
  - → `aiTown/main`、`aiTown/insertInput`、`aiTown/worldEventDispatcher`
- [`world.ts`](../AstrTown/convex/world.ts)
  - → [`constants.ts`](../AstrTown/convex/constants.ts)
  - → `aiTown/main`（start/stop/kick）
  - → `aiTown/insertInput`（join/leave）
  - → `engine/abstractGame`（engineInsertInput）
- [`schema.ts`](../AstrTown/convex/schema.ts)
  - → `agent/schema`、`aiTown/schema`、`engine/schema`（表集合 spread）

## 5. 数据流分析

### 5.1 世界启动/运行数据流

- 初始化入口：[`init`](../AstrTown/convex/init.ts:12)
  - 读取/创建默认 `worldStatus/worlds/engines/maps`
  - 调度 `internal.aiTown.main.runStep`（引擎开始运行一个 step）
  - 若需要创建 agent：通过 `insertInput` 写入 `inputs` 表（`name='createAgent'`）

### 5.2 世界保活与自动恢复

- 前端/客户端周期调用：[`heartbeatWorld`](../AstrTown/convex/world.ts:25)
  - 更新 `worldStatus.lastViewed`
  - 若 world inactive → patch 为 running → `startEngine`
- 定时任务：[`crons.ts`](../AstrTown/convex/crons.ts)
  - interval stopInactiveWorlds → [`stopInactiveWorlds`](../AstrTown/convex/world.ts:59)：patch worldStatus + `stopEngine`
  - interval restartDeadWorlds → [`restartDeadWorlds`](../AstrTown/convex/world.ts:74)：检测 engine.currentTime → `kickEngine`

### 5.3 消息发送数据流

- 前端写消息：[`writeMessage`](../AstrTown/convex/messages.ts:31)
  1. `ctx.db.insert('messages', ...)` 写入消息表
  2. `insertInput(..., 'finishSendingMessage', ...)` 写入输入表（驱动引擎侧的对话状态推进）

- 前端拉消息：[`listMessages`](../AstrTown/convex/messages.ts:6)
  - 从 `messages` 表按索引读取 → 对每条 message 查询 `playerDescriptions` 补齐 authorName

### 5.4 鉴权数据流（HTTP）

- 注册：HTTP `/api/auth/register` → [`postAuthRegister`](../AstrTown/convex/auth.ts:329)
  - runMutation → [`register`](../AstrTown/convex/auth.ts:214)
  - 写入 `users` + `sessions`
- 登录：HTTP `/api/auth/login` → [`postAuthLogin`](../AstrTown/convex/auth.ts:358)
  - runMutation → [`login`](../AstrTown/convex/auth.ts:257)
  - 校验 hash（PBKDF2）→ 写入 `sessions`
- 登出：HTTP `/api/auth/logout` → [`postAuthLogout`](../AstrTown/convex/auth.ts:384)
  - 从 header/cookie/body 提取 token → runMutation → [`logout`](../AstrTown/convex/auth.ts:296) 删除 session
- 我是谁：HTTP `/api/auth/me` → [`getAuthMe`](../AstrTown/convex/auth.ts:413)
  - runQuery → [`getMe`](../AstrTown/convex/auth.ts:316) → [`validateSessionWithDb`](../AstrTown/convex/auth.ts:149)

### 5.5 音乐生成数据流（Replicate）

- 生成入队：[`enqueueBackgroundMusicGeneration`](../AstrTown/convex/music.ts:46)
  - 若有 `REPLICATE_API_TOKEN` 且存在默认世界 → [`generateMusic`](../AstrTown/convex/music.ts:100) 发起 prediction（带 webhook）
- webhook 回调：HTTP `/replicate_webhook` → [`handleReplicateWebhook`](../AstrTown/convex/music.ts:61)
  - predictions.get → fetch 音频 → `ctx.storage.store(blob)` → `internal.music.insertMusic` 落库
- 播放读取：[`getBackgroundMusic`](../AstrTown/convex/music.ts:28)
  - 读取 `music` 表最新 background → `ctx.storage.getUrl(storageId)` 生成可访问 URL

### 5.6 NPC 历史对话数据流

- 分组摘要：[`getNpcConversationHistory`](../AstrTown/convex/npcHistory.ts:56)
  - worlds/archivedAgents 决定 NPC 集合 → participatedTogether(playerHistory) 拉取对话边 → archivedConversations 拉取对话摘要 → playerDescriptions 拉取名字 → 分桶排序
- 详情：[`getConversationDetail`](../AstrTown/convex/npcHistory.ts:171)
  - archivedConversations 校验权限（npc 是否参与）→ messages 拉取 → playerDescriptions 补齐作者名 → 按 creationTime 排序

## 6. 关键算法

### 6.1 Vacuum 分页清理（crons）

- 入口：[`vacuumOldEntries`](../AstrTown/convex/crons.ts:40)
  - 计算阈值 `before = Date.now() - VACUUM_MAX_AGE`
  - 对 `TablesToVacuum`：用索引 `by_creation_time` 先探测 `.first()` 是否存在旧数据，避免对空表调度
  - 对存在旧数据的表调度分页清理

- 分页删除：[`vacuumTable`](../AstrTown/convex/crons.ts:63)
  - 通过 `.paginate({ cursor, numItems: DELETE_BATCH_SIZE })` 批量取旧数据
  - delete 当前页所有 row
  - 若未结束则 `runAfter(0, internal.crons.vacuumTable, ...)` 继续下一页（递归调度）

### 6.2 NPC 历史对话分组与时间分桶

- 时间分桶函数：[`getTimeLabel`](../AstrTown/convex/npcHistory.ts:7)
  - 输入：timestamp/now/timezoneOffsetMinutes（与 `Date#getTimezoneOffset` 语义一致）
  - 通过对 `now` 做 offset 平移，计算 local “今天开始/昨天开始/本周开始”边界
  - 输出：`today/yesterday/thisWeek/earlier`

- 分组算法：[`getNpcConversationHistory`](../AstrTown/convex/npcHistory.ts:56)
  - `seenConversationIds` 去重 conversationId（避免重复读取同一对话）
  - `grouped: Map<otherPlayerId, ConversationGroup>` 将每个“对话对端玩家”作为组键
  - `playerNameCache` 缓存 playerDescriptions 查询结果，减少重复 IO
  - 最终对每个 group 的 `byTime[label]` 进行 `ended` 倒序排序

### 6.3 密码哈希与常量时间比较（auth）

- PBKDF2：[`hashPassword`](../AstrTown/convex/auth.ts:196)
  - keyMaterial = `${password}:${pepper}`（pepper 来自 `AUTH_SECRET`）
  - `PBKDF2(SHA-256, salt, iterations=120000)` deriveBits 输出 256 bits
- 常量时间比较：[`equalsConstantTime`](../AstrTown/convex/auth.ts:81)
  - 逐字符 XOR 累积 diff，避免早停导致的时序差异

### 6.4 session token 提取（auth）

- [`extractSessionToken`](../AstrTown/convex/auth.ts:121)
  - 优先从 `Authorization: Bearer <token>` 解析（[`parseBearerToken`](../AstrTown/convex/auth.ts:90)）
  - 否则从 cookie 名 `astrtown_session_token/sessionToken/session_token` 解析（[`parseCookieToken`](../AstrTown/convex/auth.ts:99)）

---

## 特别说明/限制

1. 本文“轻量文件范围”仅覆盖任务给定的 11 个文件；但其中 [`http.ts`](../AstrTown/convex/http.ts) 依赖的 `botApi.ts/npcService.ts` 属于根目录的“非轻量/更大文件”，为完整性已在关系与路由层面点名，但未展开分析。
2. 文件清单中 [`http.ts`](../AstrTown/convex/http.ts) 与 [`init.ts`](../AstrTown/convex/init.ts) 的字符数未出现在当前截断的 workspace 文件列表中，因此表格中标注为“未显示 chars”。行数已基于读取结果给出。
