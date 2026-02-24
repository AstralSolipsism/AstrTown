# 架构分析：convex/aiTown Agent 模块

> 范围说明：本文聚焦 [`AstrTown/convex/aiTown/`](AstrTown/convex/aiTown) 目录下与 Agent（NPC 智能体）直接相关的核心文件，并包含与 Agent 对话/外控网关事件分发紧耦合的实现。

## 1. 模块概述

### 1.1 模块职责

该模块负责 aiTown 世界中“智能体（Agent）”的**状态机与行为调度**，并将“对话（Conversation）”作为 Agent 行为的重要场景进行建模。

从代码结构上看，Agent 系统分为三层：

1. **运行时世界对象模型（in-memory）**：
   - Agent、Conversation、ConversationMembership 等类作为游戏世界（`Game.world`）的一部分存在于内存中。
   - 核心驱动函数是 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 与 [`Conversation.tick()`](AstrTown/convex/aiTown/conversation.ts:49)。

2. **输入（Input）处理层**：
   - 通过 `inputHandler` 注册输入事件，修改内存世界状态（例如创建 agent、对话邀请、发送消息、外控队列入队）。
   - 代表文件：[`agentInputs`](AstrTown/convex/aiTown/agentInputs.ts) 与 [`conversationInputs`](AstrTown/convex/aiTown/conversation.ts:270)。

3. **异步操作（Operation / Action）层**：
   - 当前仅保留 operation 收尾逻辑：随机 sleep 后回写 `finishRememberConversation` input，不直接执行记忆生成。
   - 代表文件：[`agentOperations`](AstrTown/convex/aiTown/agentOperations.ts) 与 [`runAgentOperation()`](AstrTown/convex/aiTown/agent.ts:895)。

> 记忆写入边界：由外部 plugin 通过 Bot API `/api/bot/memory/inject` 异步注入，链路为 [`postMemoryInject`](AstrTown/convex/botApi.ts:1165) → [`insertExternalMemory`](AstrTown/convex/agent/memory.ts:77)。

此外，为了支持“外部控制（external controlled agent）”与网关系统，模块还包含：

- Agent 外控事件队列与空闲策略（sleeping/leaving/prefetch）。见 [`ExternalQueueState`](AstrTown/convex/aiTown/agent.ts:50) 与 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 外控分支。
- 世界事件向网关投递（HTTP push），并按“外控 agent 范围”做定向投递。见 [`worldEventDispatcher`](AstrTown/convex/aiTown/worldEventDispatcher.ts)。

### 1.2 在整体项目中的位置与作用

- `AstrTown/convex/aiTown/*`：aiTown 的世界模拟核心（玩家、agent、对话、地图、移动、输入系统等）。
- Agent 模块是 **NPC 行为驱动与对话交互的核心**：
  - 当前实现：Agent **天生外控**（不存在 `isExternalControlled` / `externalControlSince` 字段，也不再有外控开关输入）。其行为完全由“外控事件队列”驱动（例如 `say`、`move_to`、`accept_invite`），并由引擎侧提供 idle/超时兜底来避免卡死。

### 1.3 Agent 系统核心概念

- **Agent**：绑定一个 `playerId` 的 NPC 控制器，负责“消费外控事件并驱动世界状态收敛（idle/离开/会话状态）”。见 [`class Agent`](AstrTown/convex/aiTown/agent.ts:101)。
- **Conversation**：两名玩家之间的对话状态机，包含 invited / walkingOver / participating。见 [`class Conversation`](AstrTown/convex/aiTown/conversation.ts:15)。
- **External Queue / External Event**：Agent 通过外控队列消费事件并执行；队列长期缺货会进入 sleeping/leaving 等兜底。见 [`ExternalQueueState`](AstrTown/convex/aiTown/agent.ts:50) 与 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444)。
- **外部记忆注入链路**：记忆生成已移出引擎内自主对话路径；当前由外部 plugin 调用 Bot API 注入，落到 [`insertExternalMemory`](AstrTown/convex/agent/memory.ts:77)，其数据构造与查询入口分别为 [`buildExternalMemoryData()`](AstrTown/convex/agent/memory.ts:23)、[`getRecentMemories`](AstrTown/convex/agent/memory.ts:99)。
- **World Event Dispatcher**：将对话开始/被邀请/消息/agent状态变化/队列补充请求等事件推送到网关，并根据事件类型定向到特定外控 agent。见 [`scheduleEventPush()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:356)。

---

## 2. 文件清单

> 行数来自文件读取结果；字符数通过本地 PowerShell `Get-Item ... .Length` 获取。

| 文件 | 功能概述 | 行数 | 字符数 |
|---|---|---:|---:|
| [`AstrTown/convex/aiTown/agent.ts`](AstrTown/convex/aiTown/agent.ts) | Agent 运行时模型、外控队列/空闲策略、tick 主循环（仅外控队列消费 + idle/超时兜底 + 会话状态收敛/离开）、operation 调度入口 | 975 | 35480 |
| [`AstrTown/convex/aiTown/agentDescription.ts`](AstrTown/convex/aiTown/agentDescription.ts) | Agent 的“身份/计划”描述对象与序列化定义 | 27 | 770 |
| [`AstrTown/convex/aiTown/agentInputs.ts`](AstrTown/convex/aiTown/agentInputs.ts) | Agent 相关输入处理：外控事件入队/清队列、operation 完成回调（remember/doSomething）、外控发送消息、创建 Agent（不再有外控开关） | 298 | 10136 |
| [`AstrTown/convex/aiTown/agentOperations.ts`](AstrTown/convex/aiTown/agentOperations.ts) | Agent 异步 operations：仅保留 `agentRememberConversation`（随机 sleep 后回写 `finishRememberConversation`） | 171 | 5465 |
| [`AstrTown/convex/aiTown/conversation.ts`](AstrTown/convex/aiTown/conversation.ts) | Conversation 运行时模型与输入处理：对话创建、邀请/拒绝/离开、打字状态、消息完成与外控事件推送挂钩 | 432 | 15194 |
| [`AstrTown/convex/aiTown/conversationMembership.ts`](AstrTown/convex/aiTown/conversationMembership.ts) | 对话成员关系与状态（invited/walkingOver/participating）序列化与类封装 | 38 | 1126 |
| [`AstrTown/convex/aiTown/worldEventDispatcher.ts`](AstrTown/convex/aiTown/worldEventDispatcher.ts) | 网关事件投递：事件 TTL、幂等键、定向目标选择、调度 push 到网关 | 599 | 18157 |

---

## 3. 文件详细分析

### 3.1 [`agent.ts`](AstrTown/convex/aiTown/agent.ts)

#### 3.1.1 文件基本信息

- 角色：Agent 核心运行时对象与调度入口。
- 关键内容：
  - 外控事件结构与状态：[`ExternalEventItem`](AstrTown/convex/aiTown/agent.ts:31)、[`ExternalQueueState`](AstrTown/convex/aiTown/agent.ts:50)
  - Agent 运行时对象：[`class Agent`](AstrTown/convex/aiTown/agent.ts:101)
  - Agent 主循环：[`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444)
  - 异步 operation 调度：[`Agent.startOperation()`](AstrTown/convex/aiTown/agent.ts:798)
  - operation 路由到 internal actions：[`runAgentOperation()`](AstrTown/convex/aiTown/agent.ts:895)
  - Convex mutation/query：[`findConversationCandidate`](AstrTown/convex/aiTown/agent.ts:943)（旧自主对话候选逻辑，当前 tick 已不再使用）；消息发送由输入链路 [`agentInputs.externalBotSendMessage`](AstrTown/convex/aiTown/agentInputs.ts:224) 驱动。

#### 3.1.2 导入的模块

- Convex 与类型：
  - `convex/values`：`v` 与 `ObjectType`
  - `convex/server`：`FunctionArgs`
  - `../_generated/server`：`MutationCtx`、`internalMutation`、`internalQuery`
  - `../_generated/api`：`internal`
- aiTown 内部依赖：
  - ids：[`parseGameId`](AstrTown/convex/aiTown/agent.ts:2) 与 `agentId/conversationId/playerId`
  - player/game：[`Player`](AstrTown/convex/aiTown/agent.ts:4)、[`Game`](AstrTown/convex/aiTown/agent.ts:5)
  - movement：[`movePlayer`](AstrTown/convex/aiTown/agent.ts:28)
  - insertInput：[`insertInput`](AstrTown/convex/aiTown/agent.ts:29)
- util/constants：`distance` 与大量超时/阈值常量（外控队列与对话策略均依赖）。

#### 3.1.3 导出的内容

- 类型/工具：
  - [`ExternalEventItem`](AstrTown/convex/aiTown/agent.ts:31)
  - [`ExternalQueueState`](AstrTown/convex/aiTown/agent.ts:50)
  - [`createDefaultExternalQueueState()`](AstrTown/convex/aiTown/agent.ts:66)
- 核心类：
  - [`Agent`](AstrTown/convex/aiTown/agent.ts:101)
- Convex validators/序列化：
  - [`externalEventItemValidator`](AstrTown/convex/aiTown/agent.ts:836)
  - [`externalQueueStateValidator`](AstrTown/convex/aiTown/agent.ts:856)
  - [`serializedAgent`](AstrTown/convex/aiTown/agent.ts:872)
  - `SerializedAgent` 类型
- Convex functions：
  - [`runAgentOperation()`](AstrTown/convex/aiTown/agent.ts:895)
  - [`findConversationCandidate`](AstrTown/convex/aiTown/agent.ts:943)（旧自主对话候选逻辑，当前 tick 已不再使用）
#### 3.1.4 定义的关键函数与变量（按职责）

- 外控队列状态：
  - [`createDefaultExternalQueueState()`](AstrTown/convex/aiTown/agent.ts:66)：创建默认结构。
  - `normalizeExternalQueueState()`（文件内私有函数，见 [`normalizeExternalQueueState()`](AstrTown/convex/aiTown/agent.ts:80)）：将旧/缺省状态补齐。
- Agent（外控相关私有方法）：
  - [`Agent.dequeueExternalFromQueue()`](AstrTown/convex/aiTown/agent.ts:147)：按 allowedKinds（可选）从队列取事件，并丢弃过期事件。
  - [`Agent.onExternalEventDequeued()`](AstrTown/convex/aiTown/agent.ts:170)：消费事件后重置 prefetch/idle 状态。
  - [`Agent.normalizeActivityFromEvent()`](AstrTown/convex/aiTown/agent.ts:180)：将外部 payload 归一为 `Activity`。
  - [`Agent.nearestMapEdgePoint()`](AstrTown/convex/aiTown/agent.ts:209)、[`Agent.isPlayerAtMapEdge()`](AstrTown/convex/aiTown/agent.ts:234)：用于 leaving 模式。
  - [`Agent.enterSleepingMode()`](AstrTown/convex/aiTown/agent.ts:240)：进入睡眠并设置玩家 activity。
  - [`Agent.enterLeavingMode()`](AstrTown/convex/aiTown/agent.ts:250)、[`Agent.continueLeavingMode()`](AstrTown/convex/aiTown/agent.ts:266)：当外控队列持续缺货，驱动 NPC 走向地图边缘以“离开”。
  - [`Agent.executeExternalEvent()`](AstrTown/convex/aiTown/agent.ts:291)：执行外控事件（move_to/say/emote/start_conversation/accept_invite/...）。
- Agent 主循环：
  - [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444)：仅保留“外控队列消费 + idle/超时兜底 + 会话状态收敛/离开”等逻辑；已不再包含内置 LLM 自主意图、找聊天对象、生成消息等内容。
- Operation 调度：
  - [`Agent.startOperation()`](AstrTown/convex/aiTown/agent.ts:798)：生成 operationId，调用 `game.scheduleOperation`，并写入 `inProgressOperation`。
  - [`runAgentOperation()`](AstrTown/convex/aiTown/agent.ts:895)：把字符串 operation 映射到 `internal.aiTown.agentOperations.*` 并 `ctx.scheduler.runAfter(0, ...)`。
- 消息与候选对话人：
  - 自主消息生成链路已移除（`agentGenerateMessage` / `agentFinishSendingMessage` 不再存在）。
  - 外部系统如需发消息，走 [`agentInputs.externalBotSendMessage`](AstrTown/convex/aiTown/agentInputs.ts:224) → [`conversationInputs.finishSendingMessage`](AstrTown/convex/aiTown/conversation.ts:323)。
  - `findConversationCandidate` 属于旧的“自主找聊天对象”路径；当前 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 已不再使用该决策逻辑。

#### 3.1.5 文件内部关系（关键调用链）

- Agent 行为概览（当前仅外控驱动）：
  - [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 每 tick 优先处理：
    - `toRemember`：若存在则触发 operation 收尾链路（随机 sleep + `finishRememberConversation` 回写）。
    - 会话状态收敛：根据 `ConversationMembership.status.kind` 处理 `invited` / `walkingOver` / `participating` 下的“自动走近/邀请超时/闲置离开”等兜底。
    - 外控事件消费：优先队列 → 普通队列 → 队列空则进入 prefetch/sleeping/leaving 逻辑。

> 说明：内置 LLM 自主意图（`agentDoSomething`、`agentGenerateMessage`、找聊天对象等）已彻底移除；外部系统通过入队事件驱动 `say/move_to/start_conversation/...`。

#### 3.1.6 文件间关系

- 与输入层：[`agentInputs.enqueueExternalEvents`](AstrTown/convex/aiTown/agentInputs.ts:46) 写入 `externalEventQueue/externalPriorityQueue`，被 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 消费。
- 与 operations：[`runAgentOperation()`](AstrTown/convex/aiTown/agent.ts:895) 调度 [`agentOperations`](AstrTown/convex/aiTown/agentOperations.ts) 的 internal actions。
- 与对话：[`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 读取 `game.world.playerConversation(player)` 与 `ConversationMembership.status` 进行决策；对话结束时由 [`Conversation.stop()`](AstrTown/convex/aiTown/conversation.ts:214) 设置 `agent.toRemember`。

---

### 3.2 [`agentDescription.ts`](AstrTown/convex/aiTown/agentDescription.ts)

#### 3.2.1 文件基本信息

- 角色：Agent 描述（identity/plan）数据结构与序列化。
- 核心类：[`AgentDescription`](AstrTown/convex/aiTown/agentDescription.ts:4)

#### 3.2.2 导入的模块

- `convex/values`：`ObjectType`、`v`
- ids：`GameId`、`agentId`、[`parseGameId`](AstrTown/convex/aiTown/agentDescription.ts:2)

#### 3.2.3 导出的内容

- [`AgentDescription`](AstrTown/convex/aiTown/agentDescription.ts:4)
- [`serializedAgentDescription`](AstrTown/convex/aiTown/agentDescription.ts:22)
- `SerializedAgentDescription`

#### 3.2.4 定义的函数/变量

- [`AgentDescription.serialize()`](AstrTown/convex/aiTown/agentDescription.ts:16)：输出序列化结构。

#### 3.2.5 文件间关系

- 在 [`createAgent`](AstrTown/convex/aiTown/agentInputs.ts:259) 中创建并写入 `game.agentDescriptions`。

---

### 3.3 [`agentInputs.ts`](AstrTown/convex/aiTown/agentInputs.ts)

#### 3.3.1 文件基本信息

- 角色：Agent 相关 input handlers 集合（由主循环/外部系统调用）。
- 核心导出：[`agentInputs`](AstrTown/convex/aiTown/agentInputs.ts:17)

#### 3.3.2 导入的模块

- Convex：`v`
- ids：`agentId`、`conversationId`、[`parseGameId`](AstrTown/convex/aiTown/agentInputs.ts:2)
- world model：[`Player`](AstrTown/convex/aiTown/agentInputs.ts:3)、[`Conversation`](AstrTown/convex/aiTown/agentInputs.ts:4)
- movement：[`movePlayer`](AstrTown/convex/aiTown/agentInputs.ts:5)
- input：[`inputHandler`](AstrTown/convex/aiTown/agentInputs.ts:6)
- data：`Descriptions`（角色描述数据）
- agent：[`Agent`](AstrTown/convex/aiTown/agentInputs.ts:10)、[`createDefaultExternalQueueState()`](AstrTown/convex/aiTown/agent.ts:66)、[`externalEventItemValidator`](AstrTown/convex/aiTown/agent.ts:836)
- constants：`EXTERNAL_QUEUE_MAX_SIZE`

#### 3.3.3 导出的内容

- `agentInputs` 对象，包含以下输入处理器：
  - [`enqueueExternalEvents`](AstrTown/convex/aiTown/agentInputs.ts:46)
  - [`clearExternalQueue`](AstrTown/convex/aiTown/agentInputs.ts:91)
  - [`finishRememberConversation`](AstrTown/convex/aiTown/agentInputs.ts:107)
  - [`finishDoSomething`](AstrTown/convex/aiTown/agentInputs.ts:130)
  - [`externalBotSendMessage`](AstrTown/convex/aiTown/agentInputs.ts:224)
  - [`createAgent`](AstrTown/convex/aiTown/agentInputs.ts:259)

> 说明：不再存在外控开关输入（`setExternalControl`），也不再有“自主生成消息完成回调”（`agentFinishSendingMessage`）。

#### 3.3.4 关键逻辑拆解

- 外控（固定外控）：
  - 当前 Agent 不存在外控开关字段/输入：`isExternalControlled` / `externalControlSince` 与 [`agentInputs.setExternalControl`](AstrTown/convex/aiTown/agentInputs.ts:18) 已移除。
  - 外部系统通过 [`agentInputs.enqueueExternalEvents`](AstrTown/convex/aiTown/agentInputs.ts:46) 入队驱动行为；队列缺货时由 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 的 idle/prefetch/sleeping/leaving 逻辑兜底。

- 外控事件入队：[`agentInputs.enqueueExternalEvents`](AstrTown/convex/aiTown/agentInputs.ts:46)
  - 根据 `event.priority < 2` 分流到 `externalPriorityQueue` 或 `externalEventQueue`。
  - 进行队列长度上限裁剪（`EXTERNAL_QUEUE_MAX_SIZE`），优先丢弃普通队列，溢出时再裁剪优先队列。
  - 重置 `externalQueueState` 的 idle/prefetch runtime 字段以“唤醒”。

- 清空外控队列：[`agentInputs.clearExternalQueue`](AstrTown/convex/aiTown/agentInputs.ts:91)
  - 清空队列并重置 runtime state（[`resetExternalQueueRuntimeState`](AstrTown/convex/aiTown/agentInputs.ts:13) 调用 [`createDefaultExternalQueueState()`](AstrTown/convex/aiTown/agent.ts:66)）。

- Operation 完成回调：
  - 记忆完成：[`finishRememberConversation`](AstrTown/convex/aiTown/agentInputs.ts:107) 校验 `operationId` 后清理 `inProgressOperation` 与 `toRemember`。
  - doSomething 完成：[`finishDoSomething`](AstrTown/convex/aiTown/agentInputs.ts:130) 处理目的地移动、发起对话、设置 activity。
    - 现状：`finishDoSomething` 不再区分外控开关分支，仅保留底层移动/活动状态更新等收敛逻辑。

- 消息发送完成（自主 Agent 生成消息路径）：`agentFinishSendingMessage` handler 已删除。

- 外控直接发消息：[`externalBotSendMessage`](AstrTown/convex/aiTown/agentInputs.ts:224)
  - 不依赖 `operationId`，直接调用 [`conversationInputs.finishSendingMessage.handler`](AstrTown/convex/aiTown/conversation.ts:323) 并可选择 leave。

- 创建 Agent：[`createAgent`](AstrTown/convex/aiTown/agentInputs.ts:259)
  - 从 `Descriptions` 选取描述。
  - 调用 `Player.join(...)` 创建对应玩家。
  - `game.allocId('agents')` 分配 agentId，并在 `game.world.agents` 中写入 [`new Agent({...})`](AstrTown/convex/aiTown/agentInputs.ts:275)。
  - 同时在 `game.agentDescriptions` 写入 [`new AgentDescription({...})`](AstrTown/convex/aiTown/agentInputs.ts:289)。

#### 3.3.5 文件间关系

- 与 [`agent.ts`](AstrTown/convex/aiTown/agent.ts)：
  - 使用 `externalEventItemValidator` 约束外控事件结构，保持入队数据与 [`Agent.executeExternalEvent()`](AstrTown/convex/aiTown/agent.ts:291) 兼容。
  - 通过修改 `Agent` 实例字段，间接影响 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 的分支逻辑。
- 与 [`conversation.ts`](AstrTown/convex/aiTown/conversation.ts)：
  - `finishSendingMessage` 与 `leave` 都直接调用 conversation 的输入处理/方法。

---

### 3.4 [`agentOperations.ts`](AstrTown/convex/aiTown/agentOperations.ts)

#### 3.4.1 文件基本信息

- 角色：Agent 的异步 internal actions（Convex `internalAction`）。
- 核心导出：
  - [`agentRememberConversation`](AstrTown/convex/aiTown/agentOperations.ts:7)

> 说明：`agentGenerateMessage` / `agentDoSomething` 已删除；`agentRememberConversation` 保留，仅用于 operation 收尾（随机 sleep + 回写完成 input）。

#### 3.4.2 导入的模块

- Convex：`v`、[`internalAction`](AstrTown/convex/aiTown/agentOperations.ts:2)
- ids：`agentId/conversationId/playerId`（见 [`agentOperations.ts`](AstrTown/convex/aiTown/agentOperations.ts:3)）
- API：`api`（[`agentOperations.ts`](AstrTown/convex/aiTown/agentOperations.ts:4)）
- util：[`sleep`](AstrTown/convex/aiTown/agentOperations.ts:5)

> 说明：当前文件不再导入 `../agent/memory`；`convex/agent` 目录当前仅包含 [`memory.ts`](AstrTown/convex/agent/memory.ts)、[`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts)、[`schema.ts`](AstrTown/convex/agent/schema.ts)，旧的对话生成模块已移除。

#### 3.4.3 导出的内容与调用路径

- operation 收尾：[`agentRememberConversation`](AstrTown/convex/aiTown/agentOperations.ts:7)
  - 随机 sleep。
  - 通过 `api.aiTown.main.sendInput` 发送 `finishRememberConversation`，由 [`agentInputs.finishRememberConversation`](AstrTown/convex/aiTown/agentInputs.ts:107) 收尾。

- 生成消息 / doSomething：`agentGenerateMessage` / `agentDoSomething` 已删除，当前 Agent 不再内置 LLM 自主生成消息或自发起“找人聊天/随机活动”等意图。

#### 3.4.4 文件间关系

- 由 [`Agent.startOperation()`](AstrTown/convex/aiTown/agent.ts:798) 发起，并经由 [`runAgentOperation()`](AstrTown/convex/aiTown/agent.ts:895) 映射/调度。
- 完成回调统一通过 `api.aiTown.main.sendInput` 回到输入层（[`agentInputs`](AstrTown/convex/aiTown/agentInputs.ts)）。

---

### 3.5 [`conversationMembership.ts`](AstrTown/convex/aiTown/conversationMembership.ts)

#### 3.5.1 文件基本信息

- 角色：Conversation 参与者关系的最小建模单元。
- 序列化定义：[`serializedConversationMembership`](AstrTown/convex/aiTown/conversationMembership.ts:4)
- 运行时类：[`ConversationMembership`](AstrTown/convex/aiTown/conversationMembership.ts:15)

#### 3.5.2 导入/导出

- 导入：`convex/values`（`ObjectType`、`v`）、ids（`GameId`、[`parseGameId`](AstrTown/convex/aiTown/conversationMembership.ts:2)、`playerId`）
- 导出：
  - `serializedConversationMembership` / `SerializedConversationMembership`
  - [`ConversationMembership`](AstrTown/convex/aiTown/conversationMembership.ts:15)

#### 3.5.3 状态枚举

`status.kind` 只能为：

- `invited`
- `walkingOver`
- `participating`（带 `started` 时间戳）

此状态被 [`Conversation.tick()`](AstrTown/convex/aiTown/conversation.ts:49) 与 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 联合使用，形成对话的同步状态机。

---

### 3.6 [`conversation.ts`](AstrTown/convex/aiTown/conversation.ts)

#### 3.6.1 文件基本信息

- 角色：对话对象模型与输入 handlers。
- 核心类：[`Conversation`](AstrTown/convex/aiTown/conversation.ts:15)
- 核心输入：[`conversationInputs`](AstrTown/convex/aiTown/conversation.ts:270)

#### 3.6.2 导入的模块

- Convex：`ObjectType`、`v`
- ids：`GameId`、[`parseGameId`](AstrTown/convex/aiTown/conversation.ts:2)、`conversationId`、`playerId`
- world model：[`Player`](AstrTown/convex/aiTown/conversation.ts:4)、[`Game`](AstrTown/convex/aiTown/conversation.ts:10)
- movement：[`stopPlayer`](AstrTown/convex/aiTown/conversation.ts:11)、`blocked`、[`movePlayer`](AstrTown/convex/aiTown/conversation.ts:11)
- membership：[`ConversationMembership`](AstrTown/convex/aiTown/conversation.ts:12)
- util：`distance/normalize/vector`、`parseMap/serializeMap`

#### 3.6.3 导出的内容

- [`Conversation`](AstrTown/convex/aiTown/conversation.ts:15)
- `serializedConversation` / `SerializedConversation`
- [`conversationInputs`](AstrTown/convex/aiTown/conversation.ts:270)

#### 3.6.4 关键函数与逻辑

- 对话 tick：[`Conversation.tick()`](AstrTown/convex/aiTown/conversation.ts:49)
  - 清理 typing 超时（`TYPING_TIMEOUT`）。
  - 仅支持 2 人对话（否则 warn 并返回）。
  - 当双方都为 `walkingOver` 且距离小于 `CONVERSATION_DISTANCE`：
    - stop 双方移动
    - 双方状态切换到 `participating`
    - 尝试将两人移动到相邻格子（基于 `blocked()` 过滤）
    - 外控挂钩：对话“真正开始”时，遍历参与者，找到对应 agent 后向 `game.pendingOperations` 推入 `conversationStarted`（见 [`Conversation.tick()`](AstrTown/convex/aiTown/conversation.ts:101) 的注释与实现）。
  - 当双方 `participating`：根据两者位置向量设置 facing（非寻路状态下）。

- 创建对话：[`Conversation.start()`](AstrTown/convex/aiTown/conversation.ts:131)
  - 校验双方都不在其他对话中。
  - 新建 conversation，参与者状态为：邀请者 walkingOver，被邀请者 invited。
  - 外控挂钩：邀请事件会推入 pendingOperation `conversation.invited`（用于网关/插件侧接收）；当前 Agent 天生外控，不再依赖 `isExternalControlled` 字段判断。见 [`Conversation.start()`](AstrTown/convex/aiTown/conversation.ts:160)。

- 停止/离开：
  - [`Conversation.stop()`](AstrTown/convex/aiTown/conversation.ts:214)：
    - 清理 typing
    - 对所有参与者的 agent：设置 `agent.lastConversation = now` 与 `agent.toRemember = this.id`
    - 从 `game.world.conversations` 删除对话
  - [`Conversation.leave()`](AstrTown/convex/aiTown/conversation.ts:226)：直接调用 `stop`。

- 输入 handlers（`conversationInputs`）：
  - [`startConversation`](AstrTown/convex/aiTown/conversation.ts:271)：解析 playerId/invitee 并调用 `Conversation.start`。
  - [`startTyping`](AstrTown/convex/aiTown/conversation.ts:296)：设置 `conversation.isTyping`。
  - [`finishSendingMessage`](AstrTown/convex/aiTown/conversation.ts:323)：
    - 清理 typing
    - 更新 `lastMessage` 与 `numMessages`
    - 外控挂钩：若 `text` 为字符串，则对除发言者外的参与者，找到其外控 agent 后推入 pendingOperation `conversation.message`。见 [`finishSendingMessage`](AstrTown/convex/aiTown/conversation.ts:323) 内的 `game.pendingOperations.push`。
  - [`acceptInvite`](AstrTown/convex/aiTown/conversation.ts:371) / [`rejectInvite`](AstrTown/convex/aiTown/conversation.ts:392) / [`leaveConversation`](AstrTown/convex/aiTown/conversation.ts:412)：解析并调用对应方法。

#### 3.6.5 文件间关系

- 与 [`agent.ts`](AstrTown/convex/aiTown/agent.ts)：
  - Agent tick 读取 `ConversationMembership.status` 决定是否生成消息/是否继续走近。
  - Conversation.stop 设置 `agent.toRemember`，触发 Agent 后续 remember operation。
- 与 [`worldEventDispatcher.ts`](AstrTown/convex/aiTown/worldEventDispatcher.ts)：
  - 本文件并不直接调用 dispatcher，而是向 `game.pendingOperations` 写入 `conversationStarted` / `conversation.invited` / `conversation.message` 等操作名称；后续由更上层的调度器统一转发（该上层不在本文文件列表内）。

---

### 3.7 [`worldEventDispatcher.ts`](AstrTown/convex/aiTown/worldEventDispatcher.ts)

#### 3.7.1 文件基本信息

- 角色：将世界内发生的事件推送给外部网关（HTTP POST），并处理：
  - 事件 TTL 与 expiresAt
  - 幂等键 idempotencyKey
  - 定向投递目标 agent 列表
  - 通过 Convex scheduler 触发 push

#### 3.7.2 导入的模块

- Convex：`v`、`internalAction`、`internalQuery`
- 数据模型：`Id`
- API：`internal`、`api`
- 常量：`EXTERNAL_QUEUE_PREFETCH_TIMEOUT`

#### 3.7.3 导出的内容

- 类型：
  - [`GatewayEventType`](AstrTown/convex/aiTown/worldEventDispatcher.ts:7)
  - `GatewayEventPriority`
- internalAction：
  - [`pushEventToGateway`](AstrTown/convex/aiTown/worldEventDispatcher.ts:47)
  - [`scheduleConversationStarted`](AstrTown/convex/aiTown/worldEventDispatcher.ts:439)
  - [`scheduleConversationInvited`](AstrTown/convex/aiTown/worldEventDispatcher.ts:464)
  - [`scheduleConversationMessage`](AstrTown/convex/aiTown/worldEventDispatcher.ts:491)
  - [`scheduleAgentStateChanged`](AstrTown/convex/aiTown/worldEventDispatcher.ts:518)
  - [`scheduleActionFinished`](AstrTown/convex/aiTown/worldEventDispatcher.ts:545)
  - [`scheduleAgentQueueRefillRequested`](AstrTown/convex/aiTown/worldEventDispatcher.ts:572)
- internalQuery：
  - [`listExternalControlledAgentIds`](AstrTown/convex/aiTown/worldEventDispatcher.ts:129)
  - [`listExternalControlledAgentIdsByConversation`](AstrTown/convex/aiTown/worldEventDispatcher.ts:142)
  - [`listExternalControlledAgentIdsByInvitedPlayer`](AstrTown/convex/aiTown/worldEventDispatcher.ts:179)
- 构建事件 payload 的纯函数：
  - [`buildConversationStartedEvent`](AstrTown/convex/aiTown/worldEventDispatcher.ts:237)
  - [`buildConversationInvitedEvent`](AstrTown/convex/aiTown/worldEventDispatcher.ts:254)
  - [`buildConversationMessageEvent`](AstrTown/convex/aiTown/worldEventDispatcher.ts:273)
  - [`buildAgentStateChangedEvent`](AstrTown/convex/aiTown/worldEventDispatcher.ts:294)
  - [`buildActionFinishedEvent`](AstrTown/convex/aiTown/worldEventDispatcher.ts:313)
  - [`buildAgentQueueRefillRequestedEvent`](AstrTown/convex/aiTown/worldEventDispatcher.ts:332)
- 核心调度：[`scheduleEventPush()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:356)

#### 3.7.4 内部关系与关键点

- 环境变量：
  - [`requireEnv()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:17) 读取 `GATEWAY_URL` 与 `GATEWAY_SECRET`。

- 事件 TTL：
  - `EVENT_TTL_MS`（文件内常量）为各事件类型定义 TTL。
  - [`computeExpiresAt()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:32) 计算 `expiresAt`。

- 幂等：
  - [`buildIdempotencyKey()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:37) 由 eventType/worldId/eventAgentId/targetAgentId/eventTs 组成。
  - [`pushEventToGateway`](AstrTown/convex/aiTown/worldEventDispatcher.ts:47) 通过 header `x-idempotency-key` 与 body 字段传递。

- 定向投递策略：[`scheduleEventPush()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:356)
  - `agent.queue_refill_requested`：仅投递给 eventAgentId 自己。
  - `conversation.invited`：只投递给“被邀请方”的外控 agent（通过 [`listExternalControlledAgentIdsByInvitedPlayer`](AstrTown/convex/aiTown/worldEventDispatcher.ts:179)）。
  - `conversation.*`：投递给该 conversation 中的外控 agent（[`listExternalControlledAgentIdsByConversation`](AstrTown/convex/aiTown/worldEventDispatcher.ts:142)）。
  - 其他事件：投递给世界内所有外控 agent（[`listExternalControlledAgentIds`](AstrTown/convex/aiTown/worldEventDispatcher.ts:129)）。

- HTTP Push：[`pushEventToGateway`](AstrTown/convex/aiTown/worldEventDispatcher.ts:47)
  - `POST {GATEWAY_URL}/gateway/event`
  - header：`x-gateway-secret`、`x-idempotency-key`
  - body 同时写入兼容字段：`agentId/eventData/eventTs/idempotencyKey`。

---

## 4. 模块关系图（文字版依赖/调用关系）

- [`agentInputs`](AstrTown/convex/aiTown/agentInputs.ts)
  - 写：`externalEventQueue/externalPriorityQueue/externalQueueState`（不再有 `isExternalControlled` / `externalControlSince` 外控开关字段）
  - 调：[`Conversation.start()`](AstrTown/convex/aiTown/conversation.ts:131)、[`conversationInputs.finishSendingMessage`](AstrTown/convex/aiTown/conversation.ts:323)、[`Conversation.leave()`](AstrTown/convex/aiTown/conversation.ts:226)、[`movePlayer()`](AstrTown/convex/aiTown/agentInputs.ts:172)

- [`Agent`](AstrTown/convex/aiTown/agent.ts)
  - 调：`game.handleInput(...)`（外控事件执行时触发 `startConversation/acceptInvite/rejectInvite/leaveConversation/externalBotSendMessage`）
  - 调：[`Agent.startOperation()`](AstrTown/convex/aiTown/agent.ts:798) → `game.scheduleOperation(...)` → [`runAgentOperation()`](AstrTown/convex/aiTown/agent.ts:895) → [`agentOperations`](AstrTown/convex/aiTown/agentOperations.ts)
  - 调：[`movePlayer()`](AstrTown/convex/aiTown/agent.ts:28)

- [`agentOperations`](AstrTown/convex/aiTown/agentOperations.ts)
  - 仅保留 [`agentRememberConversation`](AstrTown/convex/aiTown/agentOperations.ts:7)
  - 逻辑：随机 sleep 后回写 `api.aiTown.main.sendInput('finishRememberConversation')` → [`agentInputs.finishRememberConversation`](AstrTown/convex/aiTown/agentInputs.ts:107)

- [`Conversation`](AstrTown/convex/aiTown/conversation.ts)
  - tick 改变 `ConversationMembership.status`
  - stop 时写 `agent.toRemember`，被 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 消费
  - 在 `Conversation.tick` 与 `finishSendingMessage` 中向 `game.pendingOperations` 推入外控相关事件名（`conversationStarted` / `conversation.invited` / `conversation.message`）

- [`worldEventDispatcher`](AstrTown/convex/aiTown/worldEventDispatcher.ts)
  - 提供一组 `schedule*` internalActions：将上层汇总的 pendingOperations（不在本文范围内）转换为网关事件并 HTTP 推送。

---

## 5. 数据流分析

### 5.1 当前 Agent 行为数据流（固定外控）

1. 世界循环调用 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444)
2. 兜底与收敛（tick 内同步推进）：
   - `toRemember` 存在 → 触发 operation 收尾链路（异步回写 `finishRememberConversation`）
   - 对话 invited / walkingOver / participating → 自动走近 + invite_timeout / idle_timeout 离开兜底（避免外部长期不下发指令导致卡死）
3. 外部系统通过 input 驱动：
   - 推送外控事件：[`agentInputs.enqueueExternalEvents`](AstrTown/convex/aiTown/agentInputs.ts:46)
4. Agent 消费与执行外控事件：
   - invited 状态：仅消费 `accept_invite/reject_invite`（优先队列）
   - 其他：优先队列 → 普通队列
   - 执行：[`Agent.executeExternalEvent()`](AstrTown/convex/aiTown/agent.ts:291)
     - `move_to`/`emote`：直接修改 player 状态
     - `start_conversation`/`accept_invite`/`reject_invite`/`leave_conversation`：调用 `game.handleInput` 进入对话输入处理
     - `say`：调用 `game.handleInput('externalBotSendMessage')` → [`agentInputs.externalBotSendMessage`](AstrTown/convex/aiTown/agentInputs.ts:224) → [`conversationInputs.finishSendingMessage`](AstrTown/convex/aiTown/conversation.ts:323)
5. 队列耗尽：
   - 进入 prefetch waiting（由外部补队列）
   - 多次 miss 后：[`Agent.enterSleepingMode()`](AstrTown/convex/aiTown/agent.ts:240) 或 [`Agent.enterLeavingMode()`](AstrTown/convex/aiTown/agent.ts:250)

> 说明：原“自主 Agent（非外控）”的数据流（`agentDoSomething` / `agentGenerateMessage` / `agentFinishSendingMessage`）已废弃并从代码中删除。

### 5.3 Agent 行为决策流程（状态机摘要）

- 核心状态由以下维度共同决定：
  - 外控队列状态：`externalPriorityQueue` / `externalEventQueue` / `externalQueueState`
  - `agent.inProgressOperation`（及超时）
  - `agent.toRemember`
  - `conversation` 是否存在与 `ConversationMembership.status.kind`
  - `player.pathfinding`、`player.activity.until`
  - 超时/阈值常量（例如邀请超时、尴尬沉默超时、prefetch/idle 阈值等）

> 说明：不再存在 `agent.isExternalControlled` / `externalControlSince` 外控开关字段。

- 其中对话相关的关键分支都在 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 内：
  - `invited`：接受/拒绝
  - `walkingOver`：寻路靠近
  - `participating`：等待外部 `say`，并由超时兜底触发离开

---

## 6. 关键算法

### 6.1 外控队列消费与过期丢弃（含过期反馈）

- [`Agent.dequeueExternalFromQueue()`](AstrTown/convex/aiTown/agent.ts:147)
  - 支持按 allowedKinds 定向取事件（invited 状态只允许 accept/reject）。
  - 若事件存在 `expiresAt` 且已过期，不再“静默丢弃”：
    - 函数返回值由 `ExternalEventItem | undefined` 调整为 `{ item?: ExternalEventItem; expiredDrops: ExternalEventItem[] }`。
    - while 循环中遇到过期事件会记录日志，并将该事件 push 进 `expiredDrops`，继续寻找下一条可用事件。

- 过期事件向外反馈（复用 `action.finished`）
  - 在 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:444) 的外控分支中，所有调用 `dequeueExternalFromQueue` 的地方都会解构出 `expiredDrops`。
  - 对每个 `drop`，会向 `game.pendingOperations` 推入一条 `action.finished`：
    - `success: false`
    - `result: { reason: 'expired', eventId: <drop.eventId> }`
  - 该设计的目的：让上游网关/插件端能把“指令过期被丢弃”反馈给外部状态机，而不是无声失败。

### 6.1.1 外控对话的时间驱动兜底（invited / participating）

外控 Agent 在对话场景下原则上不主动触发 LLM 生成消息，因而需要引擎侧提供时间驱动的兜底，以避免长期死等外部指令。

- invited 状态邀请超时兜底
  - 在外控分支的 invited 处理中，如果 `membership.status.invited + INVITE_TIMEOUT < now`：
    - 直接 `conversation.rejectInvite(...)` 自动拒绝邀请
    - 并向 `game.pendingOperations` 推入 `conversation.timeout`（reason=`invite_timeout`）

- participating 状态闲置超时兜底
  - 在外控分支的 participating 处理中：
    - 计算 `lastActive = conversation.lastMessage?.timestamp ?? conversation.created`
    - 若 `now > lastActive + AWKWARD_CONVERSATION_TIMEOUT`：`conversation.leave(...)` 并推入 `conversation.timeout`（reason=`idle_timeout`）
    - 否则继续 return，等待外部指令

上述 `conversation.timeout` 会在调度层被转换为网关事件并定向投递给该对话内所有外控 agent（详见 dispatcher 文档与 gateway 文档）。

### 6.2 外控队列缺货下的 idle 策略（prefetch/sleeping/leaving）

- 逻辑入口在 [`Agent.tick()`](AstrTown/convex/aiTown/agent.ts:579)（外控分支且队列为空时）：
  - 若 `idle.mode === 'leaving'`：[`Agent.continueLeavingMode()`](AstrTown/convex/aiTown/agent.ts:266)
  - 若 `prefetch.waiting` 且等待超时：
    - 增加 `prefetch.retries` 与 `idle.consecutivePrefetchMisses`
    - 达到阈值则 [`Agent.enterLeavingMode()`](AstrTown/convex/aiTown/agent.ts:250)，否则 [`Agent.enterSleepingMode()`](AstrTown/convex/aiTown/agent.ts:240)
  - 若队列深度低于 low watermark，且距离上次请求超过 min interval：设置 `prefetch.waiting=true` 并写 `requestId`

### 6.3 对话开始时的“相邻落点”选择

- 在 [`Conversation.tick()`](AstrTown/convex/aiTown/conversation.ts:49) 中，当双方 walkingOver 且距离满足条件：
  - 基于 `neighbors`（上下左右）生成候选格子
  - 对 player1：过滤 `blocked` 后按“离 player2 更近”排序取第一个
  - 对 player2：在 player1 选择的格子周围再找一个可走点
  - 最终调用 [`movePlayer()`](AstrTown/convex/aiTown/conversation.ts:96) 将两人移动到更合理的对话站位

### 6.4 候选对话人选择（带冷却与距离排序）

- [`findConversationCandidate`](AstrTown/convex/aiTown/agent.ts:943)
  - 遍历 `otherFreePlayers`
  - 查询 `participatedTogether`（index: `edge`）以检查 `PLAYER_CONVERSATION_COOLDOWN`
  - 以几何距离排序，返回最近者 id

### 6.5 网关事件定向投递与幂等

- [`scheduleEventPush()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:356)
  - 根据事件类型选择 `targetAgentIds`（世界级/对话级/邀请定向）
  - 对每个 target：构造 [`buildIdempotencyKey()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:37) 并通过 scheduler 调度 [`pushEventToGateway`](AstrTown/convex/aiTown/worldEventDispatcher.ts:47)

---

## 特别说明/边界

1. 本文只覆盖用户指定的 7 个文件。诸如 `Game`、`inputHandler`、`movement`、`insertInput`、以及“pendingOperations 如何被转换为 worldEventDispatcher.schedule* 调用”的上层调度逻辑不在本文范围内。
2. [`worldEventDispatcher.pushEventToGateway`](AstrTown/convex/aiTown/worldEventDispatcher.ts:47) 依赖环境变量 `GATEWAY_URL/GATEWAY_SECRET`，缺失会抛错（[`requireEnv()`](AstrTown/convex/aiTown/worldEventDispatcher.ts:17)）。
