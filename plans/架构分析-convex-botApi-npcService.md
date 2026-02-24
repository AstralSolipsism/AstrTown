# 架构分析：convex/botApi.ts + convex/npcService.ts

## 1. 模块概述

### 1.1 模块功能

本模块包含两个核心文件，是 AstrTown 项目中最复杂、最重要的服务层：

- **[`botApi.ts`](AstrTown/convex/botApi.ts)**：外部 Bot API 服务，提供完整的 Bot 控制接口
- **[`npcService.ts`](AstrTown/convex/npcService.ts)**：NPC 自助服务，提供 NPC 创建和管理功能

### 1.2 在整体项目中的位置

```
AstrTown/
├── convex/
│   ├── botApi.ts          ← 外部 Bot API 入口
│   ├── npcService.ts      ← NPC 自助服务
│   ├── aiTown/            ← 游戏引擎核心
│   │   ├── agent.ts       ← Agent 逻辑
│   │   ├── insertInput.ts ← 输入注入
│   │   └── main.ts        ← 主引擎
│   ├── auth.ts            ← 用户认证
│   └── world.ts           ← 世界管理
└── gateway/               ← WebSocket 网关
```

### 1.3 为何是最大最复杂的文件

| 文件 | 字符数 | 行数 | 复杂性原因 |
|------|--------|------|-----------|
| [`botApi.ts`](AstrTown/convex/botApi.ts) | 39,298 | 1,218 | 14个 HTTP 端点、9个 mutation/query、命令映射、幂等性控制、事件队列、社交/记忆扩展接口 |
| [`npcService.ts`](AstrTown/convex/npcService.ts) | 15,763 | 505 | 5个 HTTP 端点、4个 mutation/query/action、CORS 处理、Token 管理 |

**复杂性来源**：
1. **多协议支持**：同时支持 HTTP API 和内部 mutation/query/action
2. **认证授权**：Bot Token 认证 + 用户 Session 认证
3. **幂等性控制**：防止重复请求
4. **命令映射**：8 种命令类型到引擎输入的转换
5. **事件队列**：外部事件队列管理
6. **错误处理**：细粒度的错误分类和响应
7. **CORS 支持**：跨域资源共享配置

---

## 2. 文件清单

| 文件路径 | 功能描述 | 字符数 | 行数 |
|----------|----------|--------|------|
| [`AstrTown/convex/botApi.ts`](AstrTown/convex/botApi.ts) | 外部 Bot API 服务 | 39,298 | 1,218 |
| [`AstrTown/convex/npcService.ts`](AstrTown/convex/npcService.ts) | NPC 自助服务 | 15,763 | 505 |

---

## 3. 文件详细分析

### 3.1 botApi.ts

#### 3.1.1 文件基本信息

| 属性 | 值 |
|------|-----|
| 文件路径 | [`AstrTown/convex/botApi.ts`](AstrTown/convex/botApi.ts) |
| 字符数 | 39,298 |
| 行数 | 1,218 |
| 主要功能 | 外部 Bot API 接口服务 |

#### 3.1.2 导入的模块

```typescript
import { httpAction, mutation, query } from './_generated/server';
import type { ActionCtx } from './_generated/server';
import { v } from 'convex/values';
import { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import { insertInput } from './aiTown/insertInput';
import type { ExternalEventItem } from './aiTown/agent';
import * as memory from './agent/memory';
import * as embeddingsCache from './agent/embeddingsCache';
```

#### 3.1.3 导出的内容

**类型定义**：
- [`VerifiedBotToken`](AstrTown/convex/botApi.ts:41-48) - Bot Token 验证结果类型

**Query 函数** (4个)：
- [`verifyBotTokenQuery`](AstrTown/convex/botApi.ts:50-78) - 验证 Bot Token
- [`tokenDocByToken`](AstrTown/convex/botApi.ts:279-293) - 根据 Token 获取幂等记录
- [`getWorldById`](AstrTown/convex/botApi.ts:379-384) - 获取世界信息
- [`getExternalQueueStatus`](AstrTown/convex/botApi.ts:386-431) - 获取外部队列状态

**Mutation 函数** (5个)：
- [`updatePlayerDescription`](AstrTown/convex/botApi.ts:295-333) - 更新玩家描述
- [`patchTokenUsage`](AstrTown/convex/botApi.ts:335-349) - 更新 Token 使用记录
- [`writeExternalBotMessage`](AstrTown/convex/botApi.ts:351-377) - 写入外部 Bot 消息
- [`postCommandBatch`](AstrTown/convex/botApi.ts:433-478) - 批量提交命令
- [`createBotToken`](AstrTown/convex/botApi.ts:846-872) - 创建 Bot Token

**HTTP Action 函数** (14个)：
- [`postCommandBatchHttp`](AstrTown/convex/botApi.ts:480-555) - 批量提交命令 HTTP 端点
- [`postCommand`](AstrTown/convex/botApi.ts:617-761) - 提交单个命令 HTTP 端点
- [`postEventAck`](AstrTown/convex/botApi.ts:763-776) - 事件确认 HTTP 端点
- [`getWorldState`](AstrTown/convex/botApi.ts:778-787) - 获取世界状态 HTTP 端点
- [`getAgentStatus`](AstrTown/convex/botApi.ts:789-820) - 获取 Agent 状态 HTTP 端点
- [`postTokenValidate`](AstrTown/convex/botApi.ts:823-844) - 验证 Token HTTP 端点
- [`postDescriptionUpdate`](AstrTown/convex/botApi.ts:874-909) - 更新描述 HTTP 端点
- [`postTokenCreate`](AstrTown/convex/botApi.ts:911-941) - 创建 Token HTTP 端点
- [`postMemorySearch`](AstrTown/convex/botApi.ts:943-988) - 记忆检索 HTTP 端点（向量化检索）
- [`getRecentMemories`](AstrTown/convex/botApi.ts:990-1034) - 近期记忆查询 HTTP 端点
- [`postSocialAffinity`](AstrTown/convex/botApi.ts:1036-1083) - 社交好感更新 HTTP 端点
- [`postSocialRelationship`](AstrTown/convex/botApi.ts:1085-1132) - 社交关系写入 HTTP 端点
- [`getSocialState`](AstrTown/convex/botApi.ts:1134-1163) - 社交状态查询 HTTP 端点
- [`postMemoryInject`](AstrTown/convex/botApi.ts:1165-1218) - 外部记忆注入 HTTP 端点

**辅助函数**：
- [`jsonResponse`](AstrTown/convex/botApi.ts:11-19) - JSON 响应构建器
- [`unauthorized`](AstrTown/convex/botApi.ts:21-23) - 401 响应
- [`badRequest`](AstrTown/convex/botApi.ts:25-27) - 400 响应
- [`conflict`](AstrTown/convex/botApi.ts:29-31) - 409 响应
- [`parseBearerToken`](AstrTown/convex/botApi.ts:33-39) - 解析 Bearer Token
- [`verifyBotToken`](AstrTown/convex/botApi.ts:80-82) - 验证 Bot Token 包装函数
- [`normalizeExternalEventKind`](AstrTown/convex/botApi.ts:186-191) - 规范化外部事件类型
- [`normalizeExternalEventPriority`](AstrTown/convex/botApi.ts:193-202) - 规范化优先级
- [`normalizeExternalEventArgs`](AstrTown/convex/botApi.ts:204-209) - 规范化事件参数
- [`mapCommandTypeToExternalEventKind`](AstrTown/convex/botApi.ts:211-230) - 命令类型映射
- [`defaultQueuePriorityForCommand`](AstrTown/convex/botApi.ts:232-238) - 默认队列优先级
- [`buildExternalEventFromCommand`](AstrTown/convex/botApi.ts:240-261) - 从命令构建外部事件
- [`loadWorldAndAgent`](AstrTown/convex/botApi.ts:263-277) - 加载世界和 Agent
- [`ParameterValidationError`](AstrTown/convex/botApi.ts:557-563) - 参数校验错误类型
- [`isKnownEngineParamError`](AstrTown/convex/botApi.ts:565-574) - 判断已知引擎参数错误
- [`normalizeCommandArgsForEngine`](AstrTown/convex/botApi.ts:576-615) - 规范化命令参数

**常量定义**：
- [`commandMappings`](AstrTown/convex/botApi.ts:105-170) - 命令映射表
- [`supportedExternalEventKinds`](AstrTown/convex/botApi.ts:174-184) - 支持的外部事件类型

#### 3.1.4 定义的类型和常量

**命令类型**：
```typescript
type CommandType =
  | 'move_to'
  | 'say'
  | 'start_conversation'
  | 'accept_invite'
  | 'reject_invite'
  | 'leave_conversation'
  | 'continue_doing'
  | 'do_something';
```

**命令映射表**：
| 命令类型 | 输入名称 | 参数构建函数 |
|----------|----------|-------------|
| `move_to` | `finishDoSomething` | 构建 destination 参数 |
| `say` | `externalBotSendMessage` | 构建 conversationId、leaveConversation |
| `start_conversation` | `startConversation` | 构建 invitee |
| `accept_invite` | `acceptInvite` | 构建 conversationId |
| `reject_invite` | `rejectInvite` | 构建 conversationId |
| `leave_conversation` | `leaveConversation` | 构建 conversationId |
| `continue_doing` | `finishDoSomething` | 构建 activity |
| `do_something` | `finishDoSomething` | 构建 destination、invitee、activity |

#### 3.1.5 文件内部关系

```
botApi.ts 内部结构
├── 工具函数
│   ├── 响应构建器 (jsonResponse, unauthorized, badRequest, conflict)
│   ├── Token 解析 (parseBearerToken)
│   ├── 参数规范化 (normalizeExternalEventKind, normalizeExternalEventPriority, normalizeExternalEventArgs)
│   ├── 命令映射 (mapCommandTypeToExternalEventKind, buildExternalEventFromCommand)
│   ├── 命令参数适配 (normalizeCommandArgsForEngine, loadWorldAndAgent)
│   └── 错误判断 (ParameterValidationError, isKnownEngineParamError)
├── 数据访问层
│   ├── verifyBotTokenQuery - Token 验证
│   ├── tokenDocByToken - Token 文档查询
│   ├── getWorldById - 世界查询
│   └── getExternalQueueStatus - 队列状态
├── 数据修改层
│   ├── updatePlayerDescription - 更新玩家描述
│   ├── patchTokenUsage - 更新 Token 使用
│   ├── writeExternalBotMessage - 写入消息
│   ├── postCommandBatch - 批量命令入队
│   └── createBotToken - 创建 Token
└── HTTP API 层
    ├── 命令与状态：postCommandBatchHttp / postCommand / postEventAck / getWorldState / getAgentStatus
    ├── Token 与描述：postTokenValidate / postDescriptionUpdate / postTokenCreate
    ├── 记忆能力：postMemorySearch / getRecentMemories / postMemoryInject
    └── 社交能力：postSocialAffinity / postSocialRelationship / getSocialState
```


### 3.2 npcService.ts

#### 3.2.1 文件基本信息

| 属性 | 值 |
|------|-----|
| 文件路径 | [`AstrTown/convex/npcService.ts`](AstrTown/convex/npcService.ts) |
| 字符数 | 15,763 |
| 行数 | 505 |
| 主要功能 | NPC 自助创建和管理服务 |

#### 3.2.2 导入的模块

```typescript
import { api, internal } from './_generated/api';
import { Id } from './_generated/dataModel';
import { action, httpAction, internalMutation, mutation, query } from './_generated/server';
import { extractSessionToken, validateSession } from './auth';
import { v } from 'convex/values';
import { Descriptions } from '../data/characters';
```

#### 3.2.3 导出的内容

**类型定义**：
- [`InputStatusResult`](AstrTown/convex/npcService.ts:90-99) - 输入状态结果类型

**Query 函数** (2个)：
- [`listMyNpcs`](AstrTown/convex/npcService.ts:228-281) - 列出用户的 NPC
- [`getNpcToken`](AstrTown/convex/npcService.ts:320-348) - 获取 NPC Token

**Mutation 函数** (1个)：
- [`resetNpcToken`](AstrTown/convex/npcService.ts:283-318) - 重置 NPC Token

**Internal Mutation 函数** (1个)：
- [`setNpcNameInternal`](AstrTown/convex/npcService.ts:115-133) - 内部设置 NPC 名称

**Action 函数** (1个)：
- [`createNpcWithToken`](AstrTown/convex/npcService.ts:135-226) - 创建 NPC 并生成 Token

**HTTP Action 函数** (5个)：
- [`optionsNpc`](AstrTown/convex/npcService.ts:350-352) - CORS 预检请求
- [`postNpcCreate`](AstrTown/convex/npcService.ts:354-403) - 创建 NPC HTTP 端点
- [`getNpcList`](AstrTown/convex/npcService.ts:405-423) - 获取 NPC 列表 HTTP 端点
- [`postNpcResetToken`](AstrTown/convex/npcService.ts:425-461) - 重置 Token HTTP 端点
- [`getNpcTokenById`](AstrTown/convex/npcService.ts:463-504) - 获取 Token HTTP 端点

**辅助函数**：
- [`buildCorsHeaders`](AstrTown/convex/npcService.ts:14-23) - 构建 CORS 头
- [`corsPreflightResponse`](AstrTown/convex/npcService.ts:25-38) - CORS 预检响应
- [`jsonResponse`](AstrTown/convex/npcService.ts:40-49) - JSON 响应构建器
- [`badRequest`](AstrTown/convex/npcService.ts:51-53) - 400 响应
- [`unauthorized`](AstrTown/convex/npcService.ts:55-57) - 401 响应
- [`forbidden`](AstrTown/convex/npcService.ts:59-61) - 403 响应
- [`internalError`](AstrTown/convex/npcService.ts:63-65) - 500 响应
- [`toErrorMessage`](AstrTown/convex/npcService.ts:67-69) - 错误消息转换
- [`generateTokenValue`](AstrTown/convex/npcService.ts:71-73) - 生成 Token 值
- [`resolveDescriptionIndex`](AstrTown/convex/npcService.ts:75-88) - 解析描述索引
- [`waitForInputStatus`](AstrTown/convex/npcService.ts:101-113) - 等待输入状态

**常量定义**：
- `CREATE_NPC_TIMEOUT_MS` - 创建 NPC 超时时间 (30秒)
- `CREATE_NPC_POLL_MS` - 轮询间隔 (500ms)
- `CORS_ALLOW_METHODS` - 允许的 CORS 方法
- `CORS_ALLOW_HEADERS` - 允许的 CORS 头
- `CORS_MAX_AGE_SECONDS` - CORS 缓存时间

#### 3.2.4 文件内部关系

```
npcService.ts 内部结构
├── 工具函数
│   ├── CORS 处理 (buildCorsHeaders, corsPreflightResponse)
│   ├── 响应构建器 (jsonResponse, badRequest, unauthorized, forbidden, internalError)
│   ├── 错误处理 (toErrorMessage)
│   ├── Token 生成 (generateTokenValue)
│   ├── 描述解析 (resolveDescriptionIndex)
│   └── 状态等待 (waitForInputStatus)
├── 数据访问层
│   ├── listMyNpcs - 列出 NPC
│   └── getNpcToken - 获取 Token
├── 数据修改层
│   ├── resetNpcToken - 重置 Token
│   └── setNpcNameInternal - 设置 NPC 名称
├── Action 层
│   └── createNpcWithToken - 创建 NPC 并生成 Token
└── HTTP API 层
    ├── optionsNpc - CORS 预检
    ├── postNpcCreate - 创建 NPC
    ├── getNpcList - 获取 NPC 列表
    ├── postNpcResetToken - 重置 Token
    └── getNpcTokenById - 获取 Token
```

---

## 4. 模块关系图

### 4.1 文件间依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                      外部客户端                               │
│                  (Bot / NPC 管理应用)                        │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ├─────────────────┬─────────────────────┐
                     │                 │                     │
                     ▼                 ▼                     ▼
         ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
         │  botApi.ts       │  │  npcService.ts   │  │  auth.ts         │
         │  (Bot API)       │  │  (NPC 服务)      │  │  (认证服务)      │
         └────────┬─────────┘  └────────┬─────────┘  └──────────────────┘
                  │                     │
                  │                     │
                  ▼                     ▼
         ┌──────────────────────────────────────────┐
         │            aiTown/                       │
         │  ├── agent.ts (Agent 逻辑)              │
         │  ├── insertInput.ts (输入注入)          │
         │  └── main.ts (主引擎)                   │
         └────────────────┬─────────────────────────┘
                          │
                          ▼
         ┌──────────────────────────────────────────┐
         │            world.ts                       │
         │         (世界状态管理)                   │
         └──────────────────────────────────────────┘
```

### 4.2 数据库表依赖

```
botApi.ts 依赖的表:
├── botTokens (Bot Token 存储)
├── playerDescriptions (玩家描述)
├── worlds (世界信息)
├── agents (Agent 信息 - 嵌入在 worlds 中)
├── players (玩家信息 - 嵌入在 worlds 中)
├── conversations (对话信息 - 嵌入在 worlds 中)
├── messages (消息存储)
├── memories / memoryEmbeddings (记忆检索与注入)
├── embeddingsCache (查询向量缓存)
├── affinities (社交好感)
└── relationships (社交关系)

npcService.ts 依赖的表:
├── botTokens (Bot Token 存储)
├── playerDescriptions (玩家描述)
├── users (用户信息)
└── worlds (世界信息)
```

### 4.3 API 端点映射

| HTTP 方法 | 路径 | 处理函数 | 功能 |
|-----------|------|----------|------|
| POST | `/api/bot/command` | [`postCommand`](AstrTown/convex/botApi.ts:617) | 提交单个命令 |
| POST | `/api/bot/command/batch` | [`postCommandBatchHttp`](AstrTown/convex/botApi.ts:480) | 批量提交命令 |
| POST | `/api/bot/event` | [`postEventAck`](AstrTown/convex/botApi.ts:763) | 事件确认 |
| GET | `/api/bot/world-state` | [`getWorldState`](AstrTown/convex/botApi.ts:778) | 获取世界状态 |
| GET | `/api/bot/agent-status` | [`getAgentStatus`](AstrTown/convex/botApi.ts:789) | 获取 Agent 状态 |
| POST | `/api/bot/token/validate` | [`postTokenValidate`](AstrTown/convex/botApi.ts:823) | 验证 Token |
| POST | `/api/bot/description/update` | [`postDescriptionUpdate`](AstrTown/convex/botApi.ts:874) | 更新描述 |
| POST | `/api/bot/token/create` | [`postTokenCreate`](AstrTown/convex/botApi.ts:911) | 创建 Token |
| POST | `/api/bot/memory/search` | [`postMemorySearch`](AstrTown/convex/botApi.ts:943) | 记忆检索（向量化检索 + 时间衰减/重要性评估） |
| GET | `/api/bot/memory/recent` | [`getRecentMemories`](AstrTown/convex/botApi.ts:990) | 查询近期记忆 |
| POST | `/api/bot/social/affinity` | [`postSocialAffinity`](AstrTown/convex/botApi.ts:1036) | 更新社交好感 |
| GET | `/api/bot/social/state` | [`getSocialState`](AstrTown/convex/botApi.ts:1134) | 查询社交状态 |
| POST | `/api/bot/social/relationship` | [`postSocialRelationship`](AstrTown/convex/botApi.ts:1085) | 写入社交关系 |
| POST | `/api/bot/memory/inject` | [`postMemoryInject`](AstrTown/convex/botApi.ts:1165) | 注入外部记忆 |
| OPTIONS | `/api/npc/*` | [`optionsNpc`](AstrTown/convex/npcService.ts:350) | CORS 预检 |
| POST | `/api/npc/create` | [`postNpcCreate`](AstrTown/convex/npcService.ts:354) | 创建 NPC |
| GET | `/api/npc/list` | [`getNpcList`](AstrTown/convex/npcService.ts:405) | 获取 NPC 列表 |
| POST | `/api/npc/reset-token` | [`postNpcResetToken`](AstrTown/convex/npcService.ts:425) | 重置 Token |
| GET | `/api/npc/token/:id` | [`getNpcTokenById`](AstrTown/convex/npcService.ts:463) | 获取 Token |

---

## 5. 数据流分析

### 5.1 Bot 命令执行流程

```
外部 Bot 客户端
    │
    │ 1. POST /api/bot/command
    │    Headers: Authorization: Bearer {token}
    │    Headers: X-Idempotency-Key: {key}
    │    Body: { agentId, commandType, args, enqueueMode }
    ▼
┌─────────────────────────────────────────────────────────────┐
│ postCommand (HTTP Action)                                     │
├─────────────────────────────────────────────────────────────┤
│ 1. parseBearerToken() - 解析 Bearer Token                    │
│ 2. verifyBotToken() - 验证 Token                              │
│ 3. 检查幂等性 (X-Idempotency-Key)                             │
│ 4. 验证 agentId 和 commandType                                │
│ 5. normalizeCommandArgsForEngine() - 规范化参数               │
│ 6. 根据 enqueueMode 选择执行路径:                             │
│    - 'queue': 构建外部事件并加入队列                           │
│    - 'immediate' 或未传：直接执行命令                          │
└─────────────────────────────────────────────────────────────┘
    │
    │ enqueueMode === 'queue'
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ buildExternalEventFromCommand()                               │
├─────────────────────────────────────────────────────────────┤
│ 1. 生成 eventId (UUID)                                       │
│ 2. 映射 commandType 到 ExternalEventItem.kind                │
│ 3. 设置优先级 (accept_invite/reject_invite = 1, 其他 = 2)    │
│ 4. 设置 enqueueTs 和 expiresAt                                │
│ 5. 返回 ExternalEventItem                                     │
└─────────────────────────────────────────────────────────────┘
    │
    │ sendInput('enqueueExternalEvents')
    ▼
┌─────────────────────────────────────────────────────────────┐
│ aiTown/main.ts - 引擎处理                                    │
├─────────────────────────────────────────────────────────────┤
│ 1. 将事件加入 agent.externalPriorityQueue 或                 │
│    agent.externalEventQueue                                  │
│ 2. 引擎在 tick 中消费队列中的事件                             │
└─────────────────────────────────────────────────────────────┘
    │
    │ enqueueMode !== 'queue'
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 命令映射执行                                                  │
├─────────────────────────────────────────────────────────────┤
│ say: writeExternalBotMessage()                               │
│   1. 插入消息到 messages 表                                   │
│   2. sendInput('externalBotSendMessage')                     │
│                                                              │
│ do_something (go_home_and_sleep):                             │
│   sendInput('finishDoSomething', idle activity 60s)          │
│   （不再切换外部控制状态）                                     │
│                                                              │
│ 其他命令:                                                     │
│   sendInput(commandMappings[commandType].inputName, args)     │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ patchTokenUsage() - 更新 Token 使用记录                      │
├─────────────────────────────────────────────────────────────┤
│ 1. 更新 lastUsedAt                                           │
│ 2. 更新 lastIdempotencyKey                                   │
│ 3. 更新 lastIdempotencyResult                                │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
返回响应 { status: 'accepted', inputId }
```

### 5.2 NPC 创建流程

```
NPC 管理应用
    │
    │ 1. POST /api/npc/create
    │    Headers: Authorization: Session {token}
    │    Body: { name, character }
    ▼
┌─────────────────────────────────────────────────────────────┐
│ postNpcCreate (HTTP Action)                                  │
├─────────────────────────────────────────────────────────────┤
│ 1. extractSessionToken() - 提取 Session Token                │
│ 2. 验证请求体格式                                             │
│ 3. 调用 createNpcWithToken()                                  │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ createNpcWithToken (Action)                                  │
├─────────────────────────────────────────────────────────────┤
│ 1. validateSession() - 验证 Session Token                    │
│ 2. world.defaultWorldStatus() - 获取默认世界                 │
│ 3. resolveDescriptionIndex() - 解析角色描述索引              │
│ 4. sendInput('createAgent') - 创建 Agent                     │
│ 5. waitForInputStatus() - 等待创建完成                        │
│ 6. world.worldState() - 获取世界状态                          │
│ 7. setNpcNameInternal() - 设置 NPC 名称                      │
│ 8. createBotToken() - 创建 Bot Token                         │
└─────────────────────────────────────────────────────────────┘
    │
    │ sendInput('createAgent')
    ▼
┌─────────────────────────────────────────────────────────────┐
│ aiTown/main.ts - 引擎处理                                    │
├─────────────────────────────────────────────────────────────┤
│ 1. 创建 Agent                                                │
│ 2. 创建 Player                                               │
│ 3. 创建 PlayerDescription                                    │
│ 4. 返回 { agentId, playerId }                                │
└─────────────────────────────────────────────────────────────┘
    │
    │ waitForInputStatus() 轮询
    │ 每 500ms 检查一次，最多 30 秒
    ▼
┌─────────────────────────────────────────────────────────────┐
│ setNpcNameInternal (Internal Mutation)                       │
├─────────────────────────────────────────────────────────────┤
│ 1. 查询 playerDescriptions 表                                │
│ 2. 更新 name 字段                                            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ createBotToken (Mutation)                                     │
├─────────────────────────────────────────────────────────────┤
│ 1. 生成 Token (UUID + UUID)                                  │
│ 2. 插入 botTokens 表                                         │
│ 3. 返回 { token }                                            │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
返回响应 { ok: true, agentId, playerId, token, name }
```

### 5.3 Token 验证流程

```
客户端请求
    │
    │ Headers: Authorization: Bearer {token}
    ▼
┌─────────────────────────────────────────────────────────────┐
│ parseBearerToken()                                           │
├─────────────────────────────────────────────────────────────┤
│ 1. 获取 Authorization 头                                      │
│ 2. 分割 "Bearer {token}"                                     │
│ 3. 验证格式并返回 token                                       │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ verifyBotTokenQuery (Query)                                  │
├─────────────────────────────────────────────────────────────┤
│ 1. 查询 botTokens 表，索引 'token'                            │
│ 2. 检查 Token 是否存在                                       │
│ 3. 检查 isActive 状态                                        │
│ 4. 检查 expiresAt 是否过期                                   │
│ 5. 返回验证结果                                               │
└─────────────────────────────────────────────────────────────┘
    │
    │ 验证成功
    │
    ▼
返回 { valid: true, binding: { token, agentId, playerId, worldId, expiresAt, isActive } }
```

### 5.4 幂等性控制流程

```
客户端请求
    │
    │ Headers: X-Idempotency-Key: {unique_key}
    ▼
┌─────────────────────────────────────────────────────────────┐
│ tokenDocByToken (Query)                                      │
├─────────────────────────────────────────────────────────────┤
│ 1. 查询 botTokens 表，获取 Token 文档                         │
│ 2. 返回 { id, lastIdempotencyKey, lastIdempotencyResult }    │
└─────────────────────────────────────────────────────────────┘
    │
    │ 检查 lastIdempotencyKey
    │
    ├─► 相同 → 返回 lastIdempotencyResult (幂等响应)
    │
    └─► 不同 → 执行命令
            │
            ▼
        执行命令逻辑
            │
            ▼
┌─────────────────────────────────────────────────────────────┐
│ patchTokenUsage (Mutation)                                   │
├─────────────────────────────────────────────────────────────┤
│ 1. 更新 lastUsedAt = Date.now()                              │
│ 2. 更新 lastIdempotencyKey = {key}                           │
│ 3. 更新 lastIdempotencyResult = {response}                   │
└─────────────────────────────────────────────────────────────┘
```

### 5.5 记忆检索流程（深层记忆网络打通）

**对应端点**：[`postMemorySearch`](AstrTown/convex/botApi.ts:943-988)

```
外部 Bot 客户端
    │
    │ 1) POST /api/bot/memory/search
    │    Headers: Authorization: Bearer {token}
    │    Body: { queryText: string, limit?: number }
    ▼
┌─────────────────────────────────────────────────────────────┐
│ postMemorySearch (HTTP Action)                               │
├─────────────────────────────────────────────────────────────┤
│ 1. parseBearerToken() → 解析 Bearer token                    │
│ 2. verifyBotToken()   → 校验 botTokens 绑定与有效期          │
│ 3. 解析 JSON body，校验：                                    │
│    - queryText: string（必填）                               │
│    - limit: 1~50 的整数（默认 3）                            │
│ 4. 生成查询向量：                                            │
│    - 调用 embeddingsCache.fetch(ctx, queryText)              │
│      注意：这里是普通函数直接调用（非 mutation/query/action）│
│ 5. 记忆检索：                                                │
│    - 调用 memory.searchMemories(ctx, playerId, embedding, limit)
│      注意：searchMemories 返回扁平的 Memory[]                │
│      内部会进行时间衰减与重要性评估                          │
│ 6. 响应映射：仅返回 { description, importance }              │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
返回：{ ok: true, memories: [{ description, importance }] }
异常：500 → { ok: false, error }
```

### 5.6 近期记忆查询流程

**对应端点**：[`getRecentMemories`](AstrTown/convex/botApi.ts:990-1034)

```
外部 Bot 客户端
    │
    │ 1) GET /api/bot/memory/recent?worldId=...&playerId=...&count=...
    │    Headers: Authorization: Bearer {token}
    ▼
┌─────────────────────────────────────────────────────────────┐
│ getRecentMemories (HTTP Action)                              │
├─────────────────────────────────────────────────────────────┤
│ 1. parseBearerToken() + verifyBotToken()                     │
│ 2. 读取 query 参数：worldId/playerId/count                   │
│ 3. 参数校验：count 为正整数                                  │
│ 4. 绑定校验：                                                │
│    - worldId 必须与 token 绑定 worldId 一致                  │
│    - playerId 必须与 token 绑定 playerId 一致                │
│ 5. 调用 agent.memory.getRecentMemories 查询最近记忆          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
返回：{ ok: true, memories: [...] }
```

### 5.7 社交能力写入与查询流程

**对应端点**：
- [`postSocialAffinity`](AstrTown/convex/botApi.ts:1036-1083)
- [`postSocialRelationship`](AstrTown/convex/botApi.ts:1085-1132)
- [`getSocialState`](AstrTown/convex/botApi.ts:1134-1163)

```
外部 Bot 客户端
    │
    ├─ POST /api/bot/social/affinity
    │    Body: { ownerId, targetId, scoreDelta, label }
    │
    ├─ POST /api/bot/social/relationship
    │    Body: { playerAId, playerBId, status, establishedAt }
    │
    └─ GET /api/bot/social/state?ownerId=...&targetId=...
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 统一入口：Token + 参数校验                                    │
├─────────────────────────────────────────────────────────────┤
│ 1. parseBearerToken() + verifyBotToken()                     │
│ 2. 各接口执行字段级参数校验                                   │
│ 3. 调用 social 内部函数：                                     │
│    - updateAffinity (internalMutation)                        │
│    - upsertRelationship (internalMutation)                    │
│    - getSocialState (internalQuery)                           │
│ 4. worldId 一律使用 token 绑定 worldId 字符串化后传入         │
└─────────────────────────────────────────────────────────────┘
```

### 5.8 外部记忆注入流程

**对应端点**：[`postMemoryInject`](AstrTown/convex/botApi.ts:1165-1218)

```
外部 Bot 客户端
    │
    │ POST /api/bot/memory/inject
    │ Body: { agentId, playerId, summary, importance, memoryType? }
    ▼
┌─────────────────────────────────────────────────────────────┐
│ postMemoryInject (HTTP Action)                                │
├─────────────────────────────────────────────────────────────┤
│ 1. parseBearerToken() + verifyBotToken()                     │
│ 2. 校验 agentId/playerId/summary/importance/memoryType?      │
│ 3. 调用 agent.memory.insertExternalMemory (internalAction)   │
│    - 内部会生成 embedding 并写入 memories/memoryEmbeddings    │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
返回：{ ok: true }
```

---

## 6. 关键算法

### 6.1 命令映射算法

**位置**: [`commandMappings`](AstrTown/convex/botApi.ts:105-170)

**功能**: 将外部命令类型映射到引擎输入类型

```typescript
const commandMappings: Record<CommandType, CommandMapping> = {
  move_to: {
    inputName: 'finishDoSomething',
    buildInputArgs: ({ agentId, args }) => ({
      operationId: crypto.randomUUID(),
      agentId,
      destination: args?.destination,
    }),
  },
  say: {
    inputName: 'externalBotSendMessage',
    buildInputArgs: ({ agentId, args }) => ({
      agentId,
      conversationId: args?.conversationId,
      timestamp: Date.now(),
      leaveConversation: !!args?.leaveAfter,
    }),
  },
  // ... 其他命令
};
```

**算法特点**:
1. 每个命令类型对应一个输入名称
2. 使用 `buildInputArgs` 函数动态构建参数
3. 自动生成 operationId (UUID)
4. 处理可选参数和类型转换

### 6.2 外部事件构建算法

**位置**: [`buildExternalEventFromCommand`](AstrTown/convex/botApi.ts:240-261)

**功能**: 从命令构建外部事件项

```typescript
function buildExternalEventFromCommand(
  commandType: CommandType,
  normalizedArgs: any,
  now: number,
): ExternalEventItem {
  const expiresAt = normalizedArgs?.expiresAt !== undefined
    && typeof normalizedArgs.expiresAt !== 'number'
    ? (() => { throw new ParameterValidationError('args.expiresAt must be number'); })()
    : normalizedArgs?.expiresAt;

  return {
    eventId: crypto.randomUUID(),
    kind: mapCommandTypeToExternalEventKind(commandType),
    args: normalizeExternalEventArgs(normalizedArgs, 'args'),
    priority: defaultQueuePriorityForCommand(commandType),
    enqueueTs: now,
    expiresAt,
    source: 'gateway',
  };
}
```

**算法特点**:
1. 生成唯一 eventId (UUID)
2. 映射命令类型到事件类型
3. 设置默认优先级（邀请响应优先级为 1）
4. 支持过期时间设置
5. 标记来源为 'gateway'

### 6.3 参数规范化算法

**位置**: [`normalizeCommandArgsForEngine`](AstrTown/convex/botApi.ts:576-615)

**功能**: 规范化命令参数以适配引擎

```typescript
async function normalizeCommandArgsForEngine(
  ctx: ActionCtx,
  verified: { binding: VerifiedBotToken },
  commandType: CommandType,
  args: any,
): Promise<any> {
  if (!args || typeof args !== 'object') {
    throw new ParameterValidationError('args must be an object');
  }

  if (commandType === 'move_to') {
    const targetPlayerId = args?.targetPlayerId;
    if (!targetPlayerId || typeof targetPlayerId !== 'string') {
      throw new ParameterValidationError('Missing targetPlayerId');
    }
    const world = await ctx.runQuery(api.botApi.getWorldById, {
      worldId: verified.binding.worldId
    });
    if (!world) {
      throw new ParameterValidationError('World not found');
    }
    const targetPlayer = world.players?.find?.(
      (p: any) => p?.id === targetPlayerId
    );
    if (!targetPlayer?.position) {
      throw new ParameterValidationError(
        `Target player not found: ${targetPlayerId}`
      );
    }
    return { ...args, destination: targetPlayer.position };
  }

  if (commandType === 'say') {
    if (!args?.conversationId || typeof args.conversationId !== 'string') {
      throw new ParameterValidationError('Missing conversationId');
    }
    if (!args?.text || typeof args.text !== 'string') {
      throw new ParameterValidationError('Missing text');
    }
  }

  return args;
}
```

**算法特点**:
1. 验证参数类型和必填字段
2. 特殊处理 `move_to` 命令，将 targetPlayerId 转换为 destination
3. 查询世界状态获取玩家位置
4. 细粒度的错误提示

### 6.4 NPC 创建等待算法

**位置**: [`waitForInputStatus`](AstrTown/convex/npcService.ts:101-113)

**功能**: 等待输入状态完成

```typescript
async function waitForInputStatus(
  ctx: any,
  inputId: Id<'inputs'>
): Promise<InputStatusResult> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CREATE_NPC_TIMEOUT_MS) {
    const status = (await ctx.runQuery(api.aiTown.main.inputStatus, {
      inputId,
    })) as InputStatusResult;
    if (status !== null) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, CREATE_NPC_POLL_MS));
  }
  return null;
}
```

**算法特点**:
1. 超时控制：最多等待 30 秒
2. 轮询间隔：每 500ms 检查一次
3. 状态检测：status !== null 表示完成
4. 超时返回 null

### 6.5 描述索引解析算法

**位置**: [`resolveDescriptionIndex`](AstrTown/convex/npcService.ts:75-88)

**功能**: 解析角色描述索引

```typescript
function resolveDescriptionIndex(character?: string) {
  if (!character) {
    return Math.floor(Math.random() * Descriptions.length);
  }
  const normalized = character.trim();
  if (!normalized) {
    return Math.floor(Math.random() * Descriptions.length);
  }
  const index = Descriptions.findIndex(
    (d) => d.character === normalized
  );
  if (index < 0) {
    throw new Error(`character 不存在或未配置: ${normalized}`);
  }
  return index;
}
```

**算法特点**:
1. 支持随机选择（未指定 character 时）
2. 支持精确匹配（根据 character 名称查找）
3. 错误处理（未找到时抛出异常）
4. 使用 trim() 清理输入

### 6.6 Token 生成算法

**位置**: [`generateTokenValue`](AstrTown/convex/npcService.ts:71-73)

**功能**: 生成 Token 值

```typescript
function generateTokenValue() {
  return crypto.randomUUID().replace(/-/g, '')
    + crypto.randomUUID().replace(/-/g, '');
}
```

**算法特点**:
1. 使用两个 UUID 拼接
2. 移除所有连字符
3. 生成 64 字符的随机字符串
4. 高熵值，难以猜测

### 6.7 优先级分配算法

**位置**: [`defaultQueuePriorityForCommand`](AstrTown/convex/botApi.ts:232-238)

**功能**: 为命令分配默认队列优先级

```typescript
function defaultQueuePriorityForCommand(
  commandType: CommandType
): ExternalEventItem['priority'] {
  // 邀请响应需要插队进入 priorityQueue，避免 invited 状态下无法及时消费。
  if (commandType === 'accept_invite' || commandType === 'reject_invite') {
    return 1;
  }
  return 2;
}
```

**算法特点**:
1. 邀请响应优先级为 1（高优先级）
2. 其他命令优先级为 2（普通优先级）
3. 确保邀请响应及时处理
4. 避免 invited 状态阻塞

---

## 7. 错误处理机制

### 7.1 错误分类

| 错误类型 | HTTP 状态码 | 函数 | 说明 |
|----------|-------------|------|------|
| `AUTH_FAILED` | 401 | [`unauthorized`](AstrTown/convex/botApi.ts:21) | 认证失败 |
| `INVALID_ARGS` | 400 | [`badRequest`](AstrTown/convex/botApi.ts:25) | 参数错误 |
| `INVALID_JSON` | 400 | [`badRequest`](AstrTown/convex/botApi.ts:25) | 请求体 JSON 非法 |
| `INTERNAL_ERROR` | 500 | - | 内部错误 |
| `INVALID_TOKEN` | 401 | [`verifyBotTokenQuery`](AstrTown/convex/botApi.ts:50) | Token 无效 |
| `TOKEN_EXPIRED` | 401 | [`verifyBotTokenQuery`](AstrTown/convex/botApi.ts:50) | Token 过期 |
| `FORBIDDEN` | 403 | [`forbidden`](AstrTown/convex/npcService.ts:59) | 权限不足 |
| `WORLD_NOT_FOUND` | 400 | - | 世界不存在 |
| `NPC_NOT_FOUND` | 400 | - | NPC 不存在 |

### 7.2 参数验证错误

**位置**: [`ParameterValidationError`](AstrTown/convex/botApi.ts:557-563)

```typescript
class ParameterValidationError extends Error {
  code = 'INVALID_ARGS' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ParameterValidationError';
  }
}
```

### 7.3 引擎错误识别

**位置**: [`isKnownEngineParamError`](AstrTown/convex/botApi.ts:565-574)

```typescript
function isKnownEngineParamError(message: string): boolean {
  return [
    /^Couldn't find (agent|player|conversation): /,
    /^Can't move when in a conversation\./,
    /^Non-integral destination: /,
    /^Invalid input: /,
    /^World for engine .+ not found$/,
  ].some((pattern) => pattern.test(message));
}
```

---

## 8. 安全机制

### 8.1 认证机制

1. **Bot Token 认证**:
   - 使用 Bearer Token 方式
   - Token 存储在 `botTokens` 表
   - 支持过期时间设置
   - 支持激活/停用状态

2. **用户 Session 认证**:
   - 使用 Session Token 方式
   - 通过 [`auth.ts`](AstrTown/convex/auth.ts) 验证
   - 绑定用户 ID

### 8.2 授权机制

1. **Token 绑定验证**:
   - 验证 agentId 是否匹配
   - 验证 worldId 是否匹配
   - 验证 userId 是否匹配（NPC 服务）

2. **资源所有权验证**:
   - 用户只能操作自己的 NPC
   - Bot 只能控制绑定的 Agent

### 8.3 幂等性保护

1. **Idempotency Key**:
   - 客户端提供唯一键
   - 服务端记录执行结果
   - 重复请求返回相同结果

2. **Token 使用记录**:
   - 记录 `lastIdempotencyKey`
   - 记录 `lastIdempotencyResult`
   - 记录 `lastUsedAt`

### 8.4 CORS 保护

**位置**: [`buildCorsHeaders`](AstrTown/convex/npcService.ts:14-23)

```typescript
function buildCorsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get('origin');
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-max-age': CORS_MAX_AGE_SECONDS,
    ...(origin ? { vary: 'origin' } : {}),
  };
}
```

---

## 9. 性能优化

### 9.1 查询优化

1. **索引使用**:
   - `botTokens` 表使用 `token` 索引
   - `botTokens` 表使用 `by_userId` 索引
   - `playerDescriptions` 表使用 `worldId` 复合索引

2. **批量操作**:
   - [`postCommandBatch`](AstrTown/convex/botApi.ts:433) 支持批量提交命令
   - 减少网络往返

### 9.2 队列管理

1. **优先级队列**:
   - 高优先级事件（邀请响应）优先处理
   - 普通事件按顺序处理

2. **过期清理**:
   - 支持事件过期时间
   - 避免处理过期事件

### 9.3 轮询优化

1. **等待机制**:
   - NPC 创建使用轮询等待
   - 超时控制（30秒）
   - 合理的轮询间隔（500ms）

---

## 10. 总结

### 10.1 模块特点

1. **高复杂性**:
   - 两个文件共 55,061 字符
   - 19 个 HTTP 端点
   - 14 个 mutation/query/action（不含 HTTP Action）
   - 多种认证和授权机制

2. **高可靠性**:
   - 完善的错误处理
   - 幂等性保护
   - 参数验证

3. **高性能**:
   - 批量操作支持
   - 优先级队列
   - 索引优化

4. **高安全性**:
   - 多层认证
   - 授权验证
   - CORS 保护

### 10.2 设计模式

1. **命令模式**: 命令映射和执行
2. **策略模式**: 不同的命令类型处理策略
3. **工厂模式**: 事件构建器
4. **观察者模式**: 状态等待机制

### 10.3 扩展性

1. **命令扩展**: 添加新命令类型只需更新映射表
2. **事件扩展**: 支持新的事件类型
3. **认证扩展**: 支持多种认证方式
4. **队列扩展**: 支持不同的队列策略

---

## 附录

### A. 数据库表结构

#### botTokens 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | Id<'botTokens'> | 主键 |
| `token` | string | Token 值 |
| `agentId` | string | Agent ID |
| `playerId` | string | Player ID |
| `userId` | Id<'users'> | 用户 ID |
| `worldId` | Id<'worlds'> | 世界 ID |
| `createdAt` | number | 创建时间 |
| `expiresAt` | number | 过期时间（0 表示永不过期） |
| `isActive` | boolean | 是否激活 |
| `lastUsedAt` | number | 最后使用时间 |
| `lastIdempotencyKey` | string | 最后幂等性键 |
| `lastIdempotencyResult` | any | 最后幂等性结果 |
| `description` | string | 描述 |

#### playerDescriptions 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `_id` | Id<'playerDescriptions'> | 主键 |
| `worldId` | Id<'worlds'> | 世界 ID |
| `playerId` | string | Player ID |
| `name` | string | 名称 |
| `character` | string | 角色类型 |
| `description` | string | 描述 |

### B. API 响应格式

#### 成功响应

```json
{
  "status": "accepted",
  "inputId": "..."
}
```

#### 错误响应

```json
{
  "valid": false,
  "status": "rejected",
  "code": "INVALID_ARGS",
  "message": "..."
}
```

#### 幂等响应

```json
{
  "status": "accepted",
  "inputId": "..."
}
```

---

**文档版本**: 1.0
**最后更新**: 2026-02-24
**作者**: 架构分析工具
