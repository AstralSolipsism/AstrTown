# 架构分析：gateway 模块

> 目标：对 `gateway/src/` 下全部 20 个文件进行逐一、可追溯（可定位到文件/函数）的架构分析，并给出模块关系、数据流与关键算法说明。

## 1. 模块概述

### 1.1 模块定位与职责

`gateway` 模块是 AstrTown 项目中的“网关/适配层”，对外提供：

- WebSocket 接入：NPC/bot 客户端通过 `/ws/bot` 连接到 gateway，完成鉴权、协议版本协商、心跳维持，并在连接上收发指令与世界事件（见 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)）。
  - HTTP 接入：
    - `/gateway/event`：接收来自上游（通常是 AstrTown/Convex）推送的世界事件，经鉴权与幂等处理后，按优先级入队并尝试投递到对应 bot 的 WebSocket（见 [`registerHttpRoutes()`](../gateway/src/routes.ts:14)）。
    - `/gateway/status`、`/health`、`/gateway/metrics`：健康检查与指标暴露（见 [`registerHttpRoutes()`](../gateway/src/routes.ts:46)、[`renderMetrics()`](../gateway/src/metrics.ts:77)）。
    - `/api/bot/description/update`：到 AstrTown 后端的描述更新代理（见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)）。
    - `/api/bot/memory/search`：记忆检索代理透传（`POST`，见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:168)）。
    - `/api/bot/social/affinity`：好感度写回代理透传（`POST`，见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:194)）。
    - `/api/bot/memory/recent`：近期记忆查询代理透传（`GET`，见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:220)）。
    - `/api/bot/social/state`：社交关系/好感状态查询代理透传（`GET`，见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:248)）。
    - `/api/bot/memory/inject`：记忆注入代理透传（`POST`，见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:276)）。


### 1.2 核心组件与协作方式

gateway 的运行时结构在入口文件 [`gateway/src/index.ts`](../gateway/src/index.ts) 中完成组装，关键对象包括：

- AstrTown API 客户端：[`AstrTownClient`](../gateway/src/astrtownClient.ts:57)（封装 token 校验、下发命令、批量命令、描述更新、社交关系写回 [`upsertRelationship()`](../gateway/src/astrtownClient.ts:231)；并暴露可读 `baseUrl` 供 HTTP 代理透传使用）。
- 连接管理：[`ConnectionManager`](../gateway/src/connectionManager.ts:11)（按 token、agentId、playerId 三索引维护当前 WebSocket 连接，提供 [`getByPlayerId()`](../gateway/src/connectionManager.ts:28)）。
- 命令路径：
  - 命令映射：[`CommandMapper`](../gateway/src/commandMapper.ts:33) 将 WS 上收到的 `command.*` 语义映射成可投递给 AstrTown 后端的事件/请求，并纳入社交关系命令 `propose_relationship/respond_relationship`。
  - 命令串行化：[`CommandQueue`](../gateway/src/commandQueue.ts:23) 保证同一 agent 的命令按序执行，并具备超时与完成信号（例如 `action.finished`）驱动的推进。
  - 命令路由：[`CommandRouter`](../gateway/src/commandRouter.ts:42) 负责解析 WS 入站命令、入队执行、向客户端发送 `command.ack`；其中社交关系命令在 gateway 内本地分支处理，不透传到后端 command API。
- 事件路径：
  - 事件队列：[`EventQueue`](../gateway/src/eventQueue.ts:27) 维护 per-agent、分优先级的队列，并支持过期丢弃与重试调度字段（attempts/nextAttemptAt）。
  - 队列注册表：[`BotQueueRegistry`](../gateway/src/queueRegistry.ts:6) 为每个 agent 懒加载一个 [`EventQueue`](../gateway/src/eventQueue.ts:27)。
  - 投递与 ACK 重试：[`EventDispatcher`](../gateway/src/eventDispatcher.ts:15) 负责“从队列取出就绪事件 → 发送 → 等待 event.ack → 超时重试/丢弃”。
- 协议与消息类型：集中在 [`types.ts`](../gateway/src/types.ts) 中定义（包括 command、event、ack、connected/auth_error、心跳 ping/pong 等）。

### 1.3 在整体项目中的作用

gateway 处在“bot 客户端”和“AstrTown 后端（Convex/botApi）”之间：

- 对 bot：提供统一的 WebSocket 协议（鉴权、版本协商、订阅过滤、队列化 ACK 语义）。
- 对后端：
  - 作为命令转发器：将 WS 指令转成后端可接受的 HTTP 请求（[`AstrTownClient.postCommand()`](../gateway/src/astrtownClient.ts:117)、[`AstrTownClient.postCommandBatch()`](../gateway/src/astrtownClient.ts:165)）。
  - 作为“社交关系命令本地处理器”：对 `command.propose_relationship` / `command.respond_relationship` 在 gateway 内执行目标在线检查、参数校验、关系写回与社交事件投递，不再进入后端 command API（见 [`CommandRouter.handle()`](../gateway/src/commandRouter.ts:142)）。
  - 作为事件分发器：将后端推送事件按 agent 分发到 WS（[`/gateway/event`](../gateway/src/routes.ts:65) → 入队 → dispatcher），并支持社交关系事件 `social.relationship_proposed` / `social.relationship_responded`。
  - 说明：gateway 当前**不再**在 WebSocket 连接建立/断开时触发任何“外控开关”流程（不再调用 `deps.astr.setExternalControl(token, true/false)`；也不再存在 `externalControlReassertTimer` 二次确认）。

## 2. 文件清单

> 说明：本节的“行数”来自逐文件读取时返回的行号范围；“字符数”以工作区文件列表（environment_details）中显示的 `# chars` 为准。

| # | 文件 | 功能概述 | 行数(约) | 字符数 |
|---:|---|---|---:|---:|
| 1 | [`gateway/src/astrtownClient.ts`](../gateway/src/astrtownClient.ts) | AstrTown 后端 HTTP 客户端：token 校验、命令下发、批量命令、描述更新、社交关系写回 | 274 | 7944 |
| 2 | [`gateway/src/auth.ts`](../gateway/src/auth.ts) | WS 鉴权/协商辅助：版本范围解析、协议版本协商、订阅列表解析、connected/auth_error 构造、消息解析/序列化 | 129 | 3896 |
| 3 | [`gateway/src/commandMapper.ts`](../gateway/src/commandMapper.ts) | 将 WS 命令映射为后端外部事件（batch/event），含社交关系命令映射注册 | 213 | 6242 |
| 4 | [`gateway/src/commandQueue.ts`](../gateway/src/commandQueue.ts) | per-agent 命令串行执行队列：inflight、超时、完成推进 | 147 | 4156 |
| 5 | [`gateway/src/commandRouter.ts`](../gateway/src/commandRouter.ts) | WS 入站命令路由：解析、入队、调用 AstrTownClient、发送 command.ack、记录指标，含社交关系命令本地分支 | 484 | 18395 |
| 6 | [`gateway/src/config.ts`](../gateway/src/config.ts) | 环境变量配置加载与 ACK 重试参数解析 | 65 | 1991 |
| 7 | [`gateway/src/connectionManager.ts`](../gateway/src/connectionManager.ts) | WebSocket 连接与会话索引（byToken/byAgentId/byPlayerId） | 54 | 1540 |
| 8 | [`gateway/src/eventDispatcher.ts`](../gateway/src/eventDispatcher.ts) | 事件投递器：出队、订阅过滤、发送、等待 ack、超时重试/丢弃、指标统计 | 170 | 6351 |
| 9 | [`gateway/src/eventQueue.ts`](../gateway/src/eventQueue.ts) | 分优先级事件队列：enqueue/peek/dequeue/remove/depth、过期判定字段 | 110 | 3167 |
| 10 | [`gateway/src/httpRoutes.ts`](../gateway/src/httpRoutes.ts) | HTTP 解析与代理：解析 incoming event、构造 WS world event、description/update 与 memory/social 代理 | 301 | 10280 |
| 11 | [`gateway/src/id.ts`](../gateway/src/id.ts) | 基于 uuid 的简单 ID 工具（可带前缀） | 6 | 170 |
| 12 | [`gateway/src/index.ts`](../gateway/src/index.ts) | 入口：Fastify 初始化、依赖组装、注册 WS/HTTP 路由、监听端口（CommandRouter 注入 world event 依赖） | 109 | 3282 |
| 13 | [`gateway/src/metrics.ts`](../gateway/src/metrics.ts) | Prometheus 指标定义与输出（text/json） | 95 | 2933 |
| 14 | [`gateway/src/queueRegistry.ts`](../gateway/src/queueRegistry.ts) | per-agent 队列注册表、事件优先级分类、入队并触发投递（含 social.relationship_proposed 优先级） | 63 | 2268 |
| 15 | [`gateway/src/routes.ts`](../gateway/src/routes.ts) | Fastify HTTP 路由：status/metrics/health、/gateway/event（鉴权、幂等、入队、命令完成联动） | 141 | 5079 |
| 16 | [`gateway/src/subscription.ts`](../gateway/src/subscription.ts) | 订阅匹配器：支持 `*` 与 `prefix.*` | 23 | 732 |
| 17 | [`gateway/src/types.ts`](../gateway/src/types.ts) | WS 协议类型定义：消息基类、world event、commands、ack、会话、优先级等（含社交关系命令/事件联合类型） | 329 | 8214 |
| 18 | [`gateway/src/utils.ts`](../gateway/src/utils.ts) | 幂等缓存与“已连接”错误消息构造 | 36 | 901 |
| 19 | [`gateway/src/uuid.ts`](../gateway/src/uuid.ts) | `randomUUID()` 封装 | 5 | 112 |
| 20 | [`gateway/src/wsHandler.ts`](../gateway/src/wsHandler.ts) | WS 路由与连接生命周期：版本协商、鉴权、去重、心跳、消息处理、断开清理、外部控制开关 | 495 | 16929 |

## 3. 文件详细分析

> 组织方式：每个文件按“基本信息 → imports → exports → 关键函数/变量 → 内部关系 → 跨文件关系”描述。

### 3.1 [`gateway/src/astrtownClient.ts`](../gateway/src/astrtownClient.ts)

- 基本信息
  - 角色：AstrTown 后端 HTTP 客户端封装。
  - 关键类型：[`VerifyTokenResponse`](../gateway/src/astrtownClient.ts:6)、[`PostCommandResponse`](../gateway/src/astrtownClient.ts:20)、[`PostCommandBatchArgs`](../gateway/src/astrtownClient.ts:34)、[`UpdateDescriptionResponse`](../gateway/src/astrtownClient.ts:42)、[`UpsertRelationshipResponse`](../gateway/src/astrtownClient.ts:49)。

- 导入模块
  - 无本地 import；依赖全局 `fetch`、`Response` 类型（通过 `typeof fetch`、运行环境提供）。

- 导出内容
  - 类型：`AstrTownClientDeps`、`VerifyTokenResponse`、`PostCommandResponse`、`PostCommandEnqueueMode`、`PostCommandBatchEvent`、`PostCommandBatchArgs`、`UpdateDescriptionResponse`、`UpsertRelationshipResponse`。
  - 类：[`AstrTownClient`](../gateway/src/astrtownClient.ts:49)。

- 定义的函数/变量（类方法）
  - 构造：[`constructor()`](../gateway/src/astrtownClient.ts:61) 规范化 `baseUrl`（去尾 `/`），确定 `fetchFn`；`baseUrl` 以 `readonly` 暴露，供 HTTP 代理透传调用。
  - Token 校验：[`validateToken()`](../gateway/src/astrtownClient.ts:58)
    - 调用 `POST {baseUrl}/api/bot/token/validate`。
    - 网络错误返回 `{valid:false, code:'NETWORK_ERROR'...}`。
    - 非 2xx 返回 `{valid:false, code/message}`。
    - 成功时要求 `agentId/playerId/worldId` 存在，否则返回 `INVALID_TOKEN_RESPONSE`。
  - 单命令：[`postCommand()`](../gateway/src/astrtownClient.ts:109)
    - 调用 `POST {baseUrl}/api/bot/command`，带 `authorization: Bearer` 与 `x-idempotency-key`。
    - 可选 `enqueueMode` 字段透传。
    - 返回 accepted/rejected 结构。
  - 批量命令：[`postCommandBatch()`](../gateway/src/astrtownClient.ts:157)
    - 调用 `POST {baseUrl}/api/bot/command/batch`。
    - 失败直接 `throw Error(code: message)`（供上层捕获）。
  - 说明：`gateway client` 层当前不再提供 `setExternalControl` 方法（见 [`AstrTownClient`](../gateway/src/astrtownClient.ts:49) 的方法清单）。
  - 描述更新：[`updateDescription()`](../gateway/src/astrtownClient.ts:193)
    - 调用 `POST {baseUrl}/api/bot/description/update`。
    - 封装成 `{ok:false, error, code, statusCode}` 或 `{ok:true}`。
  - 社交关系写回：[`upsertRelationship()`](../gateway/src/astrtownClient.ts:231)
    - 调用 `POST {baseUrl}/api/bot/social/relationship`。
    - 请求体：`{ playerAId, playerBId, status, establishedAt }`。
    - 返回 `{ok:true, relationshipId?}` 或 `{ok:false, error, code, statusCode}`。

- 文件内部关系
  - 无；方法间仅共享 `baseUrl/fetchFn`。

- 文件间关系
  - 被 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) 调用：`validateToken`、`postCommand`。
  - 被 [`CommandRouter`](../gateway/src/commandRouter.ts:42) 调用：`postCommand`、`postCommandBatch`、`upsertRelationship`。
  - 被 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121) 调用：`updateDescription`；并通过 `readonly baseUrl` 作为 memory/social 代理的上游基地址。

### 3.2 [`gateway/src/auth.ts`](../gateway/src/auth.ts)

- 基本信息
  - 角色：WS 接入前的协议相关工具函数：版本协商、订阅解析、消息构造与序列化。

- 导入模块
  - [`createId()`](../gateway/src/id.ts:3)（为消息生成 id）。
  - 类型：`AuthErrorMessage`、`BotBinding`、`ConnectedMessage`、`WsInboundMessage`、`WsOutboundMessage` 来自 [`types.ts`](../gateway/src/types.ts)。

- 导出内容
  - 类型：`TokenVerifyResult`、`NegotiationResult`。
  - 函数：[`parseVersionRange()`](../gateway/src/auth.ts:28)、[`negotiateVersion()`](../gateway/src/auth.ts:40)、[`parseSubscribeList()`](../gateway/src/auth.ts:60)、[`buildConnectedMessage()`](../gateway/src/auth.ts:69)、[`buildAuthErrorMessage()`](../gateway/src/auth.ts:98)、[`parseInboundMessage()`](../gateway/src/auth.ts:117)、[`serializeOutboundMessage()`](../gateway/src/auth.ts:127)。

- 关键函数/变量
  - 版本范围解析：[`parseVersionRange()`](../gateway/src/auth.ts:28)
    - 输入形如 `"min-max"`，不合法回落到 `{min:1,max:1}`。
  - 协商：[`negotiateVersion()`](../gateway/src/auth.ts:40)
    - 从 `supportedVersions` 过滤落在 clientRange 内的版本。
    - 若无交集：返回 `VERSION_MISMATCH` 并携带排序后的 supportedVersions。
    - 有交集：选择可接受版本的最大值作为 `negotiatedVersion`。
  - 订阅解析：[`parseSubscribeList()`](../gateway/src/auth.ts:60)
    - `subscribe` query 逗号分隔，空则默认 `['*']`。
  - connected/auth_error 构造：[`buildConnectedMessage()`](../gateway/src/auth.ts:69)、[`buildAuthErrorMessage()`](../gateway/src/auth.ts:98)
    - 均使用 [`createId()`](../gateway/src/id.ts:3) 生成 `msg` 前缀 id。
  - 入站消息解析：[`parseInboundMessage()`](../gateway/src/auth.ts:117)
    - 做结构性校验：对象、type/id/timestamp/payload。
  - 出站序列化：[`serializeOutboundMessage()`](../gateway/src/auth.ts:127) 直接 `JSON.stringify`。

- 文件内部关系
  - `buildConnectedMessage/buildAuthErrorMessage` 复用 `createId('msg')` 生成消息 id。

- 文件间关系
  - 在 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) 中使用：[`parseVersionRange()`](../gateway/src/auth.ts:28)、[`negotiateVersion()`](../gateway/src/auth.ts:40)、[`parseSubscribeList()`](../gateway/src/auth.ts:60)、[`buildConnectedMessage()`](../gateway/src/auth.ts:69)、[`buildAuthErrorMessage()`](../gateway/src/auth.ts:98)。

### 3.3 [`gateway/src/commandMapper.ts`](../gateway/src/commandMapper.ts)

- 基本信息
  - 角色：把 WS 命令语义映射为后端可处理的“外部事件”（用于 batch）或命令请求结构。

- 导入模块
  - 类型：`EventPriority`、`MoveToCommand` 来自 [`types.ts`](../gateway/src/types.ts)。
  - 类型：`PostCommandBatchEvent` 来自 [`astrtownClient.ts`](../gateway/src/astrtownClient.ts:26)。
  - UUID：[`createUuid()`](../gateway/src/uuid.ts:3)。

- 导出内容
  - 类型：`CommandType`、`AstrTownCommandRequest`、`ExternalEventItem`、`CommandMapping`。
  - 类：[`CommandMapper`](../gateway/src/commandMapper.ts:31)。
  - 工厂：[`createDefaultCommandMapper()`](../gateway/src/commandMapper.ts:62)。

- 关键函数/变量
  - 注册/查询：[`CommandMapper.register()`](../gateway/src/commandMapper.ts:34)、[`CommandMapper.get()`](../gateway/src/commandMapper.ts:38)。
  - 映射到外部事件：[`CommandMapper.mapToExternalEvent()`](../gateway/src/commandMapper.ts:42)
    - 使用 [`createUuid()`](../gateway/src/uuid.ts:3) 生成 `eventId`。
    - `kind` 使用 request.commandType；`args` 强转为 `Record<string, any>`；可附带 `defaultPriority`。
  - 批量映射：[`CommandMapper.mapBatchToExternalEvents()`](../gateway/src/commandMapper.ts:57)。
  - 默认映射集：[`createDefaultCommandMapper()`](../gateway/src/commandMapper.ts:64)
    - `set_activity` 被映射为后端 `continue_doing`，并把 `duration` 转换成 `until`（`Date.now() + duration`）。
    - `accept_invite/reject_invite` 设置 `defaultPriority: 1`，并在注释中说明必须进入优先队列。
    - `invite` 被映射为后端 `start_conversation`。
    - 新增 `propose_relationship/respond_relationship` 映射注册；映射项保留在表中用于类型统一与 batch 解析，但注释明确这两类命令应在 gateway 路由层本地处理，不透传后端 command API。

- 文件内部关系
  - `createDefaultCommandMapper` 通过多次 `mapper.register` 组装 mapping 表。

- 文件间关系
  - 被 [`CommandRouter`](../gateway/src/commandRouter.ts:42) 使用：校验命令支持性（`mapper.get`）与构造请求（`mapping.buildRequest`），并在 batch 分支对非社交关系命令使用 `mapBatchToExternalEvents` 透传。

### 3.4 [`gateway/src/commandQueue.ts`](../gateway/src/commandQueue.ts)

- 基本信息
  - 角色：命令串行队列（按 agentId）；同一 agent 同时最多一个 inflight；支持超时与完成信号推进。

- 导入模块
  - 无显式 import；使用 `NodeJS.Timeout` 类型。

- 导出内容
  - 类型：`CommandQueueItem`、`CommandQueueDeps`。
  - 类：[`CommandQueue`](../gateway/src/commandQueue.ts:23)。

- 关键函数/变量
  - 常量：`DEFAULT_COMMAND_TIMEOUT_MS = 30_000`（见 [`commandQueue.ts`](../gateway/src/commandQueue.ts:21)）。
  - 入队：[`CommandQueue.enqueue()`](../gateway/src/commandQueue.ts:32)
    - push 后立刻 [`drain()`](../gateway/src/commandQueue.ts:92)。
  - 出队：[`CommandQueue.dequeue()`](../gateway/src/commandQueue.ts:38)（对外提供，但在当前代码路径中主要由 `drain` 使用内部 `q.shift`）。
  - 完成：[`CommandQueue.complete()`](../gateway/src/commandQueue.ts:46)
    - 清理 inflight、打点日志、随后调用 [`drain()`](../gateway/src/commandQueue.ts:92) 推进下一条。
    - 注释强调：`drain()` 在变 inflight 时已经 shift，complete 不可再 dequeue。
  - 查询 inflight：[`CommandQueue.getInflightAgentId()`](../gateway/src/commandQueue.ts:70)。
  - 清理 agent：[`CommandQueue.clearAgent()`](../gateway/src/commandQueue.ts:74)。
  - 核心调度：[`CommandQueue.drain()`](../gateway/src/commandQueue.ts:92)
    - 若已有 inflight 则返回。
    - shift 取出 pending 的第一项作为 inflight。
    - 设置超时 timer：超时后调用 [`complete()`](../gateway/src/commandQueue.ts:46) reason=`timeout`。
    - 执行 `item.execute()`：
      - `accepted=true` → reason=`accepted`（注释：Convex 接受即视为完成）。
      - 否则 reason=`rejected`。
      - catch 也视为 rejected。

- 文件内部关系
  - `enqueue`/`complete`/`clearAgent` 都会触发/影响 `drain` 的推进行为。

- 文件间关系
  - 被 [`CommandRouter.handle()`](../gateway/src/commandRouter.ts:77) 用于把命令包装成 `CommandQueueItem` 入队。
  - 被 HTTP 事件入口用于“命令完成联动”：当收到 `action.finished` 时调用 [`CommandQueue.complete()`](../gateway/src/commandQueue.ts:46)（见 [`registerHttpRoutes()`](../gateway/src/routes.ts:14) 内 `action.finished` 分支）。
  - 被 WS 断开清理：[`CommandQueue.clearAgent()`](../gateway/src/commandQueue.ts:74)（见 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) close handler）。

### 3.5 [`gateway/src/commandRouter.ts`](../gateway/src/commandRouter.ts)

- 基本信息
  - 角色：WS 入站命令处理器；将命令入队串行执行；调用 AstrTownClient；回发 `command.ack`；记录指标；并在网关内本地处理社交关系命令。

- 导入模块
  - 类型/对象：`AstrTownClient`（类型）来自 [`astrtownClient.ts`](../gateway/src/astrtownClient.ts:57)。
  - UUID：[`createUuid()`](../gateway/src/uuid.ts:3)。
  - 指标：[`commandsTotal`](../gateway/src/metrics.ts:21)、[`commandLatencyMs`](../gateway/src/metrics.ts:27)。
  - 类型：`BotConnection`、`ConnectionManager` 来自 [`connectionManager.ts`](../gateway/src/connectionManager.ts:3)。
  - 类型：`CommandMapper/CommandType` 来自 [`commandMapper.ts`](../gateway/src/commandMapper.ts:5)。
  - 类型：`CommandQueue` 来自 [`commandQueue.ts`](../gateway/src/commandQueue.ts:23)。
  - 事件依赖：`BotQueueRegistry`、`EventDispatcher` 以及 [`classifyPriority()`](../gateway/src/queueRegistry.ts:25)/[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:44)。
  - 类型：`SocialRelationshipProposedEvent`、`SocialRelationshipRespondedEvent`、`WorldEvent`、`WsInboundMessage`、`WsWorldEventBase` 来自 [`types.ts`](../gateway/src/types.ts:130)。

- 导出内容
  - 类型：`CommandRouterDeps`。
  - 类：[`CommandRouter`](../gateway/src/commandRouter.ts:42)。

- 关键函数/变量
  - batch 解析：[`toBatchItems()`](../gateway/src/commandRouter.ts:45)
    - 校验 payload.commands 非空数组。
    - 校验每项 `type` 以 `command.` 开头，且 `id` 非空。
    - 将 `type` 去前缀得到 `CommandType`，并用 `mapper.get` 校验支持性。
  - ACK 发送封装：[`safeAckSend()`](../gateway/src/commandRouter.ts:74)
    - 始终发送 `ackSemantics:'queued'`，并 try/catch 防止影响主流程。
  - 本地社交事件入队封装：[`pushRelationshipProposedEvent()`](../gateway/src/commandRouter.ts:102)、[`pushRelationshipRespondedEvent()`](../gateway/src/commandRouter.ts:122)
    - 使用 [`isWsWorldEventBase()`](../gateway/src/commandRouter.ts:29) 做事件结构校验。
    - 通过 [`classifyPriority()`](../gateway/src/queueRegistry.ts:25) + [`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:44) 投递到目标 agent 队列。
  - 主入口：[`handle()`](../gateway/src/commandRouter.ts:142)
    - `command.batch`：
      - 解析 batchItems；失败则对 batch 消息 id 回 `rejected`。
      - 入 [`CommandQueue.enqueue()`](../gateway/src/commandQueue.ts:32)，执行函数内：
        - 新增 `acceptedCommandIds` 与 `passthroughItems` 分流：
          - `propose_relationship`：校验 `targetPlayerId/status`；通过 [`ConnectionManager.getByPlayerId()`](../gateway/src/connectionManager.ts:28) 检查目标在线；在线则构建 `social.relationship_proposed` 并入队目标 agent，离线则对该子命令 ack rejected(`target_offline`)。
          - `respond_relationship`：校验 `proposerId`；`accept=true` 时先调用 [`AstrTownClient.upsertRelationship()`](../gateway/src/astrtownClient.ts:231) 写回关系，再向 proposer 在线连接投递 `social.relationship_responded`（proposer 离线仅记录 info）。
          - 其他命令进入 `passthroughItems`，再调用 [`AstrTownClient.postCommandBatch()`](../gateway/src/astrtownClient.ts:165) 透传。
        - 子命令 ACK 与 batch 总 ACK 分离：已本地接受的 commandId 进入 `acceptedCommandIds`；异常时仅补发未接受子命令 rejected ACK，并回 batch rejected。
    - 单命令：
      - 仅处理 `type` 以 `command.` 开头。
      - 查找 mapping；无 mapping 则直接 ack rejected。
      - 社交关系单命令走本地分支：
        - `command.propose_relationship`：参数校验 + 目标在线检查 + 投递 `social.relationship_proposed` + ACK。
        - `command.respond_relationship`：参数校验 + 可选关系写回（accept）+ 投递 `social.relationship_responded` + ACK。
      - 其他命令保持透传：
        - `mapping.buildRequest({agentId,...payload})`
        - 生成 `idempotencyKey`（含 agentId、commandType、时间戳、短 uuid 前缀）。
        - 调用 [`AstrTownClient.postCommand()`](../gateway/src/astrtownClient.ts:117)
          - 对 `say` 使用 `enqueueMode:'immediate'`，其余 `queue`（注释解释绕过后端外部事件队列以确保对话渲染）。
        - 根据返回 accepted/rejected 回 ack 并打点 `commandsTotal`。

- 文件内部关系
  - `handle` 将“解析/校验”与“执行/打点/ack”通过 `CommandQueue` 串行化。

- 文件间关系
  - 依赖 [`CommandQueue`](../gateway/src/commandQueue.ts:23) 进行 per-agent 串行。
  - 依赖 [`CommandMapper`](../gateway/src/commandMapper.ts:33) 做命令语义映射。
  - 依赖 [`AstrTownClient`](../gateway/src/astrtownClient.ts:57) 完成后端调用（含关系写回 [`upsertRelationship()`](../gateway/src/astrtownClient.ts:231)）。
  - 依赖 [`ConnectionManager`](../gateway/src/connectionManager.ts:11) 的 [`getByPlayerId()`](../gateway/src/connectionManager.ts:28) 完成社交命令目标在线检查。
  - 依赖事件队列与分发器（[`BotQueueRegistry`](../gateway/src/queueRegistry.ts:6)、[`EventDispatcher`](../gateway/src/eventDispatcher.ts:15)）把社交关系事件发送给目标 agent。
  - 由 WS 层调用：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) 在 message handler 中对 `command.*` 调用 [`CommandRouter.handle()`](../gateway/src/commandRouter.ts:142)。

### 3.6 [`gateway/src/config.ts`](../gateway/src/config.ts)

- 基本信息
  - 角色：读取 `.env` 与环境变量，生成 gateway 运行时配置；特别是 ACK 重试参数。

- 导入模块
  - `dotenv`（`dotenv.config()` 在模块加载时执行）。
  - [`DEFAULT_ACK_PLAN`](../gateway/src/eventQueue.ts:7) 来自 [`eventQueue.ts`](../gateway/src/eventQueue.ts)。

- 导出内容
  - 类型：`GatewayConfig`。
  - 函数：[`loadConfig()`](../gateway/src/config.ts:45)。

- 关键函数/变量
  - `requireEnv`（定义但在当前文件中未被 `loadConfig` 使用，见 [`config.ts`](../gateway/src/config.ts:17)）。
  - 正整数解析：`parsePositiveInt`（用于 ACK_TIMEOUT/ACK_MAX_RETRIES）。
  - backoff 解析：`parseBackoff`（逗号分隔数字数组；空则回落到默认计划）。
  - 配置加载：[`loadConfig()`](../gateway/src/config.ts:45)
    - `ASTRTOWN_URL` 默认 `http://localhost:3210`。
    - `PORT` 默认 `4000`。
    - `GATEWAY_SECRET` 可选。
    - `GATEWAY_VERSION` 默认 `0.1.0`。
    - `supportedProtocolVersions: [1]`。
    - ACK 参数来自 env 或默认计划。

- 文件间关系
  - 被入口 [`gateway/src/index.ts`](../gateway/src/index.ts) 调用 [`loadConfig()`](../gateway/src/config.ts:45)。

### 3.7 [`gateway/src/connectionManager.ts`](../gateway/src/connectionManager.ts)

- 基本信息
  - 角色：管理活跃 WS 连接的索引结构，支持按 token、agentId、playerId 查找。

- 导入模块
  - 类型：`BotSession`、`ConnectionState` 来自 [`types.ts`](../gateway/src/types.ts:256)。

- 导出内容
  - 类型：`BotConnection`。
  - 类：[`ConnectionManager`](../gateway/src/connectionManager.ts:11)。

- 关键函数/变量
  - `byToken/byAgentId/byPlayerId` 三个 Map（见 [`ConnectionManager`](../gateway/src/connectionManager.ts:11)）。
  - 查询：[`hasToken()`](../gateway/src/connectionManager.ts:16)、[`getByToken()`](../gateway/src/connectionManager.ts:20)、[`getByAgentId()`](../gateway/src/connectionManager.ts:24)、[`getByPlayerId()`](../gateway/src/connectionManager.ts:28)。
  - 注册：[`register()`](../gateway/src/connectionManager.ts:32) 同时写入三索引。
  - 反注册：[`unregisterByToken()`](../gateway/src/connectionManager.ts:38) 删除三索引并返回旧连接。
  - 会话列表/数量：[`listSessions()`](../gateway/src/connectionManager.ts:47)、[`size()`](../gateway/src/connectionManager.ts:51)。

- 文件间关系
  - WS 层：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) 在鉴权成功后 `register`，断开时 `unregisterByToken`。
  - 事件层：[`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48) 通过 `getByAgentId` 找到连接。
  - 命令层：[`CommandRouter.handle()`](../gateway/src/commandRouter.ts:142) 通过 `getByPlayerId` 做社交关系命令的目标在线检查与事件路由。
  - 连接去重：WS 层通过 `getByAgentId` 找到旧连接并驱逐（见 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) 中 existing 分支）。

### 3.8 [`gateway/src/eventDispatcher.ts`](../gateway/src/eventDispatcher.ts)

- 基本信息
  - 角色：把 per-agent 的事件队列（[`EventQueue`](../gateway/src/eventQueue.ts:27)）中的事件发送到 WS；等待 `event.ack`；超时则重试或丢弃；并更新指标。

- 导入模块
  - 类型：`BotConnection`、`ConnectionManager` 来自 [`connectionManager.ts`](../gateway/src/connectionManager.ts:11)。
  - 订阅匹配：[`createSubscriptionMatcher()`](../gateway/src/subscription.ts:6)。
  - 指标：[`ackFailuresTotal`](../gateway/src/metrics.ts:53)、[`eventDispatchLatencyMs`](../gateway/src/metrics.ts:46)、[`eventsDispatchedTotal`](../gateway/src/metrics.ts:40)、[`eventsExpiredTotal`](../gateway/src/metrics.ts:59)、[`queueDepth`](../gateway/src/metrics.ts:65)。
  - 类型：`WsWorldEventBase` 来自 [`types.ts`](../gateway/src/types.ts:12)。
  - 队列与计划：[`DEFAULT_ACK_PLAN`](../gateway/src/eventQueue.ts:7)、[`EventQueue`](../gateway/src/eventQueue.ts:27)、`QueuedEvent/RetryPlan` 来自 [`eventQueue.ts`](../gateway/src/eventQueue.ts)。

- 导出内容
  - 类型：`EventDispatcherDeps`。
  - 类：[`EventDispatcher`](../gateway/src/eventDispatcher.ts:15)。

- 关键函数/变量
  - inflight Map：key=`agentId:eventId`，值包含 timer、type、enqueuedAt（见 [`EventDispatcher`](../gateway/src/eventDispatcher.ts:15)）。
  - ACK 处理：[`onAck()`](../gateway/src/eventDispatcher.ts:26)
    - 取消 inflight timer，记录 dispatch latency，`eventsDispatchedTotal` status=`acked`。
    - 从队列移除 eventId：[`EventQueue.removeByEventId()`](../gateway/src/eventQueue.ts:89)。
    - 再次 [`tryDispatch()`](../gateway/src/eventDispatcher.ts:48) 推进。
  - 断线处理：[`onDisconnect()`](../gateway/src/eventDispatcher.ts:40) 清理该 agent 的 inflight timers。
  - 投递：[`tryDispatch()`](../gateway/src/eventDispatcher.ts:48)
    - 找到连接；从队列 `peekNextReady(now)` 取：
      - empty → return
      - expired → 指标与 warn 日志，继续 while
      - ready → 订阅过滤：不匹配则 `dequeue()` 丢弃并继续
    - 若已 inflight（同 eventId）则 return。
    - `dequeue()` 后调用 [`sendWithRetry()`](../gateway/src/eventDispatcher.ts:83)。
  - 发送与 ack 超时重试：[`sendWithRetry()`](../gateway/src/eventDispatcher.ts:83)
    - send 成功：status=`sent`，更新队列深度。
    - send 失败：status=`failed`，走 [`onSendFailure()`](../gateway/src/eventDispatcher.ts:142) 调度重试/丢弃。
    - 设置 ack timeout timer：
      - 超过 maxRetries：移除队列项，记录 error。
      - 否则增加 attempts，计算 backoff，重入队并 warn。
  - 深度更新：[`updateQueueDepth()`](../gateway/src/eventDispatcher.ts:164) 对 priorities 0..3 分别 set gauge。

- 文件内部关系
  - `tryDispatch` 是核心循环入口：被 `onAck`、`sendWithRetry` 超时逻辑、以及外部 `enqueueWorldEvent` 触发。

- 文件间关系
  - 队列来自注册表：在入口组装时 `getQueue(agentId)=>queues.get(agentId)`（见 [`gateway/src/index.ts`](../gateway/src/index.ts:55)）。
  - 被 HTTP 入口在入队后触发：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37) 会调用 [`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48)。
  - ACK 来自 WS 入站：WS message handler 解析 `event.ack` 并调用 [`EventDispatcher.onAck()`](../gateway/src/eventDispatcher.ts:26)（见 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)）。

### 3.9 [`gateway/src/eventQueue.ts`](../gateway/src/eventQueue.ts)

- 基本信息
  - 角色：分优先级的内存队列（0..3），保存待发送 world event 以及重试调度字段。

- 导入模块
  - 无。

- 导出内容
  - 类型：`RetryPlan`、`QueuedEvent`、`DequeueResult`。
  - 常量：[`DEFAULT_ACK_PLAN`](../gateway/src/eventQueue.ts:7)。
  - 类：[`EventQueue`](../gateway/src/eventQueue.ts:27)。

- 关键函数/变量
  - `queues`: 4 个数组（见 [`EventQueue`](../gateway/src/eventQueue.ts:27)）。
  - 入队：[`enqueue()`](../gateway/src/eventQueue.ts:35)
    - 生成 `QueuedEvent`，`attempts=0`，`nextAttemptAt=now`。
    - 若超出 `perPriorityLimit`：丢弃该优先级队列最老的 item（shift），并返回 dropped。
  - 就绪窥视：[`peekNextReady()`](../gateway/src/eventQueue.ts:56)
    - priority 从 0→3；
    - 若 head 过期：返回 kind=`expired` 并 shift 掉；
    - 若未到 nextAttemptAt：break（该优先级当前不就绪，继续看下一个优先级）。
    - 否则返回 kind=`ready`。
  - 出队：[`dequeue()`](../gateway/src/eventQueue.ts:73) priority 从 0→3 shift。
  - attempt 标记：[`markAttempt()`](../gateway/src/eventQueue.ts:82) 增加 attempts 并更新 nextAttemptAt。
  - 按 eventId 删除：[`removeByEventId()`](../gateway/src/eventQueue.ts:89)。
  - 深度：[`depth()`](../gateway/src/eventQueue.ts:101)。
  - 迭代器：[`[Symbol.iterator]()`](../gateway/src/eventQueue.ts:106) 返回所有优先级拼接的数组迭代。

- 文件间关系
  - 被 [`EventDispatcher`](../gateway/src/eventDispatcher.ts:15) 用于 `peekNextReady/dequeue/enqueue/removeByEventId/depth`。
  - 被配置模块引用默认计划：[`DEFAULT_ACK_PLAN`](../gateway/src/eventQueue.ts:7)（见 [`loadConfig()`](../gateway/src/config.ts:45)）。

### 3.10 [`gateway/src/httpRoutes.ts`](../gateway/src/httpRoutes.ts)

- 基本信息
  - 角色：HTTP 侧的辅助工具：
    - 解析进入 gateway 的世界事件（兼容 legacy 字段）。
    - 构造 WS world event 结构。
    - 注册到 AstrTown 的 description/update 与 memory/social 代理路由。

- 导入模块
  - 类型：`FastifyInstance`。
  - 类型：`AstrTownClient/UpdateDescriptionResponse` 来自 [`astrtownClient.ts`](../gateway/src/astrtownClient.ts:42)。
  - 类型：`EventPriority`、`WsWorldEventBase` 来自 [`types.ts`](../gateway/src/types.ts:12)。

- 导出内容
  - 常量：`SUPPORTED_GATEWAY_EVENT_TYPES`（文件内常量，用于校验）。
  - 类型：`IncomingWorldEvent`。
  - 函数：[`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:25)、[`buildWsWorldEvent()`](../gateway/src/httpRoutes.ts:72)、[`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:120)。

- 关键函数/变量
  - 事件解析：[`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:25)
    - 兼容字段：`agentId`（legacy）、`eventData`（legacy）、`eventTs`（legacy）。
    - 推导 `eventAgentId/targetAgentId`：优先使用新字段，不足时用 legacyAgentId 回填。
    - 推导 `expiresAt`：若无 expiresAt 但有 `eventTs`，则 `expiresAt = eventTs + 60_000`。
    - 校验 `eventType` 在 `SUPPORTED_GATEWAY_EVENT_TYPES` 集合中（现已包含 [`conversation.timeout`](../gateway/src/httpRoutes.ts:6)）。
    - 校验 priority ∈ {0,1,2,3}。

> 补充：`conversation.timeout` 是引擎侧的“强打断/兜底”事件，用于外控 Agent 在对话 invited/participating 阶段超时后通知插件端打破死锁。该事件被网关视为最高优先级并优先投递到 WS（见 [`classifyPriority()`](../gateway/src/queueRegistry.ts:25)）。
  - 构造 WS world event：[`buildWsWorldEvent()`](../gateway/src/httpRoutes.ts:73)。
  - description/update 代理：[`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)
    - 校验 Authorization Bearer token。
    - 校验 body 的 `playerId/description`。
    - 调用 [`AstrTownClient.updateDescription()`](../gateway/src/astrtownClient.ts:193)。
    - 将失败映射为 HTTP 状态码（内部函数 `mapUpdateDescriptionErrorStatus()`，见 [`gateway/src/httpRoutes.ts`](../gateway/src/httpRoutes.ts:93)）。
  - memory/search 代理：[`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)
    - 路由：`POST /api/bot/memory/search`。
    - 目标：为 AstrBot 插件提供“记忆检索请求”的网关透传能力，将请求直接转发到上游 `/api/bot/memory/search`。
    - 鉴权：仅要求 `Authorization` 头存在（不在 gateway 内解析 Bearer 结构），并原样透传到上游。
    - 转发方式：使用全局 `fetch` 直接转发（未通过 [`AstrTownClient`](../gateway/src/astrtownClient.ts:49) 的封装）。
    - body：将 `req.body ?? {}` 以 JSON 形式转发。
    - 响应：将上游 HTTP status 透传给客户端；响应体尝试 `res.json()`，失败回落 `{}`。
    - 错误处理：catch 时使用 `deps.log.error()` 打印 `memorySearch proxy failed`，并返回 `500 { ok:false, error:'Gateway error' }`。

  - social/affinity 代理：`POST /api/bot/social/affinity`（见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)）
    - 透传 body 与 Authorization 到上游 `/api/bot/social/affinity`，透传状态码与 JSON 响应。
  - memory/recent 代理：`GET /api/bot/memory/recent`（见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)）
    - 通过 `req.raw.url` 截取并保留 query string，透传到上游 `/api/bot/memory/recent`。
  - social/state 代理：`GET /api/bot/social/state`（见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)）
    - 同样保留 query string，透传到上游 `/api/bot/social/state`。
  - memory/inject 代理：`POST /api/bot/memory/inject`（见 [`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)）
    - 透传 JSON body 与 Authorization 到上游 `/api/bot/memory/inject`。

- 文件间关系
  - 被 HTTP 主路由文件引用：[`registerHttpRoutes()`](../gateway/src/routes.ts:14) 使用 [`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:26)、[`buildWsWorldEvent()`](../gateway/src/httpRoutes.ts:73)、[`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:121)。

### 3.11 [`gateway/src/id.ts`](../gateway/src/id.ts)

- 基本信息
  - 角色：统一 ID 生成，可带前缀（主要用于消息 id）。

- 导入模块
  - [`createUuid()`](../gateway/src/uuid.ts:3)。

- 导出内容
  - 函数：[`createId()`](../gateway/src/id.ts:3)。

- 文件间关系
  - 被 [`auth.ts`](../gateway/src/auth.ts) 与 [`utils.ts`](../gateway/src/utils.ts) 用于生成 `msg_*` 的消息 id。

### 3.12 [`gateway/src/index.ts`](../gateway/src/index.ts)

- 基本信息
  - 角色：gateway 进程入口，负责依赖组装与 Fastify 路由注册。

- 导入模块
  - Fastify 及插件：`fastify`、`@fastify/cors`、`@fastify/websocket`。
  - logger：`pino`（但 app 本身也启用了 fastify logger）。
  - 本地模块：
    - [`loadConfig()`](../gateway/src/config.ts:45)
    - [`AstrTownClient`](../gateway/src/astrtownClient.ts:57)
    - [`ConnectionManager`](../gateway/src/connectionManager.ts:11)
    - [`createDefaultCommandMapper()`](../gateway/src/commandMapper.ts:64)
    - [`CommandRouter`](../gateway/src/commandRouter.ts:42)
    - [`CommandQueue`](../gateway/src/commandQueue.ts:23)
    - [`EventDispatcher`](../gateway/src/eventDispatcher.ts:15)
    - [`BotQueueRegistry`](../gateway/src/queueRegistry.ts:6)
    - [`IdempotencyCache`](../gateway/src/utils.ts:4)
    - [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)
    - [`registerHttpRoutes()`](../gateway/src/routes.ts:14)
    - 类型：`WorldEvent` 来自 [`types.ts`](../gateway/src/types.ts:153)

- 导出内容
  - 无（作为应用入口）。

- 关键流程
  - 配置加载：[`loadConfig()`](../gateway/src/config.ts:45)。
  - app 初始化：`fastify({ logger, bodyLimit })`。
  - 注册插件：cors、websocket。
  - 组装核心对象：connections、astr client、mapper、commandQueue、queues、dispatcher。
  - 在 `dispatcher` 初始化之后组装 `commandRouter`，并注入 `connections/worldEventQueues/worldEventDispatcher`，用于社交关系命令本地分支的在线检查与事件投递。
  - 注册 WS 路由：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)（传入支持协议版本、心跳参数、核心依赖）。
  - 注册 HTTP 路由：[`registerHttpRoutes()`](../gateway/src/routes.ts:14)（传入 config、astr、connections、queues、dispatcher、commandQueue、idempotency）。
  - listen：`app.listen({port, host:'0.0.0.0'})`。

- 文件间关系
  - 是所有组件的“依赖注入/组装点”。

### 3.13 [`gateway/src/metrics.ts`](../gateway/src/metrics.ts)

- 基本信息
  - 角色：Prometheus 指标定义与渲染输出。

- 导入模块
  - `prom-client`：`Counter/Gauge/Histogram/collectDefaultMetrics/register`。

- 导出内容
  - 多个指标对象：
    - [`wsConnections`](../gateway/src/metrics.ts:5)、[`wsConnectionsCreated`](../gateway/src/metrics.ts:10)、[`wsConnectionsClosed`](../gateway/src/metrics.ts:15)
    - [`commandsTotal`](../gateway/src/metrics.ts:21)、[`commandLatencyMs`](../gateway/src/metrics.ts:27)
    - [`eventsReceivedTotal`](../gateway/src/metrics.ts:34)、[`eventsDispatchedTotal`](../gateway/src/metrics.ts:40)、[`eventDispatchLatencyMs`](../gateway/src/metrics.ts:46)
    - [`ackFailuresTotal`](../gateway/src/metrics.ts:53)、[`eventsExpiredTotal`](../gateway/src/metrics.ts:59)
    - [`queueDepth`](../gateway/src/metrics.ts:65)、[`heartbeatLatencyMs`](../gateway/src/metrics.ts:71)
  - 渲染函数：[`renderMetrics()`](../gateway/src/metrics.ts:77)、[`renderMetricsJson()`](../gateway/src/metrics.ts:84)。

- 关键点
  - `collectDefaultMetrics({ prefix: 'gateway_' })` 开启默认 Node 指标。
  - JSON 输出会过滤掉 `gateway_nodejs_` 与 `gateway_process_` 开头的指标（见 [`renderMetricsJson()`](../gateway/src/metrics.ts:84)）。

- 文件间关系
  - WS 层连接/心跳：在 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) 使用连接计数与心跳时延。
  - 命令路径：在 [`CommandRouter`](../gateway/src/commandRouter.ts:17) 记录 `commandsTotal/commandLatencyMs`。
  - 事件路径：在 [`EventDispatcher`](../gateway/src/eventDispatcher.ts:15) 记录投递与 ack 相关指标；在 HTTP 入口记录 `eventsReceivedTotal`（见 [`registerHttpRoutes()`](../gateway/src/routes.ts:14)）。

### 3.14 [`gateway/src/queueRegistry.ts`](../gateway/src/queueRegistry.ts)

- 基本信息
  - 角色：事件队列的 agent 维度注册表，以及事件优先级分类、统一入队入口。

- 导入模块
  - 类型：`ConnectionManager`、`EventDispatcher`（仅类型引用，见文件头）。
  - 类型：`EventPriority`、`WsWorldEventBase` 来自 [`types.ts`](../gateway/src/types.ts:12)。
  - 队列：[`EventQueue`](../gateway/src/eventQueue.ts:27)。

- 导出内容
  - 类：[`BotQueueRegistry`](../gateway/src/queueRegistry.ts:6)。
  - 函数：[`classifyPriority()`](../gateway/src/queueRegistry.ts:25)、[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37)。

- 关键函数/变量
  - registry.get：[`BotQueueRegistry.get()`](../gateway/src/queueRegistry.ts:11) 懒加载每个 agent 的队列。
  - registry.delete：[`BotQueueRegistry.delete()`](../gateway/src/queueRegistry.ts:20)（WS 断开时会调用）。
  - 优先级分类：[`classifyPriority()`](../gateway/src/queueRegistry.ts:25)
    - 若提供 hinted 则直接用。
    - `conversation.timeout` → 0（最高优先级）。
    - `conversation.*` → 0。
    - `agent.state_changed`：payload.nearbyPlayers 非空 → 1，否则 2。
    - `action.finished` → 2。
    - `social.relationship_proposed` → 1（社交关系提议优先级提升）。
    - 默认 3。
  - 入队并触发投递：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37)
    - 调用 [`EventQueue.enqueue()`](../gateway/src/eventQueue.ts:35)，若 dropped 则 warn，并可回调 `onDropOldest`。
    - 随后调用 [`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48)。

- 文件间关系
  - 被 HTTP 入口调用：[`registerHttpRoutes()`](../gateway/src/routes.ts:14) 使用 `classifyPriority/enqueueWorldEvent`。

### 3.15 [`gateway/src/routes.ts`](../gateway/src/routes.ts)

- 基本信息
  - 角色：Fastify 的 HTTP 路由注册；包含 `/gateway/event` 的鉴权、幂等、事件入队，并与命令队列完成信号联动。

- 导入模块
  - 类型：`FastifyInstance`。
  - 类型：`GatewayConfig` 来自 [`config.ts`](../gateway/src/config.ts:6)。
  - HTTP 辅助：[`buildWsWorldEvent()`](../gateway/src/httpRoutes.ts:72)、[`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:25)、[`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:120)。
  - 指标：[`eventsReceivedTotal`](../gateway/src/metrics.ts:34)、[`renderMetrics()`](../gateway/src/metrics.ts:77)、[`renderMetricsJson()`](../gateway/src/metrics.ts:84)、[`wsConnections`](../gateway/src/metrics.ts:5)。
  - 类型：`WsWorldEventBase` 来自 [`types.ts`](../gateway/src/types.ts:12)。
  - 队列：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37)、[`classifyPriority()`](../gateway/src/queueRegistry.ts:25) 以及类型 `BotQueueRegistry`。
  - 类型：`EventDispatcher`、`ConnectionManager`、`CommandQueue`、`IdempotencyCache`。
  - UUID：[`createUuid()`](../gateway/src/uuid.ts:3)。

- 导出内容
  - 函数：[`registerHttpRoutes()`](../gateway/src/routes.ts:14)。

- 关键流程
  - gateway event 鉴权：`isGatewayEventAuthorized`（闭包函数）
    - 需要 `deps.config.gatewaySecret` 存在。
    - 支持两种方式：
      - `Authorization: Bearer <secret>`
      - `x-gateway-secret: <secret>`
  - 注册 bot http proxy：[`registerBotHttpProxyRoutes()`](../gateway/src/httpRoutes.ts:120)。
  - status/health/metrics：
    - `/gateway/status` 与 `/health` 类似，返回 uptime、connections、version。
    - `/gateway/metrics` text、`/gateway/metrics/json` JSON。
  - `/gateway/event`：
    1) 鉴权失败返回 401。
    2) 取幂等 key：优先 header `x-idempotency-key`，否则 body `idempotencyKey`。
    3) 缓存命中直接返回 received:true。
    4) 解析 body：[`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:25)；失败 400。
    5) 生成 eventId（[`createUuid()`](../gateway/src/uuid.ts:3)）并构造 event（[`buildWsWorldEvent()`](../gateway/src/httpRoutes.ts:72)）。
    6) 优先级：[`classifyPriority()`](../gateway/src/queueRegistry.ts:25)（hinted 来自 parsed.priority）。
    7) 指标：`eventsReceivedTotal.inc({type,priority})`。
    8) 写入幂等缓存：`deps.idempotency.add(idemKey)`。
    9) 入队并触发投递：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37)，agentId 使用 `parsed.targetAgentId`。
    10) **命令完成联动**：若 event.type === `action.finished`，且该 agent 当前存在 inflight，则调用 [`CommandQueue.complete()`](../gateway/src/commandQueue.ts:46) reason=`action.finished`。

- 文件间关系
  - 依赖 [`IdempotencyCache`](../gateway/src/utils.ts:4) 避免重复事件。
  - 事件入队触发 [`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48)（经由 `enqueueWorldEvent`）。

### 3.16 [`gateway/src/subscription.ts`](../gateway/src/subscription.ts)

- 基本信息
  - 角色：订阅过滤器，用于决定某个连接应当收到哪些 `event.type`。

- 导入模块
  - 无。

- 导出内容
  - 类型：`SubscriptionMatcher`。
  - 函数：[`createSubscriptionMatcher()`](../gateway/src/subscription.ts:6)。

- 关键逻辑
  - `subscribed` 为空则视作 `['*']`。
  - 支持：
    - `*` 全匹配
    - 精确匹配 `conversation.started`
    - 前缀匹配 `conversation.*`（用 `startsWith(prefix + '.')`）

- 文件间关系
  - WS 层：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) 解析 query subscribe 后创建 matcher 并存入 conn。
  - 事件分发：[`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48) 每次取就绪事件都用 matcher 判断是否投递。

### 3.17 [`gateway/src/types.ts`](../gateway/src/types.ts)

- 基本信息
  - 角色：gateway WS 协议“单一事实来源”（Single Source of Truth）：定义所有消息结构、事件、命令、ack、会话、优先级等。

- 导出内容（摘取核心）
  - 常量：`PROTOCOL_VERSION`（见 [`types.ts`](../gateway/src/types.ts:1)）。
  - 基类类型：[`WsMessageBase`](../gateway/src/types.ts:3)、[`WsWorldEventBase`](../gateway/src/types.ts:12)。
  - 世界事件 payload 与 event 类型：
    - `AgentStateChangedEvent`、`ConversationStartedEvent`、`ConversationInvitedEvent`、`ConversationMessageEvent`、`ActionFinishedEvent`、`AgentQueueRefillRequestedEvent`，以及新增 `SocialRelationshipProposedEvent`、`SocialRelationshipRespondedEvent`（见 [`WorldEvent`](../gateway/src/types.ts:153) 联合）。
  - 命令消息类型：`MoveToCommand/SayCommand/.../DoSomethingCommand`，并新增 `ProposeRelationshipCommand`、`RespondRelationshipCommand`（见 [`types.ts`](../gateway/src/types.ts:164) 起）。
  - ACK/心跳：`CommandAck`、`EventAck`、`PingMessage/PongMessage`。
  - 入站/出站联合：[`WsOutboundMessage`](../gateway/src/types.ts:255)、[`WsInboundMessage`](../gateway/src/types.ts:290)。
  - 连接状态与会话：`ConnectionState`、`BotBinding`、`BotSession`。
  - 优先级：`EventPriority = 0|1|2|3`。

- 文件间关系
  - 几乎所有文件都依赖此处类型，尤其是：[`wsHandler.ts`](../gateway/src/wsHandler.ts)、[`commandRouter.ts`](../gateway/src/commandRouter.ts)、[`eventDispatcher.ts`](../gateway/src/eventDispatcher.ts)、[`httpRoutes.ts`](../gateway/src/httpRoutes.ts)。

### 3.18 [`gateway/src/utils.ts`](../gateway/src/utils.ts)

- 基本信息
  - 角色：杂项工具：幂等缓存 + 构造“已连接”错误消息。

- 导入模块
  - [`createId()`](../gateway/src/id.ts:3)。
  - 类型：`AuthErrorMessage` 来自 [`types.ts`](../gateway/src/types.ts:84)。

- 导出内容
  - 类：[`IdempotencyCache`](../gateway/src/utils.ts:4)。
  - 函数：[`buildAlreadyConnectedError()`](../gateway/src/utils.ts:25)。

- 关键逻辑
  - 幂等缓存：
    - [`IdempotencyCache.has()`](../gateway/src/utils.ts:10)
    - [`IdempotencyCache.add()`](../gateway/src/utils.ts:14) 维护插入顺序数组 `order`，超过 capacity 则删除最老 key。
  - 错误消息：[`buildAlreadyConnectedError()`](../gateway/src/utils.ts:25) 返回 `auth_error` code=`ALREADY_CONNECTED`。

- 文件间关系
  - HTTP 入口：[`registerHttpRoutes()`](../gateway/src/routes.ts:14) 使用 `IdempotencyCache`。
  - `buildAlreadyConnectedError` 当前未在 [`wsHandler.ts`](../gateway/src/wsHandler.ts) 中使用（wsHandler 直接调用 [`buildAuthErrorMessage()`](../gateway/src/auth.ts:98)）。

### 3.19 [`gateway/src/uuid.ts`](../gateway/src/uuid.ts)

- 基本信息
  - 角色：UUID 生成统一封装。

- 导入模块
  - `randomUUID` from `node:crypto`。

- 导出内容
  - 函数：[`createUuid()`](../gateway/src/uuid.ts:3)。

- 文件间关系
  - 被 `id.ts`、`commandMapper.ts`、`commandRouter.ts`、`routes.ts`、`wsHandler.ts` 使用，作为统一的 id/eventId/ackId 生成方式。

### 3.20 [`gateway/src/wsHandler.ts`](../gateway/src/wsHandler.ts)

- 基本信息
  - 角色：WebSocket 路由与连接生命周期管理，包含：
    - 协议版本协商
    - token 鉴权与连接去重（按 token/agentId）
    - subscribed events 订阅配置
    - 心跳 ping/pong
    - 入站 message 分发（command/event.ack/pong）
    - 断开清理

- 导入模块
  - Fastify 与 websocket 类型：`FastifyInstance`、`WebSocket`（@fastify/websocket）。
  - 类型依赖：AstrTownClient、CommandQueue、CommandRouter、ConnectionManager、EventDispatcher。
  - 鉴权/协商工具：[`buildAuthErrorMessage()`](../gateway/src/auth.ts:98)、[`buildConnectedMessage()`](../gateway/src/auth.ts:69)、[`negotiateVersion()`](../gateway/src/auth.ts:40)、[`parseSubscribeList()`](../gateway/src/auth.ts:60)、[`parseVersionRange()`](../gateway/src/auth.ts:28)。
  - 订阅匹配：[`createSubscriptionMatcher()`](../gateway/src/subscription.ts:6)。
  - 指标：[`wsConnections`](../gateway/src/metrics.ts:5)、[`wsConnectionsClosed`](../gateway/src/metrics.ts:15)、[`wsConnectionsCreated`](../gateway/src/metrics.ts:10)、[`heartbeatLatencyMs`](../gateway/src/metrics.ts:71)。
  - UUID：[`createUuid()`](../gateway/src/uuid.ts:3)。
  - 类型：`BotSession/WsInboundMessage/WsOutboundMessage/WsWorldEventBase` 来自 [`types.ts`](../gateway/src/types.ts)。

- 导出内容
  - 类型：`WsHandlerDeps`。
  - 函数：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)。

- 关键函数/变量
  - token 脱敏：[`maskToken()`](../gateway/src/wsHandler.ts:15)。
  - WS 路由注册：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)
    - socket 解析与校验（包含 debug 日志）。
    - 解析 query：`token`、`v`（版本范围）、`subscribe`。
    - 版本协商：[`parseVersionRange()`](../gateway/src/auth.ts:28) + [`negotiateVersion()`](../gateway/src/auth.ts:40)
      - 不兼容则发送 auth_error(VERSION_MISMATCH) 并 close。
    - 缺 token：发送 auth_error(INVALID_TOKEN) 并 close。
    - token 已连接：发送 auth_error(ALREADY_CONNECTED) 并 close（通过 `connections.hasToken`）。
    - 连接计数：`wsConnectionsCreated/wsConnections`。
    - token 验证：调用 [`AstrTownClient.validateToken()`](../gateway/src/astrtownClient.ts:58)
      - 失败/无效则发送 auth_error 并 close，同时更新 `wsConnectionsClosed`。
    - agentId 去重：如果同 agent 已连接，则标记旧 socket `_evictedByReconnect=true` 并 close；随后从连接表中移除旧 token（见 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) existing 分支）。
    - 构造 session/conn 并注册：`connections.register(conn)`。
    - 发送 connected：[`buildConnectedMessage()`](../gateway/src/auth.ts:69)
    - 说明：WS 连接成功后当前不再触发任何“外部控制 enable/disable”流程（不调用 `deps.astr.setExternalControl(token, true/false)`，也不再有 `externalControlReassertTimer` 的二次确认）。
    - 断开降级命令：`triggerDisconnectDegrade` 会向后端发 `do_something/go_home_and_sleep`（调用 [`AstrTownClient.postCommand()`](../gateway/src/astrtownClient.ts:109)）。
    - 心跳：[`startHeartbeat()`](../gateway/src/wsHandler.ts:458)
      - 周期发送 ping；若超过 timeout 未收到 pong 则触发 onTimeout 关闭连接。
      - 收到 pong 时记录 `heartbeatLatencyMs`。
    - message handler：
      - `pong`：更新 lastPongAt 与 `hb.onPong`。
      - `event.ack`：调用 [`EventDispatcher.onAck()`](../gateway/src/eventDispatcher.ts:26)。
      - `command.*`：调用 [`CommandRouter.handle()`](../gateway/src/commandRouter.ts:77)。
      - 异常：记录 error，并尽力发送 `command.ack rejected`。
    - close handler：
      - 判断是否为被重连驱逐的旧 socket（`_evictedByReconnect`）以及是否为当前 socket。
      - 若是当前 socket 且非驱逐：
        - 触发断开降级命令；
        - dispatcher.onDisconnect；commandQueue.clearAgent；queues.delete；connections.unregisterByToken。
      - 否则仅 best-effort `unregisterByToken`，避免误删新连接资源。
      - 停止心跳；更新连接计数与关闭计数。

- 文件内部关系
  - `safeSendEarly` 用于握手阶段快速失败回包。
  - `safeSend` 用于认证后阶段回包，发送失败会主动 close。
  - `startHeartbeat` 将 ping/pong 与 timeout 逻辑封装成小模块。

- 文件间关系
  - 连接表：[`ConnectionManager`](../gateway/src/connectionManager.ts:11)。
  - 命令路径：[`CommandRouter`](../gateway/src/commandRouter.ts:17) 与 [`CommandQueue`](../gateway/src/commandQueue.ts:23)。
  - 事件路径：[`EventDispatcher`](../gateway/src/eventDispatcher.ts:15)。
   - AstrTown 后端：[`AstrTownClient`](../gateway/src/astrtownClient.ts:49)（validateToken、postCommand）。
## 4. 模块关系图（文字版依赖关系）

### 4.1 依赖总览（按方向）

- 入口组装：[`gateway/src/index.ts`](../gateway/src/index.ts)
  - → 配置：[`loadConfig()`](../gateway/src/config.ts:45)
  - → 客户端：[`AstrTownClient`](../gateway/src/astrtownClient.ts:49)
  - → 连接：[`ConnectionManager`](../gateway/src/connectionManager.ts:11)
  - → 命令：[`createDefaultCommandMapper()`](../gateway/src/commandMapper.ts:62) → [`CommandMapper`](../gateway/src/commandMapper.ts:31)
  - → 队列：[`CommandQueue`](../gateway/src/commandQueue.ts:23)
  - → 命令路由：[`CommandRouter`](../gateway/src/commandRouter.ts:17)
  - → 事件：[`BotQueueRegistry`](../gateway/src/queueRegistry.ts:6) → [`EventQueue`](../gateway/src/eventQueue.ts:27)
  - → 分发：[`EventDispatcher`](../gateway/src/eventDispatcher.ts:15)
  - → 路由注册：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)、[`registerHttpRoutes()`](../gateway/src/routes.ts:14)

### 4.2 命令链路依赖

- WS 入站 `command.*` → [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37) message handler
  - → [`CommandRouter.handle()`](../gateway/src/commandRouter.ts:142)
    - → [`CommandQueue.enqueue()`](../gateway/src/commandQueue.ts:32) 串行
    - → 分流：
      - 社交关系命令（`command.propose_relationship` / `command.respond_relationship`）在 gateway 本地处理：
        - 目标在线检查：[`ConnectionManager.getByPlayerId()`](../gateway/src/connectionManager.ts:28)
        - 关系写回（accept 时）：[`AstrTownClient.upsertRelationship()`](../gateway/src/astrtownClient.ts:231)
        - 社交事件投递：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:44)
      - 其他命令透传：[`CommandMapper`](../gateway/src/commandMapper.ts:33) + [`AstrTownClient.postCommand()`](../gateway/src/astrtownClient.ts:117) / [`AstrTownClient.postCommandBatch()`](../gateway/src/astrtownClient.ts:165)
    - → 指标：[`commandsTotal`](../gateway/src/metrics.ts:21)、[`commandLatencyMs`](../gateway/src/metrics.ts:27)
  - → WS 回包 `command.ack`

### 4.3 事件链路依赖

- HTTP 入站 `/gateway/event` → [`registerHttpRoutes()`](../gateway/src/routes.ts:14)
  - → [`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:25)
  - → [`buildWsWorldEvent()`](../gateway/src/httpRoutes.ts:72)
  - → [`classifyPriority()`](../gateway/src/queueRegistry.ts:25)
  - → 幂等：[`IdempotencyCache`](../gateway/src/utils.ts:4)
  - → 入队：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37)
    - → per-agent queue：[`BotQueueRegistry.get()`](../gateway/src/queueRegistry.ts:11) → [`EventQueue.enqueue()`](../gateway/src/eventQueue.ts:35)
    - → 触发投递：[`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48)
      - → 订阅过滤：[`createSubscriptionMatcher()`](../gateway/src/subscription.ts:6)
      - → WS send
      - → 等待 `event.ack`：WS message handler → [`EventDispatcher.onAck()`](../gateway/src/eventDispatcher.ts:26)
      - → 超时重试：基于 `ackPlan`（来自 [`loadConfig()`](../gateway/src/config.ts:45)）

## 5. 数据流分析

### 5.1 WebSocket 连接建立数据流

1. 客户端连接 `/ws/bot?token=...&v=min-max&subscribe=...`（见 [`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)）。
2. gateway 解析版本范围并协商：[`parseVersionRange()`](../gateway/src/auth.ts:28) → [`negotiateVersion()`](../gateway/src/auth.ts:40)。
3. gateway 校验 token：调用 [`AstrTownClient.validateToken()`](../gateway/src/astrtownClient.ts:58)。
4. 构造会话：`BotSession`（见 [`types.ts`](../gateway/src/types.ts:267)），注册到 [`ConnectionManager`](../gateway/src/connectionManager.ts:11)。
5. 发送 connected：[`buildConnectedMessage()`](../gateway/src/auth.ts:69)。
6. 说明：当前 WebSocket 连接建立后不再调用任何“外控开关”接口（不调用 `deps.astr.setExternalControl(token, true/false)`；也不再存在 `externalControlReassertTimer` 二次确认）。

### 5.2 命令下发数据流（WS → HTTP/本地分支）

1. 客户端发送 `command.*`（或 `command.batch`）消息。
2. WS handler 解析后调用 [`CommandRouter.handle()`](../gateway/src/commandRouter.ts:142)。
3. CommandRouter 将命令封装为 `CommandQueueItem`，入 [`CommandQueue.enqueue()`](../gateway/src/commandQueue.ts:32)。
4. 队列串行执行并分流：
   - 社交关系命令（`propose_relationship/respond_relationship`）走本地分支：
     - 参数校验；
     - 通过 [`ConnectionManager.getByPlayerId()`](../gateway/src/connectionManager.ts:28) 检查目标在线；
     - `respond_relationship` 在 `accept=true` 时调用 [`AstrTownClient.upsertRelationship()`](../gateway/src/astrtownClient.ts:231) 写回关系；
     - 通过 [`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:44) 投递 `social.relationship_proposed` / `social.relationship_responded`。
   - 非社交命令：构造 idempotencyKey，调用 [`AstrTownClient.postCommand()`](../gateway/src/astrtownClient.ts:117) 或 [`AstrTownClient.postCommandBatch()`](../gateway/src/astrtownClient.ts:165)。
5. gateway 回 `command.ack`（语义 `ackSemantics:'queued'`，见 [`CommandAck`](../gateway/src/types.ts:231) 与 [`safeAckSend()`](../gateway/src/commandRouter.ts:74)）。

### 5.3 世界事件分发数据流（HTTP → WS）

1. 上游向 `/gateway/event` POST 推送事件。
2. gateway 鉴权与幂等：`gatewaySecret` + [`IdempotencyCache`](../gateway/src/utils.ts:4)。
3. gateway 解析与标准化：[`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:25) → [`buildWsWorldEvent()`](../gateway/src/httpRoutes.ts:72)。
4. 优先级选择：[`classifyPriority()`](../gateway/src/queueRegistry.ts:25)。
5. 入队并触发投递：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37) → [`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48)。
6. EventDispatcher 发送事件到 WS 并等待 `event.ack`：
   - 客户端回 `event.ack` → WS handler → [`EventDispatcher.onAck()`](../gateway/src/eventDispatcher.ts:26)。
   - 若 ack 超时则重试；超过最大重试则丢弃。

### 5.4 命令完成信号联动（事件 → 命令队列）

当 HTTP 收到 `action.finished` 事件时，会检查该 agent 是否有 inflight 命令并调用 [`CommandQueue.complete()`](../gateway/src/commandQueue.ts:46) reason=`action.finished`（见 [`registerHttpRoutes()`](../gateway/src/routes.ts:14) 中对应分支）。

这让命令队列除了“后端接受即完成（accepted）”外，还能在未来扩展为“等待引擎侧完成事件”再推进（文件内也保留了注释说明该扩展点）。

## 6. 关键算法

### 6.1 协议版本协商（Auth）

- 输入：客户端版本范围（[`parseVersionRange()`](../gateway/src/auth.ts:28)）与服务端支持版本列表（来自 config，入口处注入到 WS handler）。
- 核心：[`negotiateVersion()`](../gateway/src/auth.ts:40)
  - 取交集 acceptable。
  - 无交集则拒绝连接并返回 `supportedVersions`。
  - 有交集选取最大可接受版本作为协商结果。

### 6.2 per-agent 命令串行队列（CommandQueue）

- 数据结构：
  - `pendingByAgent: Map<agentId, CommandQueueItem[]>`
  - `inflightByAgent: Map<agentId, InflightCommand>`
- 调度：[`drain()`](../gateway/src/commandQueue.ts:92)
  - 若 agent 已 inflight 则不并发执行。
  - pending shift 成 inflight（关键注释避免 complete 时误删下一条）。
  - timer 超时自动 complete。
  - execute 返回 accepted/rejected 驱动 complete。

该设计确保：同一 agent 的命令严格按序执行，且能在网络/后端异常时通过 timeout 释放 inflight，避免队列永久卡死。

### 6.3 分优先级事件队列 + ACK 重试（EventQueue + EventDispatcher）

- 队列：[`EventQueue`](../gateway/src/eventQueue.ts:27)
  - 4 个优先级队列（0 最优）。
  - `peekNextReady` 同时处理过期丢弃（expired）与重试时间窗（nextAttemptAt）。
- 分发器：[`EventDispatcher`](../gateway/src/eventDispatcher.ts:15)
  - “取一个就绪事件 → 发送 → 记 inflight → 等 ack”。
  - ack 超时：指数/阶梯 backoff（来自 `ackPlan.backoffMs`），重入队并增加 attempts。
  - 超过 maxRetries：移除队列项并记录失败。
  - 订阅过滤：用 [`createSubscriptionMatcher()`](../gateway/src/subscription.ts:6) 判断 `event.type` 是否应该投递给该连接。

### 6.4 HTTP 入站事件的兼容解析（parseIncomingWorldEvent）

- 目标：兼容新旧字段命名，减少上游变更对 gateway 的影响。
- 实现：[`parseIncomingWorldEvent()`](../gateway/src/httpRoutes.ts:25)
  - `legacyAgentId` 回填 `eventAgentId/targetAgentId`。
  - `legacyEventTs` 推导 `expiresAt`（+60s）。
  - `payload` 支持 `payload` 或旧字段 `eventData`。

---

## 附：跨文件“主路径”索引

- 入口组装：[`gateway/src/index.ts`](../gateway/src/index.ts)
- WS：[`registerWsRoutes()`](../gateway/src/wsHandler.ts:37)
- HTTP：[`registerHttpRoutes()`](../gateway/src/routes.ts:14)
- 命令：[`CommandRouter.handle()`](../gateway/src/commandRouter.ts:142) + [`CommandQueue`](../gateway/src/commandQueue.ts:23) + [`AstrTownClient.postCommand()`](../gateway/src/astrtownClient.ts:117) / [`AstrTownClient.upsertRelationship()`](../gateway/src/astrtownClient.ts:231)
- 事件：[`enqueueWorldEvent()`](../gateway/src/queueRegistry.ts:37) + [`EventDispatcher.tryDispatch()`](../gateway/src/eventDispatcher.ts:48) + `event.ack` → [`EventDispatcher.onAck()`](../gateway/src/eventDispatcher.ts:26)

# AstrTown 插件模块架构分析

## 1. 模块概述

### 1.1 功能定位

`astrbot_plugin_astrtown` 是 AstrBot 的平台适配插件，通过 Gateway 将 AstrTown 游戏世界抽象为消息平台，使 AstrBot 能够控制 NPC 并接收游戏事件。

### 1.2 架构位置

```
AstrBot 主程序
    ↓
AstrTownPlugin (Star 插件)
    ↓
AstrTownAdapter (平台适配器)
    ↓
Gateway (WebSocket/HTTP)
    ↓
AstrTown 游戏世界
```

### 1.3 核心概念

- **Star 插件**: AstrBot 的插件系统，提供 LLM 工具和事件处理能力
- **Platform 适配器**: 将外部平台抽象为消息平台，接收事件并投递到 AstrBot 事件总线
- **Gateway**: AstrTown 的网关服务，提供 WebSocket 和 HTTP API
- **指令驱动对话**: 引擎侧不内置自主 NPC/LLM prompt 拼接；对话内容由外部插件下发 `say`/`externalBotSendMessage` 等指令产生
- **记忆存取接口**: 引擎仍保留深层记忆检索链路（如 `agentRememberConversation`）；插件可调用该能力用于“回忆/检索”，但对话生成仍由插件侧负责
- **协议建模**: 使用 TypedDict 和 dataclass 定义 WebSocket 消息结构

---

## 2. 文件清单

| 文件路径 | 行数 | 字符数 | 功能描述 |
|---------|------|--------|----------|
| [`astrbot_plugin_astrtown/__init__.py`](astrbot_plugin_astrtown/__init__.py) | 10 | 228 | 包初始化，导出 AstrTownPlugin |
| [`astrbot_plugin_astrtown/_conf_schema.json`](astrbot_plugin_astrtown/_conf_schema.json) | 30 | 860 | 配置项元数据定义 |
| [`astrbot_plugin_astrtown/main.py`](astrbot_plugin_astrtown/main.py) | 513 | 21002 | 插件主入口：上下文裁剪、动态记忆/社交张力注入、生命周期注入反思回调、LLM 工具定义 |
| [`astrbot_plugin_astrtown/metadata.yaml`](astrbot_plugin_astrtown/metadata.yaml) | 6 | 279 | 插件元数据 |
| [`astrbot_plugin_astrtown/SKILL.md`](astrbot_plugin_astrtown/SKILL.md) | 128 | 2814 | NPC 行为指导文档 |
| [`astrbot_plugin_astrtown/adapter/__init__.py`](astrbot_plugin_astrtown/adapter/__init__.py) | 6 | 189 | 适配器包初始化 |
| [`astrbot_plugin_astrtown/adapter/astrtown_adapter.py`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py) | 1738 | 69290 | 平台适配器核心实现：WS 事件分发、社交事件处理、会话反思与高阶反思异步流水线 |
| [`astrbot_plugin_astrtown/adapter/astrtown_event.py`](astrbot_plugin_astrtown/adapter/astrtown_event.py) | 31 | 766 | 消息事件类定义 |
| [`astrbot_plugin_astrtown/adapter/id_util.py`](astrbot_plugin_astrtown/adapter/id_util.py) | 5 | 98 | ID 生成工具函数 |
| [`astrbot_plugin_astrtown/adapter/protocol.py`](astrbot_plugin_astrtown/adapter/protocol.py) | 126 | 2541 | WebSocket 协议数据模型 |

**总计**: 10 个文件，2593 行，98067 字符

---

## 3. 文件详细分析

### 3.1 [`astrbot_plugin_astrtown/__init__.py`](astrbot_plugin_astrtown/__init__.py)

#### 文件基本信息
- **功能**: 包初始化，导出插件主类
- **行数**: 10 行
- **字符数**: 228 字符

#### 导入的模块
```python
from .main import AstrTownPlugin
```

#### 导出的内容
- `AstrTownPlugin`: 插件主类

#### 文件说明
简单的包初始化文件，仅导出 [`AstrTownPlugin`](astrbot_plugin_astrtown/main.py:20) 类供 AstrBot 插件系统加载。

---

### 3.2 [`astrbot_plugin_astrtown/_conf_schema.json`](astrbot_plugin_astrtown/_conf_schema.json)

#### 文件基本信息
- **功能**: 配置项元数据定义
- **行数**: 30 行
- **字符数**: 860 字符

#### 配置项定义

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `astrtown_invite_decision_mode` | string | `auto_accept` | 邀请决策模式：自动接受/LLM 判断 |
| `astrtown_refill_wake_enabled` | bool | `true` | 队列补充唤醒开关 |
| `astrtown_refill_min_wake_interval_sec` | int | `30` | 队列补充最小唤醒间隔（秒） |
| `astrtown_max_context_rounds` | int | `50` | 最大上下文轮数 |

#### 文件说明
定义了插件的可配置项及其元数据，包括类型、默认值和提示信息。这些配置项在 [`main.py`](astrbot_plugin_astrtown/main.py) 中被读取和使用。

---

### 3.3 [`astrbot_plugin_astrtown/main.py`](astrbot_plugin_astrtown/main.py)

#### 文件基本信息
- **功能**: 插件主入口，负责 LLM 请求前上下文处理、生命周期注入/清理反思回调、以及 AstrTown 侧工具定义。
- **行数**: 513 行
- **字符数**: 21002 字符

#### 导入的模块
```python
from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlencode, urlparse

from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.core.config.default import CONFIG_METADATA_2
from astrbot.core.star.register.star_handler import register_on_llm_request
from astrbot.api import logger
```
- 可选依赖：`aiohttp`（失败时置 `None`，相关网络增强逻辑自动降级）。

#### 导出的内容
- `AstrTownPlugin`: 插件主类。

#### 定义的类

##### [`AstrTownPlugin`](astrbot_plugin_astrtown/main.py:20)
继承自 `Star`，承担插件级配置注入、LLM 请求钩子与工具注册。

**类属性**:
- `_registered: bool`: 平台配置元数据是否已注入。

**实例属性**:
- `config: dict`: 插件配置。
- `_injected_config_keys: set[str]`: 已注入配置键集合。

**关键方法**:

1. [`_astrtown_trim_context_and_inject_memory()`](astrbot_plugin_astrtown/main.py:24)
   - **装饰器**: `@register_on_llm_request(priority=100)`。
   - **功能**: 在每次 LLM 请求前做“上下文裁剪 + 动态记忆注入 + 动态社交张力注入”。
   - **实现逻辑**:
     - 读取 `astrtown_max_context_rounds`，得到 `max_messages = max_rounds * 2`。
     - 分离 `system` 与 `non-system`，仅保留最近非系统消息。
     - 从最近消息中提取最新 user 文本，调用 [`search_world_memory()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1573) 检索（`asyncio.wait_for(..., timeout=2.0)` 熔断）。
     - 通过适配器 `_conversation_partner_id` 与事件 payload 推断会话对方，调用 `GET /api/bot/social/state` 拉取关系/好感数据。
     - 注入 system context：
       - 记忆片段（潜意识背景）；
       - 社交张力设定（公开关系 + 私下好感）。
     - 最终回写 `request.contexts = system + injected + recent`。

2. [`__init__()`](astrbot_plugin_astrtown/main.py:229)
   - 调用父类初始化。
   - 保存配置。
   - 导入 [`AstrTownAdapter`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:85) 以触发平台装饰器注册。

3. [`_register_config()`](astrbot_plugin_astrtown/main.py:236)
   - 将 [`_astrtown_items`](astrbot_plugin_astrtown/main.py:205) 注入 `CONFIG_METADATA_2.platform_group.metadata.platform.items`。

4. [`_unregister_config()`](astrbot_plugin_astrtown/main.py:262)
   - 从配置元数据中清除本插件注入项。

5. [`initialize()`](astrbot_plugin_astrtown/main.py:287)
   - 注册配置项。
   - 读取默认人格 prompt，调用 [`set_persona_data()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:40) 注入适配器全局 persona。
   - 注入反思 LLM 回调：调用 [`set_reflection_llm_callback()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:54)，将 provider 的 `text_chat` 封装为异步回调供适配器后台反思任务复用。

6. [`terminate()`](astrbot_plugin_astrtown/main.py:331)
   - 调用 [`set_reflection_llm_callback()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:54) 传入 `None` 清理全局回调。
   - 注销配置元数据。

#### 定义的 LLM 工具

- 记忆检索：[`recall_past_memory()`](astrbot_plugin_astrtown/main.py:345)
  - 调用 [`search_world_memory()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1573) 进行深度回忆。
- 基础行为工具：[`move_to()`](astrbot_plugin_astrtown/main.py:363)、[`say()`](astrbot_plugin_astrtown/main.py:379)、[`set_activity()`](astrbot_plugin_astrtown/main.py:403)、[`accept_invite()`](astrbot_plugin_astrtown/main.py:427)、[`invite()`](astrbot_plugin_astrtown/main.py:443)、[`leave_conversation()`](astrbot_plugin_astrtown/main.py:459)、[`do_something()`](astrbot_plugin_astrtown/main.py:499)。
- 新增社交关系工具：
  - [`propose_relationship()`](astrbot_plugin_astrtown/main.py:475) → `command.propose_relationship`
  - [`respond_relationship()`](astrbot_plugin_astrtown/main.py:487) → `command.respond_relationship`

#### 文件内部关系
- [`_astrtown_items`](astrbot_plugin_astrtown/main.py:205) 为配置元数据来源。
- [`_astrtown_trim_context_and_inject_memory()`](astrbot_plugin_astrtown/main.py:24) 同时依赖 `adapter.search_world_memory` 与 `/api/bot/social/state` 结果，统一构建注入上下文。
- 所有工具最终通过 [`send_command()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:214) 与网关交互。

#### 文件间关系
- 强依赖 [`AstrTownAdapter`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:85) 的命令发送、记忆检索、HTTP 基地址推导能力。
- 生命周期中调用 [`set_persona_data()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:40) 与 [`set_reflection_llm_callback()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:54)，形成“插件注入能力 → 适配器异步任务消费能力”的桥接。

---

### 3.4 [`astrbot_plugin_astrtown/metadata.yaml`](astrbot_plugin_astrtown/metadata.yaml)

#### 文件基本信息
- **功能**: 插件元数据
- **行数**: 6 行
- **字符数**: 279 字符

#### 元数据字段
```yaml
name: astrbot-plugin-astrtown
desc: "AstrTown 平台适配插件，通过 Gateway 让 AstrBot 控制 NPC 并接收事件"
author: AstrTown
version: "0.1.0"
repo: https://github.com/your-org/astrbot_plugin_astrtown
```

#### 文件说明
定义了插件的基本信息，供 AstrBot 插件管理器识别和展示。

---

### 3.5 [`astrbot_plugin_astrtown/SKILL.md`](astrbot_plugin_astrtown/SKILL.md)

#### 文件基本信息
- **功能**: NPC 行为指导文档
- **行数**: 120 行
- **字符数**: 2405 字符

#### 新增最高行为准则（与深层记忆网络强绑定）
- 在文档首个标题之后新增章节：`🚨 【最高行为准则：记忆生成的绝对法则】`
- 核心约束：当 NPC 认为当前话题告一段落/对方告别/准备去执行物理动作（移动、工作）前，**必须主动调用** [`leave_conversation()`](astrbot_plugin_astrtown/main.py:459) 退出当前对话
- 目的：只有显式退出对话，底层“记忆回溯与反思”算法才会被触发，从而把当前对话归档为长期深层记忆；避免长时间停留在对话中导致记忆无法沉淀

#### 文档结构

1. **最高行为准则**（记忆生成的绝对法则）
   - “话题告一段落就离开对话”以触发记忆回溯

2. **事件类型**（会收到的消息）
   - `conversation.invited`: 对话邀请
   - `conversation.message`: 对话消息
   - `agent.state_changed`: 状态变化
   - `action.finished`: 动作完成

3. **工具**（可以调用的动作）
   - `set_activity()`: 设置活动状态
   - `accept_invite()`: 接受邀请
   - `say()`: 发送消息
   - `move_to()`: 移动
   - `do_something()`: 底层动作
   - `leave_conversation()`: 退出对话（用于触发记忆生成）

4. **推荐工作流**
   - 收到邀请的处理流程
   - 收到消息的处理流程
   - 状态变化时的处理流程

5. **输出规范**
   - 必须通过工具调用发送消息
   - 离开对话前必须先说话

#### 文件说明
为 LLM 提供了在 AstrTown 世界中行为指导，包括事件处理、工具使用和工作流程；并通过“最高行为准则”将对话退出与长期记忆生成流程绑定。

---

### 3.6 [`astrbot_plugin_astrtown/adapter/__init__.py`](astrbot_plugin_astrtown/adapter/__init__.py)

#### 文件基本信息
- **功能**: 适配器包初始化
- **行数**: 6 行
- **字符数**: 189 字符

#### 导入的模块
```python
from .astrtown_adapter import AstrTownAdapter
from .astrtown_event import AstrTownMessageEvent
```

#### 导出的内容
- `AstrTownAdapter`: 平台适配器类
- `AstrTownMessageEvent`: 消息事件类

#### 文件说明
适配器包的初始化文件，导出核心类供外部使用。

---

### 3.7 [`astrbot_plugin_astrtown/adapter/astrtown_adapter.py`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py)

#### 文件基本信息
- **功能**: 平台适配器核心实现（WS 连接、事件分发、社交事件系统消息化、异步反思流水线）。
- **行数**: 1738 行
- **字符数**: 69290 字符

#### 导入的模块
```python
from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from astrbot import logger
from astrbot.api.message_components import Plain
from astrbot.api.platform import (
    AstrBotMessage,
    MessageMember,
    MessageType,
    Platform,
    PlatformMetadata,
    register_platform_adapter,
)
from .protocol import (
    AuthErrorMessage,
    AuthErrorPayload,
    CommandAck,
    CommandAckPayload,
    ConnectedMessage,
    ConnectedPayload,
    WorldEvent,
)
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed
from .astrtown_event import AstrTownMessageEvent
from .id_util import new_id
```

#### 导出的内容
- `AstrTownAdapter`: 平台适配器类
- `set_persona_data()`: 设置 persona 数据
- `get_persona_data()`: 获取 persona 数据
- `set_reflection_llm_callback()`: 设置反思 LLM 回调
- `get_reflection_llm_callback()`: 获取反思 LLM 回调

#### 全局变量
- `_PERSONA_DESCRIPTION: str | None`: 全局 persona 描述
- `ReflectLLMCallback = Callable[[str], Awaitable[Any]]`: 反思回调类型别名
- `_REFLECTION_LLM_CALLBACK: ReflectLLMCallback | None`: 全局反思回调句柄

#### 定义的函数

##### [`set_persona_data(description)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:40)
- **功能**: 设置全局 persona 描述
- **参数**: `description: str`
- **实现**: 更新全局变量 `_PERSONA_DESCRIPTION`

##### [`get_persona_data()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:46)
- **功能**: 获取全局 persona 描述
- **返回**: `str | None`

##### [`set_reflection_llm_callback(callback)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:54)
- **功能**: 注册/清理反思 LLM 回调（`None` 表示清理）
- **参数**: `callback: ReflectLLMCallback | None`

##### [`get_reflection_llm_callback()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:59)
- **功能**: 获取当前反思回调句柄
- **返回**: `ReflectLLMCallback | None`

#### 定义的类

##### [`AstrTownAdapter`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:85)
继承自 `Platform`，是 AstrTown 平台适配器的核心类。

**装饰器**:
```python
@register_platform_adapter(
    "astrtown",
    "AstrTown 适配器 - 通过 Gateway 将游戏世界抽象为消息平台",
    default_config_tmpl={
        "astrtown_gateway_url": "http://localhost:40010",
        "astrtown_token": "",
        "astrtown_ws_reconnect_min_delay": 1,
        "astrtown_ws_reconnect_max_delay": 30,
    },
)
```

**实例属性**:
- `settings: dict`: 平台设置
- `_session_event_count: dict[str, int]`: 会话事件计数器
- `_active_conversation_id: str | None`: 当前活跃对话 ID
- `_conversation_partner_id: str | None`: 当前会话对方 playerId（供动态社交张力注入与反思使用）
- `gateway_url: str`: Gateway 地址
- `token: str`: 鉴权 Token
- `subscribe: str`: 订阅事件（固定为 "*"）
- `protocol_version_range: str`: 协议版本范围（固定为 "1-1"）
- `reconnect_min_delay: int`: 最小重连延迟
- `reconnect_max_delay: int`: 最大重连延迟
- `_metadata: PlatformMetadata`: 平台元数据
- `_tasks: list[asyncio.Task]`: 异步任务列表
- `_stop_event: asyncio.Event`: 停止事件
- `_ws`: WebSocket 连接对象
- `_pending_commands: dict[str, asyncio.Future[CommandAckPayload]]`: 待确认命令字典
- `_agent_id: str | None`: Agent ID
- `_player_id: str | None`: 玩家 ID
- `_world_id: str | None`: 世界 ID
- `_player_name: str | None`: 玩家名称
- `_negotiated_version: int | None`: 协商的协议版本
- `_last_refill_wake_ts: float`: 上次队列补充唤醒时间戳
- `_queue_refill_gate_last_log_ts: float`: queue_refill 门控日志节流时间
- `_queue_refill_gate_last_should_wake: bool | None`: 上次门控状态
- `_queue_refill_gate_skip_count: int`: 连续跳过计数
- `_event_ack_last_log_ts: float`: ACK 采样日志时间
- `_event_ack_sample_count: int`: ACK 采样计数
- `_importance_accumulator: float`: 反思重要度累计值
- `_reflection_threshold: float`: 触发高阶反思阈值

**方法**:

1. [`__init__()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:86)
   - **功能**: 初始化适配器
   - **参数**:
     - `platform_config: dict`: 平台配置
     - `platform_settings: dict`: 平台设置
     - `event_queue: asyncio.Queue`: 事件队列
   - **实现**:
     - 调用父类初始化
     - 初始化各属性
     - 解析配置项

2. [`meta()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:133)
   - **功能**: 返回平台元数据
   - **返回**: `PlatformMetadata`

3. [`run()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:136)
   - **功能**: 启动适配器
   - **返回**: `Coroutine[Any, Any, None]`
   - **实现**: 返回 `_run()` 协程

4. [`_run()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:139)
   - **功能**: 运行适配器主循环
   - **实现**:
     - 检查 token 配置
     - 创建 WebSocket 循环任务
     - 等待任务完成

5. [`terminate()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:155)
   - **功能**: 终止适配器
   - **实现**:
     - 设置停止事件
     - 取消待确认命令
     - 取消所有任务
     - 关闭 WebSocket 连接

6. [`get_binding()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:175)
   - **功能**: 获取绑定信息
   - **返回**: `dict[str, str | int | None]`
   - **实现**: 返回 agentId、playerId、worldId、playerName、protocolVersion

7. [`send_command(msg_type, payload)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:184)
   - **功能**: 发送命令到 Gateway
   - **参数**:
     - `msg_type: str`: 消息类型
     - `payload: dict[str, Any]`: 消息载荷
   - **返回**: `dict[str, Any]`
   - **实现逻辑**:
     - 生成 command_id
     - 创建 Future 对象
     - 发送 JSON 消息
     - 等待 ACK（3 秒超时）
     - 处理 ACK 结果

8. [`_build_ws_connect_url()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:244)
   - **功能**: 构建 WebSocket 连接 URL
   - **返回**: `str`
   - **实现**:
     - 转换 HTTP/HTTPS 为 WS/WSS
     - 添加查询参数（token、v、subscribe）

9. [`_mask_ws_url_for_log(url)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:261)
   - **功能**: 屏蔽 WebSocket URL 中的敏感信息（token）
   - **参数**: `url: str`
   - **返回**: `str`

10. [`_safe_int(value, default, field, msg_type)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:278)
    - **功能**: 安全地转换为整数
    - **参数**:
      - `value: Any`: 待转换值
      - `default: int`: 默认值
      - `field: str`: 字段名（用于日志）
      - `msg_type: str`: 消息类型（用于日志）
    - **返回**: `int`

11. [`_ws_loop()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:286)
    - **功能**: WebSocket 连接循环（带重连）
    - **实现**:
      - 指数退避重连策略
      - 添加随机抖动
      - 捕获异常并记录日志

12. [`_ws_connect_once()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:306)
    - **功能**: 建立一次 WebSocket 连接
    - **实现**:
      - 连接到 Gateway
      - 接收并处理消息
      - 清理连接状态

13. [`_handle_ws_message(data)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:370)
    - **功能**: 处理 WebSocket 消息
    - **参数**: `data: dict[str, Any]`
    - **实现**:
      - 根据 `type` 字段分发到不同处理器
      - 支持 `ping`、`connected`、`auth_error`、`command.ack`、世界事件

14. [`_handle_ping(data)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:477)
    - **功能**: 处理 ping 消息
    - **参数**: `data: dict[str, Any]`
    - **实现**: 发送 pong 响应

15. [`_handle_world_event(data)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529)
    - **功能**: 处理世界事件
    - **参数**: `data: dict[str, Any]`
    - **实现逻辑**:
      - 解析事件数据。
      - `conversation.message` 前置过滤：不属于 `_active_conversation_id` 的消息仅 ACK 不唤醒。
      - 会话状态维护：`conversation.started/ended/timeout` 更新 `_active_conversation_id`。
      - 会话对方追踪：在 `conversation.message`（speaker）、`conversation.invited`（inviter）、`conversation.started`（other ids）维护 `_conversation_partner_id`。
      - `conversation.ended`：提取对话记录并异步触发 [`_async_reflect_on_conversation()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1304)。
      - `conversation.timeout`：转系统消息提交到 AstrBot，并强制唤醒 LLM。
      - `social.relationship_proposed`：转系统提示并注入 `proposer_id/relationship_status/priority=high`，强制唤醒 LLM 进行 `respond_relationship` 决策。
      - `social.relationship_responded`：转系统提示并注入 `responder_id/relationship_status/relationship_accept`，强制唤醒 LLM 做后续反应。
      - `agent.queue_refill_requested`：按最小间隔门控，静默丢弃路径只 ACK。
      - `action.finished`：记录过期动作告警（`success=false & result.reason='expired'`）。
      - 通用路径：格式化文本 → 构建 session id → commit_event → 发送 event ACK。

16. [`_send_event_ack(event_id)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1039)
    - **功能**: 发送事件 ACK
    - **参数**: `event_id: str`
    - **实现**: 发送 `event.ack` 消息

17. [`_build_session_id(_event_type, payload)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1528)
    - **功能**: 构建会话 ID
    - **参数**:
      - `_event_type: str`: 事件类型
      - `payload: dict[str, Any]`: 事件载荷
    - **返回**: `str`
    - **实现逻辑**:
      - 根据 `unique_session` 设置决定会话隔离级别
      - `unique_session=False`: 按 world 隔离
      - `unique_session=True`: 按 world + player 隔离

18. [`_build_http_base_url()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1552)
   - **功能**: 将 `self.gateway_url` 规范化为 http/https base url（兼容 ws/wss 误配）
   - **返回**: `str`
   - **实现逻辑**:
     - `wss://...` → `https://...`
     - `ws://...` → `http://...`
     - 解析失败时 best-effort 回退为原字符串

19. [`search_world_memory(query_text, limit=3)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1573)
   - **功能**: 向 Gateway 发起“世界记忆检索”HTTP 请求，返回记忆片段列表（任何异常/非 2xx 统一降级为空列表）
   - **HTTP**: `POST /api/bot/memory/search`
   - **认证**: `Authorization: Bearer {token}`
   - **请求体**: `{ "queryText": <str>, "limit": <int> }`
   - **超时保护**: `aiohttp.ClientTimeout(total=3.0)`
   - **返回**: `list[dict]`（从响应 JSON 的 `memories` 字段提取，元素形如 `{description, importance}`）

20. [`_sync_persona_to_gateway(player_id)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1619)
   - **功能**: 将 persona 描述同步到 Gateway
   - **参数**: `player_id: str | None`
   - **实现**:
     - 通过 HTTP POST 发送 persona 描述
     - 使用 Bearer Token 认证

21. [`_format_event_to_text(event_type, payload)`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1662)
    - **功能**: 将事件格式化为文本（供 LLM 理解）
    - **参数**:
      - `event_type: str`: 事件类型
      - `payload: dict[str, Any]`: 事件载荷
    - **返回**: `str`
    - **实现**: 根据事件类型返回不同文本；已覆盖 `social.relationship_proposed` 与 `social.relationship_responded` 文案。

22. [`_pick_first_non_empty_str()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1069)
    - **功能**: 多候选键中提取首个非空字符串。

23. [`_extract_conversation_messages()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1079)
    - **功能**: 从结束事件 payload 中抽取标准化对话消息列表。

24. [`_build_reflection_prompt()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1111)
    - **功能**: 生成“会话反思”提示词，要求 JSON 输出 `summary/importance/affinity_delta/affinity_label`。

25. [`_normalize_reflection_response()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1159)
    - **功能**: 兼容解析 callback 输出（dict/字符串/completion_text），归一化并做数值范围约束。

26. [`_normalize_higher_reflection_response()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1238)
    - **功能**: 解析高阶反思返回的 insights 数组，去重并截断（最多 5 条）。

27. [`_post_json_best_effort()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1281)
    - **功能**: 统一 HTTP POST best-effort 封装，失败只记录告警并返回 `False`。

28. [`_async_reflect_on_conversation()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1304)
    - **功能**: 对话结束后异步反思任务。
    - **数据流**:
      - 读取全局 callback：[`get_reflection_llm_callback()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:59)。
      - LLM 反思 → 归一化结果。
      - 写入 `POST /api/bot/memory/inject`（conversation memory）。
      - 写入 `POST /api/bot/social/affinity`（好感度变化 + 标签）。
      - 累计 importance，达到阈值后触发 [`_async_higher_reflection()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1417)。

29. [`_async_higher_reflection()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1417)
    - **功能**: 高阶反思任务。
    - **数据流**:
      - 拉取 `GET /api/bot/memory/recent?worldId&playerId&count=50`。
      - callback 生成高层洞察 insights。
      - 循环写入 `POST /api/bot/memory/inject`（`memoryType='reflection'`，`importance=10`）。

#### 文件内部关系
- [`_PERSONA_DESCRIPTION`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:37) + [`set_persona_data()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:40)/[`get_persona_data()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:46) 管理 persona 全局数据。
- `_REFLECTION_LLM_CALLBACK` + [`set_reflection_llm_callback()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:54)/[`get_reflection_llm_callback()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:59) 管理反思回调句柄。
- [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529) 是事件总入口，触发普通事件投递与反思异步支线。
- 反思支线：`conversation.ended` -> [`_async_reflect_on_conversation()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1304) -> （阈值满足）[`_async_higher_reflection()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1417)。

#### 文件间关系
- 依赖 [`adapter.protocol`](astrbot_plugin_astrtown/adapter/protocol.py:1) 中的数据模型。
- 依赖 [`adapter.astrtown_event.AstrTownMessageEvent`](astrbot_plugin_astrtown/adapter/astrtown_event.py:6)。
- 依赖 [`adapter.id_util.new_id()`](astrbot_plugin_astrtown/adapter/id_util.py:4)。
- 依赖 AstrBot 框架 `Platform`、`AstrBotMessage` 等 API。
- 依赖 `websockets` 进行 WS 通信，`aiohttp` 进行 HTTP 通信（可选）。
- 与 [`main.py`](astrbot_plugin_astrtown/main.py:287) 双向协作：
  - `main` 在 initialize/terminate 注入并清理 reflection callback；
  - adapter 在异步反思任务中消费 callback。
- 与 gateway HTTP 交互端点：
  - `POST /api/bot/description/update`（persona 同步）
  - `POST /api/bot/memory/search`（记忆检索）
  - `POST /api/bot/memory/inject`（反思记忆写入）
  - `POST /api/bot/social/affinity`（好感回写）
  - `GET /api/bot/memory/recent`（高阶反思输入）

---

### 3.8 [`astrbot_plugin_astrtown/adapter/astrtown_event.py`](astrbot_plugin_astrtown/adapter/astrtown_event.py)

#### 文件基本信息
- **功能**: 消息事件类定义
- **行数**: 31 行
- **字符数**: 766 字符

#### 导入的模块
```python
from __future__ import annotations
from astrbot.api.event import AstrMessageEvent
```

#### 导出的内容
- `AstrTownMessageEvent`: AstrTown 消息事件类

#### 定义的类

##### [`AstrTownMessageEvent`](astrbot_plugin_astrtown/adapter/astrtown_event.py:6)
继承自 `AstrMessageEvent`，表示 AstrTown 世界事件。

**实例属性**:
- `_adapter`: 适配器引用
- `world_event: dict`: 原始世界事件数据

**方法**:
- [`__init__()`](astrbot_plugin_astrtown/adapter/astrtown_event.py:16): 初始化事件
- [`adapter`](astrbot_plugin_astrtown/adapter/astrtown_event.py:30) 属性: 返回适配器引用

#### 文件说明
定义了 AstrTown 特有的消息事件类，携带原始世界事件数据和适配器引用。

---

### 3.9 [`astrbot_plugin_astrtown/adapter/id_util.py`](astrbot_plugin_astrtown/adapter/id_util.py)

#### 文件基本信息
- **功能**: ID 生成工具函数
- **行数**: 5 行
- **字符数**: 98 字符

#### 导入的模块
```python
import uuid
```

#### 导出的内容
- `new_id()`: ID 生成函数

#### 定义的函数

##### [`new_id(prefix)`](astrbot_plugin_astrtown/adapter/id_util.py:4)
- **功能**: 生成带前缀的唯一 ID
- **参数**: `prefix: str`: ID 前缀
- **返回**: `str`: 格式为 `{prefix}_{uuid4_hex}` 的字符串，截取前 48 字符
- **实现**: 使用 `uuid.uuid4().hex` 生成 UUID

#### 文件说明
提供简单的 ID 生成工具，用于生成命令 ID、事件 ID 等。

---

### 3.10 [`astrbot_plugin_astrtown/adapter/protocol.py`](astrbot_plugin_astrtown/adapter/protocol.py)

#### 文件基本信息
- **功能**: WebSocket 协议数据模型
- **行数**: 120 行
- **字符数**: 2397 字符

#### 导入的模块
```python
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Literal, TypedDict
```

#### 导出的内容
- `Vector2`: 二维向量类型
- `WsMessageBase`: WebSocket 消息基类
- `WsWorldEventBase`: 世界事件消息基类
- `ConnectedPayload`: 连接成功载荷
- `ConnectedMessage`: 连接成功消息
- `AuthErrorPayload`: 认证错误载荷
- `AuthErrorMessage`: 认证错误消息
- `CommandAckPayload`: 命令确认载荷
- `CommandAck`: 命令确认消息
- `ActionFinishedPayload`: 动作完成载荷
- `ConversationMessagePayload`: 对话消息载荷
- `ConversationStartedPayload`: 对话开始载荷
- `AgentStateChangedPayload`: Agent 状态变化载荷
- `ConversationTimeoutPayload`: 对话超时兜底事件载荷（invite_timeout / idle_timeout），用于强制打破外控对话死等
- `WorldEvent`: 世界事件

#### 定义的类型

##### [`Vector2`](astrbot_plugin_astrtown/adapter/protocol.py:7)
```python
class Vector2(TypedDict):
    x: float
    y: float
```
二维坐标类型。

##### [`WsMessageBase`](astrbot_plugin_astrtown/adapter/protocol.py:12)
```python
class WsMessageBase(TypedDict, total=False):
    type: str
    id: str
    version: int
    timestamp: int
    payload: Any
    metadata: dict[str, Any]
```
WebSocket 消息基类。

##### [`WsWorldEventBase`](astrbot_plugin_astrtown/adapter/protocol.py:21)
```python
class WsWorldEventBase(WsMessageBase, total=False):
    expiresAt: int
```
世界事件消息基类。

#### 定义的数据类

##### [`ConnectedPayload`](astrbot_plugin_astrtown/adapter/protocol.py:26)
```python
@dataclass(frozen=True)
class ConnectedPayload:
    agentId: str
    playerId: str
    playerName: str
    worldId: str
    serverVersion: str
    negotiatedVersion: int
    supportedVersions: list[int]
    subscribedEvents: list[str]
```
连接成功时的载荷数据。

##### [`ConnectedMessage`](astrbot_plugin_astrtown/adapter/protocol.py:38)
```python
@dataclass(frozen=True)
class ConnectedMessage:
    type: Literal["connected"]
    id: str
    version: int
    timestamp: int
    payload: ConnectedPayload
```
连接成功消息。

##### [`AuthErrorPayload`](astrbot_plugin_astrtown/adapter/protocol.py:47)
```python
@dataclass(frozen=True)
class AuthErrorPayload:
    code: Literal[
        "INVALID_TOKEN",
        "TOKEN_EXPIRED",
        "NPC_NOT_FOUND",
        "ALREADY_CONNECTED",
        "VERSION_MISMATCH",
    ]
    message: str
    supportedVersions: list[int] | None = None
```
认证错误载荷。

##### [`AuthErrorMessage`](astrbot_plugin_astrtown/adapter/protocol.py:60)
```python
@dataclass(frozen=True)
class AuthErrorMessage:
    type: Literal["auth_error"]
    id: str
    version: int
    timestamp: int
    payload: AuthErrorPayload
```
认证错误消息。

##### [`CommandAckPayload`](astrbot_plugin_astrtown/adapter/protocol.py:69)
```python
@dataclass(frozen=True)
class CommandAckPayload:
    commandId: str
    status: Literal["accepted", "rejected"]
    ackSemantics: Literal["queued"] | None = None
    reason: str | None = None
    inputId: str | None = None
```
命令确认载荷。

##### [`CommandAck`](astrbot_plugin_astrtown/adapter/protocol.py:79)
```python
@dataclass(frozen=True)
class CommandAck:
    type: Literal["command.ack"]
    id: str
    timestamp: int
    payload: CommandAckPayload
```
命令确认消息。

##### [`ActionFinishedPayload`](astrbot_plugin_astrtown/adapter/protocol.py:87)
```python
@dataclass(frozen=True)
class ActionFinishedPayload:
    actionType: str
    success: bool
    result: Any
```
动作完成载荷。

##### [`ConversationMessagePayload`](astrbot_plugin_astrtown/adapter/protocol.py:94)
```python
@dataclass(frozen=True)
class ConversationMessagePayload:
    conversationId: str
    message: dict[str, Any]
```
对话消息载荷。

##### [`ConversationStartedPayload`](astrbot_plugin_astrtown/adapter/protocol.py:100)
```python
@dataclass(frozen=True)
class ConversationStartedPayload:
    conversationId: str
    otherParticipantIds: list[str]
```
对话开始载荷。

##### [`AgentStateChangedPayload`](astrbot_plugin_astrtown/adapter/protocol.py:106)
```python
@dataclass(frozen=True)
class AgentStateChangedPayload:
    state: str
    position: Any
    nearbyPlayers: Any
```
Agent 状态变化载荷。

##### [`WorldEvent`](astrbot_plugin_astrtown/adapter/protocol.py:113)
```python
@dataclass(frozen=True)
class WorldEvent:
    type: str
    id: str
    version: int
    timestamp: int
    expiresAt: int
    payload: dict[str, Any]
    metadata: dict[str, Any] | None = None
```
世界事件。

#### 文件说明
使用 TypedDict 和 dataclass 定义了完整的 WebSocket 协议数据模型，确保类型安全和数据结构清晰。

---

## 4. 模块关系图

### 4.1 文件依赖关系

```
astrbot_plugin_astrtown/
├── __init__.py
│   └── imports: main.AstrTownPlugin
│
├── main.py
│   ├── imports: adapter.astrtown_adapter.AstrTownAdapter
│   ├── lifecycle: set_persona_data() + set_reflection_llm_callback()/clear
│   ├── llm-hook: _astrtown_trim_context_and_inject_memory()
│   └── tools: recall/move/say/.../propose_relationship/respond_relationship
│
├── metadata.yaml
│   └── standalone: plugin metadata
│
├── _conf_schema.json
│   └── standalone: configuration schema
│
├── SKILL.md
│   └── standalone: NPC behavior guide
│
└── adapter/
    ├── __init__.py
    │   ├── imports: astrtown_adapter.AstrTownAdapter
    │   └── imports: astrtown_event.AstrTownMessageEvent
    │
    ├── astrtown_adapter.py
    │   ├── websocket: _ws_loop/_ws_connect_once/_handle_ws_message/_handle_world_event
    │   ├── reflection: _async_reflect_on_conversation/_async_higher_reflection
    │   ├── callback: get_reflection_llm_callback()
    │   └── http: /api/bot/memory/search|inject|recent + /api/bot/social/state|affinity
    │
    ├── astrtown_event.py
    │   └── depends: AstrBot framework (AstrMessageEvent)
    │
    ├── id_util.py
    │   └── standalone: ID generation utility
    │
    └── protocol.py
        └── standalone: WebSocket protocol data models
```

### 4.2 类继承关系

```
AstrMessageEvent (AstrBot framework)
    ↑
    |
AstrTownMessageEvent
    (adapter/astrtown_event.py)

Platform (AstrBot framework)
    ↑
    |
AstrTownAdapter
    (adapter/astrtown_adapter.py)

Star (AstrBot framework)
    ↑
    |
AstrTownPlugin
    (main.py)
```

### 4.3 模块交互流程

```
AstrBot 主程序
    ↓ 加载插件
AstrTownPlugin.initialize()
    ↓ 注入 persona + reflection callback
AstrTownAdapter (平台适配器)
    ↓ WS 连接 Gateway，接收 world event
_handle_world_event()
    ↓
    ├─ 常规路径：格式化事件 -> AstrTownMessageEvent -> commit_event -> LLM/工具调用
    ├─ social.*：转系统提示并强制唤醒决策（respond_relationship 等）
    └─ conversation.ended：异步触发反思流水线
           ↓
           _async_reflect_on_conversation()
           ├─ POST /api/bot/memory/inject
           ├─ POST /api/bot/social/affinity
           └─ (阈值满足) _async_higher_reflection()
                 ├─ GET /api/bot/memory/recent
                 └─ POST /api/bot/memory/inject (reflection)
```

---

## 5. 数据流分析

### 5.1 插件初始化流程

```
1. AstrBot 加载插件
   ↓
2. 读取 metadata.yaml
   ↓
3. 导入 __init__.py → AstrTownPlugin
   ↓
4. 调用 AstrTownPlugin.__init__()
   ↓
5. 导入 adapter.astrtown_adapter.AstrTownAdapter（触发平台注册）
   ↓
6. 调用 AstrTownPlugin.initialize()
   ↓
7. _register_config() 注入配置项到 CONFIG_METADATA_2
   ↓
8. 提取 persona_manager.get_default_persona_v3()
   ↓
9. set_persona_data() 设置全局 persona 描述
   ↓
10. set_reflection_llm_callback() 注入反思回调
   ↓
11. AstrBot 启动 AstrTownAdapter.run()
```

### 5.2 WebSocket 连接流程
 
```
1. AstrTownAdapter._run() 启动
   ↓
2. 创建 _ws_loop() 任务
   ↓
3. _ws_connect_once() 建立连接
   ↓
4. _build_ws_connect_url() 构建 URL
   ↓
5. websockets.connect() 连接到 Gateway
   ↓
6. 接收 connected 消息
   ↓
7. _handle_ws_message() 处理 connected
   ↓
8. 保存 agentId、playerId、worldId 等
   ↓
9. _sync_persona_to_gateway(playerId) 同步 persona（best-effort）
   ↓
10. 进入消息接收循环
```

> 注意：当前 AstrTown 引擎侧不再内置“自主 NPC/LLM prompt 拼接与发言生成”。
> 对话内容完全由外部插件在收到世界事件后，通过下发诸如 `command.say`/`externalBotSendMessage` 等指令来产生。
### 5.3 世界事件处理流程

```
1. Gateway 推送 world event
   ↓
2. _ws_connect_once() 接收原始消息
   ↓
3. _handle_ws_message() 根据 type 分发
   ↓
4. _handle_world_event() 总入口处理
   ↓
5. conversation.message 前置过滤 + 会话状态维护
   ↓
6. social.relationship_proposed/responded 转系统消息并强制唤醒决策
   ↓
7. conversation.ended 提取记录并异步触发 _async_reflect_on_conversation()
   ↓
8. 常规路径：_format_event_to_text() -> _build_session_id() -> commit_event()
   ↓
9. _send_event_ack() 发送 ACK
```

### 5.4 LLM 工具调用流程

```
1. LLM 决定调用工具（如 say）
   ↓
2. AstrBot 调用 AstrTownPlugin.say()
   ↓
3. 从 event.adapter 获取适配器引用
   ↓
4. 调用 adapter.send_command("command.say", payload)
   ↓
5. 生成 command_id
   ↓
6. 创建 Future 对象
   ↓
7. 发送 JSON 消息到 Gateway
   ↓
8. 等待 ACK（3 秒超时）
   ↓
9. Gateway 返回 command.ack
   ↓
10. _handle_ws_message() 处理 command.ack
   ↓
11. 设置 Future 结果
   ↓
12. send_command() 返回结果
   ↓
13. LLM 收到工具调用结果
```

### 5.5 上下文裁剪与“动态记忆 + 社交张力注入”流程

> 说明：这里的注入均发生在**插件侧** AstrBot LLM 请求链路中，用于上下文增强；
> 不代表 AstrTown 引擎会自主拼接 prompt 或自主生成 NPC 对话。

```
1. LLM 请求前触发（AstrBot 回调）
   ↓
2. _astrtown_trim_context_and_inject_memory() 被调用
   ↓
3. 读取 astrtown_max_context_rounds，裁剪非 system 历史
   ↓
4. 提取最新 user 发言 -> adapter.search_world_memory(...)
   ↓
5. 超时/异常熔断（wait_for 2s），无结果则跳过记忆注入
   ↓
6. 若可识别会话对方：GET /api/bot/social/state 获取关系与好感
   ↓
7. 构造 system 注入：记忆片段 + 社交张力（公开关系/私下好感）
   ↓
8. 重组 request.contexts：system -> 注入片段 -> recent non-system
```

### 5.6 对话结束反思流水线

```
1. _handle_world_event() 收到 conversation.ended
   ↓
2. _extract_conversation_messages() 标准化对话记录
   ↓
3. create_task(_async_reflect_on_conversation(...)) 异步启动
   ↓
4. get_reflection_llm_callback() 取回调并生成反思结果
   ↓
5. POST /api/bot/memory/inject 写入 conversation memory
   ↓
6. POST /api/bot/social/affinity 写入好感变化
   ↓
7. importance 累计达到阈值 -> _async_higher_reflection()
   ↓
8. GET /api/bot/memory/recent 拉取近期记忆
   ↓
9. 生成 insights 并逐条 POST /api/bot/memory/inject (memoryType=reflection)
```

---

## 6. 关键算法

### 6.1 WebSocket 重连算法

**位置**: [`_ws_loop()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:286)

**算法描述**:
使用指数退避策略进行 WebSocket 重连，避免频繁重连对服务器造成压力。

**实现逻辑**:
```python
delay = reconnect_min_delay
while not stop:
    try:
        await _ws_connect_once()
        delay = reconnect_min_delay
    except Exception:
        jitter = random.random() * 0.3 + 0.85
        sleep_s = min(delay * jitter, reconnect_max_delay)
        await asyncio.sleep(sleep_s)
        delay = min(delay * 2.0, reconnect_max_delay)
```

### 6.2 会话 ID 构建算法

**位置**: [`_build_session_id()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1528)

**算法描述**:
根据 `unique_session` 配置构建会话 ID，支持“按 world”或“按 world+player”隔离。

### 6.3 上下文裁剪 + 动态记忆/社交张力注入算法

**位置**: [`_astrtown_trim_context_and_inject_memory()`](astrbot_plugin_astrtown/main.py:24)

**算法描述**:
在 LLM 请求前裁剪上下文；以最近 user 文本检索记忆，并结合会话对方拉取社交关系/好感，注入 system context。

**关键点**:
- 记忆检索：[`search_world_memory()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1573) + `asyncio.wait_for(2.0)`。
- 社交状态：`GET /api/bot/social/state`。
- 注入内容：记忆片段 + 社交张力（公开关系 + 私下好感）。

### 6.4 邀请决策算法

**位置**: [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529)

**算法描述**:
根据 `astrtown_invite_decision_mode` 选择自动接受或交给 LLM 决策。

### 6.5 队列补充降噪算法

**位置**: [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529)

**算法描述**:
对 `agent.queue_refill_requested` 做最小间隔门控，未满足条件时仅 ACK，不唤醒 LLM。

### 6.6 对话消息过滤算法

**位置**: [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529)

**算法描述**:
过滤不属于当前活跃会话的 `conversation.message`，降低误唤醒。

### 6.7 社交关系事件强制唤醒算法

**位置**: [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529)

**算法描述**:
将 `social.relationship_proposed/responded` 转换为系统消息，并通过事件 metadata 强制唤醒 LLM，驱动及时关系决策与响应。

### 6.8 对话反思与高阶反思算法

**位置**: [`_async_reflect_on_conversation()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1304)、[`_async_higher_reflection()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1417)

**算法描述**:
- 会话反思：对 `conversation.ended` 的消息记录做 LLM 归纳，输出 `summary/importance/affinity_delta/affinity_label`。
- 副作用写回：
  - `POST /api/bot/memory/inject`（conversation memory）
  - `POST /api/bot/social/affinity`（好感变化）
- 高阶反思：当累计 importance 达阈值后，拉取近期记忆 `GET /api/bot/memory/recent` 生成 insights，再写回 reflection memory。

---

## 7. 配置项说明

### 7.1 平台配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `astrtown_gateway_url` | string | `http://localhost:40010` | Gateway 服务地址 |
| `astrtown_token` | string | `""` | NPC 绑定的 secretToken |
| `astrtown_ws_reconnect_min_delay` | int | `1` | WebSocket 最小重连延迟（秒） |
| `astrtown_ws_reconnect_max_delay` | int | `30` | WebSocket 最大重连延迟（秒） |

### 7.2 插件配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `astrtown_invite_decision_mode` | string | `auto_accept` | 邀请决策模式：`auto_accept`/`llm_judge` |
| `astrtown_refill_wake_enabled` | bool | `true` | 队列补充唤醒开关 |
| `astrtown_refill_min_wake_interval_sec` | int | `30` | 队列补充最小唤醒间隔（秒） |
| `astrtown_max_context_rounds` | int | `50` | 最大上下文轮数 |

---

## 8. 协议说明

### 8.1 WebSocket 消息格式

所有 WebSocket 消息遵循以下格式：

```json
{
  "type": "message_type",
  "id": "unique_id",
  "version": 1,
  "timestamp": 1234567890,
  "payload": {},
  "metadata": {}
}
```

### 8.2 消息类型

#### 客户端 → 服务器

| 消息类型 | 说明 |
|---------|------|
| `command.move_to` | 移动到目标玩家 |
| `command.say` | 发送消息 |
| `command.set_activity` | 设置活动状态 |
| `command.accept_invite` | 接受邀请 |
| `command.invite` | 邀请玩家 |
| `command.leave_conversation` | 离开对话 |
| `command.propose_relationship` | 发起社交关系提议（目标 playerId + 关系状态） |
| `command.respond_relationship` | 响应社交关系提议（提议者 playerId + 是否接受） |
| `command.do_something` | 底层动作 |
| `event.ack` | 事件确认 |
| `pong` | Ping 响应 |

#### 服务器 → 客户端

| 消息类型 | 说明 |
|---------|------|
| `ping` | 心跳检测 |
| `connected` | 连接成功 |
| `auth_error` | 认证错误 |
| `command.ack` | 命令确认 |
| `conversation.invited` | 对话邀请 |
| `conversation.started` | 对话开始 |
| `conversation.ended` | 对话结束（触发异步会话反思任务） |
| `conversation.message` | 对话消息 |
| `conversation.timeout` | 对话超时兜底强打断（invite_timeout / idle_timeout），插件会清理活跃对话状态并以系统提示唤醒 LLM |
| `social.relationship_proposed` | 社交关系提议事件，转系统提示并强制唤醒 LLM 做响应决策 |
| `social.relationship_responded` | 社交关系响应事件，转系统提示并强制唤醒 LLM 做后续反应 |
| `agent.state_changed` | Agent 状态变化 |
| `agent.queue_refill_requested` | 队列补充请求 |
| `action.finished` | 动作完成（当 `success=false & result.reason='expired'` 时表示指令过期被丢弃，插件仅告警记录） |

### 8.3 连接参数

WebSocket 连接 URL 格式：

```
ws://gateway_host:port/ws/bot?token={token}&v={version_range}&subscribe={subscribe}
```

参数说明：
- `token`: NPC 绑定的 secretToken
- `v`: 协议版本范围（如 "1-1"）
- `subscribe`: 订阅的事件类型（"*" 表示全部）

---

## 9. 总结

### 9.1 模块特点

1. **清晰的分层架构**
   - 插件层（[`AstrTownPlugin`](astrbot_plugin_astrtown/main.py:20)）：提供 LLM 工具、请求前上下文增强与生命周期注入能力
   - 适配器层（[`AstrTownAdapter`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:85)）：处理 WS 协议、事件投递与异步反思任务
   - 协议层（[`protocol.py`](astrbot_plugin_astrtown/adapter/protocol.py:1)）：定义消息模型

2. **新增社交关系闭环**
   - 工具侧新增 `propose_relationship/respond_relationship`（见 [`main.py`](astrbot_plugin_astrtown/main.py:475)）
   - 事件侧支持 `social.relationship_proposed/responded` 系统消息化与强制唤醒（见 [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529)）

3. **新增反思与记忆沉淀能力**
   - initialize/terminate 注入并清理全局 reflection callback（见 [`initialize()`](astrbot_plugin_astrtown/main.py:287)、[`terminate()`](astrbot_plugin_astrtown/main.py:331)）
   - `conversation.ended` 触发异步反思，写回记忆与好感，并在阈值到达时执行高阶反思。

4. **高效的上下文控制**
   - 上下文裁剪 + 记忆注入 + 动态社交张力注入组合，兼顾 token 成本与行为一致性。

5. **健壮的异步容错**
   - WS 重连、命令 ACK Future、HTTP best-effort 写回、超时熔断与降级路径完整。

### 9.2 关键技术点

1. **装饰器注册机制**
   - `@register_platform_adapter`、`@register_on_llm_request`、`@filter.llm_tool`。

2. **异步编程与任务编排**
   - `asyncio` + `Future` + `create_task` 支撑实时命令与后台反思双通路。

3. **状态管理**
   - 会话状态（`_active_conversation_id`）、会话对方（`_conversation_partner_id`）、反思累计阈值（`_importance_accumulator/_reflection_threshold`）。

4. **网关 API 协同**
   - 读：`/api/bot/memory/search`、`/api/bot/social/state`、`/api/bot/memory/recent`
   - 写：`/api/bot/memory/inject`、`/api/bot/social/affinity`、`/api/bot/description/update`

### 9.3 扩展性

1. **新增 LLM 工具**
   - 在 [`main.py`](astrbot_plugin_astrtown/main.py:20) 增加 `@filter.llm_tool` 方法，并通过 [`send_command()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:184) 下发。

2. **新增事件类型**
   - 在 [`protocol.py`](astrbot_plugin_astrtown/adapter/protocol.py:1) 扩展模型；在 [`_handle_world_event()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:529) 与 [`_format_event_to_text()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1662) 增加处理。

3. **新增反思策略**
   - 可在 [`_build_reflection_prompt()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1111) 与 [`_normalize_reflection_response()`](astrbot_plugin_astrtown/adapter/astrtown_adapter.py:1159) 增量扩展，不影响 WS 主链路。

---

## 10. 附录

### 10.1 文件统计汇总

| 目录 | 文件数 | 总行数 | 总字符数 |
|------|--------|--------|----------|
| 根目录 | 5 | 687 | 25183 |
| adapter/ | 5 | 1906 | 72884 |
| **总计** | **10** | **2593** | **98067** |

### 10.2 依赖关系图

```
astrbot_plugin_astrtown
├── AstrBot framework
│   ├── astrbot.api.event
│   ├── astrbot.api.star
│   ├── astrbot.api.platform
│   ├── astrbot.core.config
│   └── astrbot.core.star
├── websockets (WebSocket client)
├── aiohttp (HTTP client, optional)
└── Python standard library
    ├── asyncio
    ├── json
    ├── random
    ├── time
    ├── uuid
    └── urllib.parse
```

### 10.3 相关文档

- [`SKILL.md`](astrbot_plugin_astrtown/SKILL.md): NPC 行为指导文档
- [`_conf_schema.json`](astrbot_plugin_astrtown/_conf_schema.json): 配置项元数据
- [`metadata.yaml`](astrbot_plugin_astrtown/metadata.yaml): 插件元数据

---

**文档版本**: 1.0  
**创建日期**: 2026-02-22  
**分析范围**: astrbot_plugin_astrtown/ 完整模块

