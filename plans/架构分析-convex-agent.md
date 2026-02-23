# 架构分析：convex/agent 模块

> 目标：对 `AstrTown/convex/agent/` 下全部 4 个文件进行基于代码的架构分析，并说明它们之间的关系、数据流、关键算法。

- 模块目录：[`AstrTown/convex/agent/`](AstrTown/convex/agent/)
- 文件：[`conversation.ts`](AstrTown/convex/agent/conversation.ts)、[`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts)、[`memory.ts`](AstrTown/convex/agent/memory.ts)、[`schema.ts`](AstrTown/convex/agent/schema.ts)

---

## 1. 模块概述

### 1.1 功能与架构

`convex/agent` 是“智能体（Agent）对话 + 记忆（Memory）”的后端能力集合，运行在 Convex（Actions/Queries/Mutations + 数据表 + 向量索引）之上，核心能力包含：

1. **对话生成**：根据玩家身份/目标、对话上下文、相关记忆，调用 LLM 生成下一条对话文本。
   - 入口函数：[`startConversationMessage()`](AstrTown/convex/agent/conversation.ts:13)、[`continueConversationMessage()`](AstrTown/convex/agent/conversation.ts:78)、[`leaveConversationMessage()`](AstrTown/convex/agent/conversation.ts:136)
2. **记忆写入**：对结束的对话做总结，评估重要性，生成 embedding，写入 memories + memoryEmbeddings。
   - 入口函数：[`rememberConversation()`](AstrTown/convex/agent/memory.ts:24)
3. **记忆检索与排序**：基于 embedding 的向量搜索得到候选，再用“相关性 + 重要性 + 近期性”三因子综合排序，并触达（touch）更新时间。
   - 入口函数：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158) + [`rankAndTouchMemories`](AstrTown/convex/agent/memory.ts:187)
4. **Embedding 缓存**：对任意文本生成 embedding 时，先按 SHA-256 哈希查询缓存表，缺失再批量调用 embedding 接口并回写。
   - 入口函数：[`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9)、[`fetchBatch()`](AstrTown/convex/agent/embeddingsCache.ts:14)
5. **数据表与索引定义**：声明 memories、memoryEmbeddings、embeddingsCache 三张表、索引与向量索引维度。
   - 表定义：[`memoryTables`](AstrTown/convex/agent/schema.ts:32)、[`agentTables`](AstrTown/convex/agent/schema.ts:47)

整体上该模块通过“**结构化数据（world / messages 等） + 向量记忆检索 + LLM 生成**”来驱动 NPC/玩家的对话与长期记忆。

### 1.2 在整体项目中的位置与作用

- 该模块位于 `AstrTown/convex/`（Convex 后端函数）下，属于后端逻辑层。
- 它依赖：
  - LLM 工具层：[`chatCompletion()`](AstrTown/convex/util/llm.ts:1)（由导入可知存在）、[`fetchEmbeddingBatch()`](AstrTown/convex/util/llm.ts:1)、[`fetchEmbedding()`](AstrTown/convex/util/llm.ts:1)
  - AI Town 的 ID/类型：[`playerId`](AstrTown/convex/aiTown/ids.ts:1)、[`conversationId`](AstrTown/convex/aiTown/ids.ts:1)、[`agentId`](AstrTown/convex/aiTown/ids.ts:1)、[`GameId`](AstrTown/convex/aiTown/ids.ts:1)
  - Convex 运行时：`internalQuery/internalMutation`、`ActionCtx`、数据库 `ctx.db`、向量检索 `ctx.vectorSearch` 等。

> 注：以上 `util/llm.ts`、`aiTown/ids.ts` 的具体实现未在本文中展开，本文严格聚焦 `convex/agent/` 四个文件，并只引用它们实际 import 的符号名。

### 1.3 Agent 智能体系统核心概念（基于本模块代码）

- **记忆（Memory）**：存储在 `memories` 表中，包含 `description`、`importance`、`lastAccess`、`data(type=relationship|conversation|reflection)`，并通过 `embeddingId` 关联到 `memoryEmbeddings` 表中的向量。
  - 字段定义：[`memoryFields`](AstrTown/convex/agent/schema.ts:6)
- **向量记忆索引（memoryEmbeddings vectorIndex）**：按 playerId 过滤、基于 embedding 相似度检索候选记忆。
  - 定义：[`memoryTables.memoryEmbeddings`](AstrTown/convex/agent/schema.ts:37)
  - 检索：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158)
- **反思（Reflection）**：当近期记忆的重要性累计超过阈值时，触发 LLM 抽象出高层洞见，写入 reflection 类型记忆。
  - 触发与保存：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:325) + [`insertReflectionMemories`](AstrTown/convex/agent/memory.ts:291)
- **Embedding 缓存**：对常用提示文本（例如 “A is talking to B”）缓存 embedding，降低重复调用。
  - 表：[`agentTables.embeddingsCache`](AstrTown/convex/agent/schema.ts:47)
  - 读写：[`getEmbeddingsByText`](AstrTown/convex/agent/embeddingsCache.ts:69)、[`writeEmbeddings`](AstrTown/convex/agent/embeddingsCache.ts:94)

---

## 2. 文件清单

> 说明：行数来自本次读取的行号范围；字符数基于 workspace 文件列表中显示的 `# chars`。

| 文件 | 路径 | 功能摘要 | 行数（约） | 字符数 |
|---|---|---|---:|---:|
| conversation.ts | [`AstrTown/convex/agent/conversation.ts`](AstrTown/convex/agent/conversation.ts) | 构建对话 Prompt、拼接历史消息/相关记忆、调用 LLM 生成对话文本；提供 prompt 数据的 internalQuery | 352 | 11914 |
| embeddingsCache.ts | [`AstrTown/convex/agent/embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts) | embedding 缓存（hash->embedding），批量缺失填充与回写 | 110 | 3561 |
| memory.ts | [`AstrTown/convex/agent/memory.ts`](AstrTown/convex/agent/memory.ts) | 记忆写入/检索/排序/触达、对话总结记忆、反思记忆生成与保存 | 450 | （未在列表中显示，本次读取未提供） |
| schema.ts | [`AstrTown/convex/agent/schema.ts`](AstrTown/convex/agent/schema.ts) | memories/memoryEmbeddings/embeddingsCache 表结构、索引、向量索引维度定义 | 53 | （未在列表中显示，本次读取未提供） |

---

## 3. 文件详细分析

### 3.1 [`conversation.ts`](AstrTown/convex/agent/conversation.ts)

#### 3.1.1 文件基本信息

- 职责：
  - 从数据库组装对话所需的 prompt 数据（玩家/对手/agent 描述、上次共同对话等）。
  - 组合“身份+目标+历史对话+相关记忆”等上下文，调用 LLM 生成：
    - 开场白
    - 续聊回复
    - 离开对话的礼貌告别
- 关键入口：
  - [`startConversationMessage()`](AstrTown/convex/agent/conversation.ts:13)
  - [`continueConversationMessage()`](AstrTown/convex/agent/conversation.ts:78)
  - [`leaveConversationMessage()`](AstrTown/convex/agent/conversation.ts:136)
- 内部数据装配 query：[`queryPromptData`](AstrTown/convex/agent/conversation.ts:249)

#### 3.1.2 导入的模块

- Convex/类型：
  - `v`（参数校验）：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:1)
  - `Id`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:2)
  - `ActionCtx`, `internalQuery`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:3)
  - `api`, `internal`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:6)
- LLM：`LLMMessage`, `chatCompletion`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:4)
- 记忆与 embedding：
  - `* as memory`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:5)
  - `* as embeddingsCache`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:7)
- ID/参数 schema：`GameId`, `conversationId`, `playerId`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:8)
- 常量：`NUM_MEMORIES_TO_SEARCH`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:9)

#### 3.1.3 导出的内容

- 对话生成函数：
  - [`startConversationMessage()`](AstrTown/convex/agent/conversation.ts:13)
  - [`continueConversationMessage()`](AstrTown/convex/agent/conversation.ts:78)
  - [`leaveConversationMessage()`](AstrTown/convex/agent/conversation.ts:136)
- internalQuery：[`queryPromptData`](AstrTown/convex/agent/conversation.ts:249)

#### 3.1.4 定义的函数和变量

- `selfInternal`：指向 `internal.agent.conversation`：[`conversation.ts`](AstrTown/convex/agent/conversation.ts:11)
- 文本处理：[`trimContentPrefx()`](AstrTown/convex/agent/conversation.ts:71)
- Prompt 片段生成：
  - [`agentPrompts()`](AstrTown/convex/agent/conversation.ts:185)
  - [`previousConversationPrompt()`](AstrTown/convex/agent/conversation.ts:201)
  - [`relatedMemoriesPrompt()`](AstrTown/convex/agent/conversation.ts:218)
- 历史消息转换为 LLM messages：[`previousMessages()`](AstrTown/convex/agent/conversation.ts:229)
- stop words：[`stopWords()`](AstrTown/convex/agent/conversation.ts:348)

#### 3.1.5 文件内部关系（调用链）

- [`startConversationMessage()`](AstrTown/convex/agent/conversation.ts:13)
  - `ctx.runQuery(selfInternal.queryPromptData, ...)` → [`queryPromptData`](AstrTown/convex/agent/conversation.ts:249)
  - `embeddingsCache.fetch(...)` → [`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9)
  - `memory.searchMemories(...)` → [`searchMemories()`](AstrTown/convex/agent/memory.ts:158)
  - 组装 prompt：[`agentPrompts()`](AstrTown/convex/agent/conversation.ts:185)、[`previousConversationPrompt()`](AstrTown/convex/agent/conversation.ts:201)、[`relatedMemoriesPrompt()`](AstrTown/convex/agent/conversation.ts:218)
  - `chatCompletion(...)`（外部）
  - [`trimContentPrefx()`](AstrTown/convex/agent/conversation.ts:71)

- [`continueConversationMessage()`](AstrTown/convex/agent/conversation.ts:78)
  - `ctx.runQuery(selfInternal.queryPromptData, ...)` → [`queryPromptData`](AstrTown/convex/agent/conversation.ts:249)
  - `embeddingsCache.fetch(...)` → [`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9)
  - `memory.searchMemories(..., 3)` → [`searchMemories()`](AstrTown/convex/agent/memory.ts:158)
  - `previousMessages(...)` → [`previousMessages()`](AstrTown/convex/agent/conversation.ts:229) → `ctx.runQuery(api.messages.listMessages, ...)`（外部 api）
  - `chatCompletion(...)` + [`trimContentPrefx()`](AstrTown/convex/agent/conversation.ts:71)

- [`leaveConversationMessage()`](AstrTown/convex/agent/conversation.ts:136)
  - 与 continue 类似，但不检索记忆、只使用历史消息与 agent prompt。

#### 3.1.6 文件间关系

- 依赖 `memory`：使用 [`searchMemories()`](AstrTown/convex/agent/memory.ts:158) 返回的 `Memory[]`，并在 [`relatedMemoriesPrompt()`](AstrTown/convex/agent/conversation.ts:218) 中读取 `memory.description`。
- 依赖 `embeddingsCache`：使用 [`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9) 获取用于记忆检索的查询 embedding。

---

### 3.2 [`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts)

#### 3.2.1 文件基本信息

- 职责：
  - 文本 → embedding 的缓存层。
  - 支持单条与批量：[`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9)、[`fetchBatch()`](AstrTown/convex/agent/embeddingsCache.ts:14)
  - 通过 SHA-256(text) 作为 key，查询 `embeddingsCache` 表；缺失则调用 embedding 批量接口并回写。

#### 3.2.2 导入的模块

- Convex：`v`、[`ActionCtx`](AstrTown/convex/agent/embeddingsCache.ts:2)、[`internalMutation`](AstrTown/convex/agent/embeddingsCache.ts:2)、[`internalQuery`](AstrTown/convex/agent/embeddingsCache.ts:2)
- API：`internal`：[`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts:3)
- 类型：`Id`：[`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts:4)
- LLM embedding：`fetchEmbeddingBatch`：[`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts:5)

#### 3.2.3 导出的内容

- 公共函数：[`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9)、[`fetchBatch()`](AstrTown/convex/agent/embeddingsCache.ts:14)
- internalQuery：[`getEmbeddingsByText`](AstrTown/convex/agent/embeddingsCache.ts:69)
- internalMutation：[`writeEmbeddings`](AstrTown/convex/agent/embeddingsCache.ts:94)

#### 3.2.4 定义的函数和变量

- `selfInternal`：指向 `internal.agent.embeddingsCache`：[`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts:7)
- hash：[`hashText()`](AstrTown/convex/agent/embeddingsCache.ts:54)
  - 既支持 WebCrypto（`crypto.subtle.digest`），也支持 Node crypto（动态 import `node:crypto`）。

#### 3.2.5 文件内部关系（缓存命中/回写流程）

- [`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9) → [`fetchBatch()`](AstrTown/convex/agent/embeddingsCache.ts:14)
- [`fetchBatch()`](AstrTown/convex/agent/embeddingsCache.ts:14)
  1. `hashText(text)` 计算 `textHash`：[`hashText()`](AstrTown/convex/agent/embeddingsCache.ts:54)
  2. `ctx.runQuery(selfInternal.getEmbeddingsByText, { textHashes })` → [`getEmbeddingsByText`](AstrTown/convex/agent/embeddingsCache.ts:69)
  3. 对缺失项：调用 `fetchEmbeddingBatch(missingTexts)`（外部）
  4. `ctx.runMutation(selfInternal.writeEmbeddings, { embeddings: toWrite })` → [`writeEmbeddings`](AstrTown/convex/agent/embeddingsCache.ts:94)

#### 3.2.6 文件间关系

- 被 [`conversation.ts`](AstrTown/convex/agent/conversation.ts) 调用来为“记忆检索 query 文本”生成 embedding。
- 与 [`schema.ts`](AstrTown/convex/agent/schema.ts) 的 `embeddingsCache` 表结构对应：[`agentTables.embeddingsCache`](AstrTown/convex/agent/schema.ts:47)

---

### 3.3 [`memory.ts`](AstrTown/convex/agent/memory.ts)

#### 3.3.1 文件基本信息

- 职责：
  - 对话结束后“总结为记忆”并持久化（conversation memory）。
  - 记忆向量检索与三因子排序。
  - 记忆触达节流（throttle）更新 lastAccess。
  - “反思记忆”生成：当重要性累计超过阈值时，用 LLM 归纳洞见并保存。

#### 3.3.2 导入的模块

- Convex：`v`、[`ActionCtx`](AstrTown/convex/agent/memory.ts:2)、[`DatabaseReader`](AstrTown/convex/agent/memory.ts:2)、[`internalMutation`](AstrTown/convex/agent/memory.ts:2)、[`internalQuery`](AstrTown/convex/agent/memory.ts:2)
- 数据模型：`Doc`, `Id`：[`memory.ts`](AstrTown/convex/agent/memory.ts:3)
- API：`internal`：[`memory.ts`](AstrTown/convex/agent/memory.ts:4)
- LLM：`LLMMessage`, `chatCompletion`, `fetchEmbedding`：[`memory.ts`](AstrTown/convex/agent/memory.ts:5)
- 工具：`asyncMap`：[`memory.ts`](AstrTown/convex/agent/memory.ts:6)
- AI Town：`GameId`, `agentId`, `conversationId`, `playerId`：[`memory.ts`](AstrTown/convex/agent/memory.ts:7)
- 玩家类型：`SerializedPlayer`：[`memory.ts`](AstrTown/convex/agent/memory.ts:8)
- schema：`memoryFields`：[`memory.ts`](AstrTown/convex/agent/memory.ts:9)

#### 3.3.3 导出的内容

- 常量：[`MEMORY_ACCESS_THROTTLE`](AstrTown/convex/agent/memory.ts:12)
- 类型：`Memory`, `MemoryType`, `MemoryOfType`：[`memory.ts`](AstrTown/convex/agent/memory.ts:18)
- 记忆写入/对话总结：[`rememberConversation()`](AstrTown/convex/agent/memory.ts:24)
- internalQuery：[`loadConversation`](AstrTown/convex/agent/memory.ts:88)、[`loadMessages`](AstrTown/convex/agent/memory.ts:230)、[`getReflectionMemories`](AstrTown/convex/agent/memory.ts:398)
- 记忆检索：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158)
- internalMutation：[`rankAndTouchMemories`](AstrTown/convex/agent/memory.ts:187)、[`insertMemory`](AstrTown/convex/agent/memory.ts:273)、[`insertReflectionMemories`](AstrTown/convex/agent/memory.ts:291)
- 查询最近某类记忆：[`latestMemoryOfType()`](AstrTown/convex/agent/memory.ts:438)

#### 3.3.4 定义的函数和变量

- `MEMORY_OVERFETCH`：向量检索 overfetch 倍数（10x）：[`memory.ts`](AstrTown/convex/agent/memory.ts:15)
- `selfInternal`：`internal.agent.memory`：[`memory.ts`](AstrTown/convex/agent/memory.ts:16)
- 归一化与范围：[`makeRange()`](AstrTown/convex/agent/memory.ts:176)、[`normalize()`](AstrTown/convex/agent/memory.ts:182)
- 重要性评估：[`calculateImportance()`](AstrTown/convex/agent/memory.ts:246)
- 反思流程：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:325)

#### 3.3.5 文件内部关系

- 对话总结写入：[`rememberConversation()`](AstrTown/convex/agent/memory.ts:24)
  1. 拉取对话与参与者：`ctx.runQuery(selfInternal.loadConversation, ...)` → [`loadConversation`](AstrTown/convex/agent/memory.ts:88)
  2. 拉取对话消息：`ctx.runQuery(selfInternal.loadMessages, ...)` → [`loadMessages`](AstrTown/convex/agent/memory.ts:230)
  3. 将消息拼成 LLM prompt，`chatCompletion(...)` 生成 summary：[`rememberConversation()`](AstrTown/convex/agent/memory.ts:24)
  4. `calculateImportance(description)`：[`calculateImportance()`](AstrTown/convex/agent/memory.ts:246)
  5. `fetchEmbedding(description)` 生成 embedding：[`rememberConversation()`](AstrTown/convex/agent/memory.ts:24)
  6. 写入：`ctx.runMutation(selfInternal.insertMemory, ...)` → [`insertMemory`](AstrTown/convex/agent/memory.ts:273)
  7. 触发反思：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:325)

- 记忆检索：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158)
  1. `ctx.vectorSearch('memoryEmbeddings', 'embedding', { vector, filter, limit })`：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158)
  2. `ctx.runMutation(selfInternal.rankAndTouchMemories, { candidates, n })` → [`rankAndTouchMemories`](AstrTown/convex/agent/memory.ts:187)

- 排序与 touch：[`rankAndTouchMemories`](AstrTown/convex/agent/memory.ts:187)
  - 从候选 embeddingId 找到 memory：`memories.withIndex('embeddingId', ...)`
  - 计算三类分数并归一化后求和：
    - relevance：`args.candidates[idx]._score`
    - importance：`memory.importance`
    - recency：`0.99 ** floor(hoursSinceAccess)`（基于 lastAccess）
  - 排序、取 top n，然后对 lastAccess 节流更新：[`MEMORY_ACCESS_THROTTLE`](AstrTown/convex/agent/memory.ts:12)

- 反思：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:325)
  1. 拉取最近记忆与最后一次 reflection 时间：`ctx.runQuery(internal.agent.memory.getReflectionMemories, ...)` → [`getReflectionMemories`](AstrTown/convex/agent/memory.ts:398)
  2. 计算自上次反思以来的 importance 累计，阈值判断：`sum > 500`：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:325)
  3. 用 LLM 输出 JSON insights，`JSON.parse`，为每条 insight 计算 importance + embedding。
  4. 写入 reflection memories：`ctx.runMutation(selfInternal.insertReflectionMemories, ...)` → [`insertReflectionMemories`](AstrTown/convex/agent/memory.ts:291)

#### 3.3.6 文件间关系

- 与 [`schema.ts`](AstrTown/convex/agent/schema.ts) 的结构耦合点：
  - `memoryFields` 用于声明 `insertMemory` 参数（剔除 embeddingId）：[`memoryFields`](AstrTown/convex/agent/schema.ts:6) + [`insertMemory`](AstrTown/convex/agent/memory.ts:273)
  - `memoryEmbeddings` 向量索引名称与字段：`ctx.vectorSearch('memoryEmbeddings', 'embedding', ...)` 对应 [`memoryTables.memoryEmbeddings`](AstrTown/convex/agent/schema.ts:37)
- 被 [`conversation.ts`](AstrTown/convex/agent/conversation.ts) 调用：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158)

---

### 3.4 [`schema.ts`](AstrTown/convex/agent/schema.ts)

#### 3.4.1 文件基本信息

- 职责：
  - 定义 agent 相关的表结构与索引：
    - `memories`
    - `memoryEmbeddings`（向量索引）
    - `embeddingsCache`
- 该文件是 `convex/agent` 的“数据模型定义层”。

#### 3.4.2 导入的模块

- `v`：[`schema.ts`](AstrTown/convex/agent/schema.ts:1)
- `playerId`, `conversationId`：[`schema.ts`](AstrTown/convex/agent/schema.ts:2)
- `defineTable`：[`schema.ts`](AstrTown/convex/agent/schema.ts:3)
- `EMBEDDING_DIMENSION`：[`schema.ts`](AstrTown/convex/agent/schema.ts:4)

#### 3.4.3 导出的内容

- 字段集合：[`memoryFields`](AstrTown/convex/agent/schema.ts:6)
- 表集合：[`memoryTables`](AstrTown/convex/agent/schema.ts:32)、[`agentTables`](AstrTown/convex/agent/schema.ts:47)

#### 3.4.4 定义的函数和变量

- 主要是常量对象（无函数），包含：
  - `memoryFields.data` 的三种 union：relationship / conversation / reflection：[`memoryFields`](AstrTown/convex/agent/schema.ts:6)
  - `memories` 的索引：`embeddingId`、`playerId_type`、`playerId`：[`memoryTables.memories`](AstrTown/convex/agent/schema.ts:33)
  - `memoryEmbeddings` 的 vectorIndex：
    - vectorField: `embedding`
    - filterFields: `playerId`
    - dimensions: [`EMBEDDING_DIMENSION`](AstrTown/convex/agent/schema.ts:4)
    - 定义位置：[`memoryTables.memoryEmbeddings`](AstrTown/convex/agent/schema.ts:37)
  - `embeddingsCache` 的索引：`text`：[`agentTables.embeddingsCache`](AstrTown/convex/agent/schema.ts:49)

#### 3.4.5 文件内部关系 / 文件间关系

- `memoryTables` 被 `agentTables` 复用并扩展：[`agentTables`](AstrTown/convex/agent/schema.ts:47)
- `memoryFields` 被 [`memory.ts`](AstrTown/convex/agent/memory.ts) 导入，用于构造 mutation 的参数 schema：[`memoryFields`](AstrTown/convex/agent/schema.ts:6)

---

## 4. 模块关系图（文字依赖关系）

以 `convex/agent` 内部 4 个文件为节点：

- [`conversation.ts`](AstrTown/convex/agent/conversation.ts)
  - 依赖 [`memory.ts`](AstrTown/convex/agent/memory.ts)：调用 [`searchMemories()`](AstrTown/convex/agent/memory.ts:158)
  - 依赖 [`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts)：调用 [`fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9)

- [`memory.ts`](AstrTown/convex/agent/memory.ts)
  - 依赖 [`schema.ts`](AstrTown/convex/agent/schema.ts)：导入 [`memoryFields`](AstrTown/convex/agent/schema.ts:6)
  - 间接依赖（通过数据表名/索引约定）`schema.ts` 中的 `memoryEmbeddings` vectorIndex 定义：[`memoryTables.memoryEmbeddings`](AstrTown/convex/agent/schema.ts:37)

- [`embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts)
  - 与 [`schema.ts`](AstrTown/convex/agent/schema.ts) 的 `embeddingsCache` 表定义对应（表名与索引名一致）：[`agentTables.embeddingsCache`](AstrTown/convex/agent/schema.ts:49)

- [`schema.ts`](AstrTown/convex/agent/schema.ts)
  - 不依赖其它 agent 文件（纯定义），被 `memory.ts` 与运行时的表/索引引用。

用箭头表示“依赖/调用”关系：

- `conversation.ts -> embeddingsCache.ts`
- `conversation.ts -> memory.ts`
- `memory.ts -> schema.ts`
- `embeddingsCache.ts -> schema.ts`（通过表结构约定对应）

---

## 5. 数据流分析

### 5.1 对话生成数据流（start / continue / leave）

以开场白为例（续聊与离开类似）：

1. **数据库装配 prompt 数据**：
   - [`startConversationMessage()`](AstrTown/convex/agent/conversation.ts:13) 调用 [`queryPromptData`](AstrTown/convex/agent/conversation.ts:249)
   - 输出：player / otherPlayer / agent / otherAgent / lastConversation 等
2. **生成“检索 query embedding”**：
   - 文本：`"${player.name} is talking to ${otherPlayer.name}"`
   - 调用 embedding 缓存：[`embeddingsCache.fetch()`](AstrTown/convex/agent/embeddingsCache.ts:9)
3. **记忆检索**：
   - [`memory.searchMemories()`](AstrTown/convex/agent/memory.ts:158)
   - 内部先 `ctx.vectorSearch`，后 `rankAndTouchMemories` 三因子重排并 touch。
4. **Prompt 构建**：
   - 拼接：身份/目标（[`agentPrompts()`](AstrTown/convex/agent/conversation.ts:185)）
   - 上次聊天时间（[`previousConversationPrompt()`](AstrTown/convex/agent/conversation.ts:201)）
   - 相关记忆列表（[`relatedMemoriesPrompt()`](AstrTown/convex/agent/conversation.ts:218)）
5. **LLM 生成**：
   - `chatCompletion({ messages: [{role:'system', content: prompt.join('\n')}] ... })`
   - stop words：[`stopWords()`](AstrTown/convex/agent/conversation.ts:348)
6. **结果清理**：
   - 去除“前缀提示词”：[`trimContentPrefx()`](AstrTown/convex/agent/conversation.ts:71)

### 5.2 Agent 记忆检索流程

入口：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158)

1. **向量检索候选**：
   - `ctx.vectorSearch('memoryEmbeddings', 'embedding', { vector, filter, limit })`
   - filter：`playerId` 必须匹配（保证是“某个玩家视角的记忆”）
   - limit：`n * MEMORY_OVERFETCH`（默认 3 * 10 = 30）
2. **候选转记忆并排序 + touch**：
   - mutation：[`rankAndTouchMemories`](AstrTown/convex/agent/memory.ts:187)
   - 将 embeddingId 映射回 `memories` 表记录（按 `embeddingId` 索引查）。
   - 计算综合分数后排序，取 top n。
   - 对选中的 memory 做 lastAccess 节流更新：[`MEMORY_ACCESS_THROTTLE`](AstrTown/convex/agent/memory.ts:12)
3. **返回 memories（按最终排序）**：
   - [`searchMemories()`](AstrTown/convex/agent/memory.ts:158) 最终返回 `Memory[]`。

### 5.3 向量搜索机制（在本模块内的落点）

- 向量索引定义：[`memoryTables.memoryEmbeddings`](AstrTown/convex/agent/schema.ts:37)
  - `defineTable({ playerId, embedding: v.array(v.float64()) }).vectorIndex('embedding', ...)`
  - `filterFields: ['playerId']`：支持检索时按 playerId 过滤。
  - `dimensions: EMBEDDING_DIMENSION`：维度与 embedding 模型输出一致。
- 使用位置：[`searchMemories()`](AstrTown/convex/agent/memory.ts:158)

---

## 6. 关键算法

### 6.1 三因子排序算法（相关性 + 重要性 + 近期性）

算法实现位置：[`rankAndTouchMemories`](AstrTown/convex/agent/memory.ts:187)

**输入**：
- `candidates`: `[{ _id: Id<'memoryEmbeddings'>, _score: number }, ...]`（向量检索结果）
- `n`: 期望返回条数

**步骤**：

1. **从 embeddingId 找到 memory**
   - 对每个 candidate：在 `memories` 表上通过 `embeddingId` 索引找对应 memory：
     - `ctx.db.query('memories').withIndex('embeddingId', (q) => q.eq('embeddingId', _id)).first()`
2. **计算近期性分数 recencyScore**
   - `hoursSinceAccess = (now - memory.lastAccess) / 1000 / 60 / 60`
   - `recency = 0.99 ** floor(hoursSinceAccess)`：时间越久分数越低（指数衰减）
3. **三类分数分别归一化（min-max）**
   - 相关性范围：[`makeRange()`](AstrTown/convex/agent/memory.ts:176) 作用于 candidates 的 `_score`
   - 重要性范围：作用于 memories 的 `importance`
   - 近期性范围：作用于 `recencyScore`
   - 归一化函数：[`normalize()`](AstrTown/convex/agent/memory.ts:182)
4. **计算 overallScore 并排序**
   - `overall = norm(relevance) + norm(importance) + norm(recency)`
   - 按 `overallScore desc` 排序，取前 `n`。
5. **touch（更新 lastAccess，带节流）**
   - 若 `memory.lastAccess < now - MEMORY_ACCESS_THROTTLE` 则 `patch({ lastAccess: now })`
   - 节流常量：[`MEMORY_ACCESS_THROTTLE`](AstrTown/convex/agent/memory.ts:12)

**输出**：top n 的 `{ memory, overallScore }`，供 [`searchMemories()`](AstrTown/convex/agent/memory.ts:158) 返回 memories。

> 备注：该算法对向量检索结果进行了二次排序，引入“重要性/近期性”两个非向量维度，使得记忆检索不完全由 embedding 相似度主导。

### 6.2 embedding 缓存的哈希键算法（SHA-256）

实现位置：[`hashText()`](AstrTown/convex/agent/embeddingsCache.ts:54)

- 输入：原始文本 string
- 输出：`ArrayBuffer`（SHA-256 digest）
- 逻辑：
  - 优先使用 WebCrypto：`crypto.subtle.digest('SHA-256', buf)`
  - 若 `crypto` 不存在，则动态 import `node:crypto` 并 `createHash('sha256')`

该 hash 作为 `embeddingsCache.textHash` 的索引字段（[`agentTables.embeddingsCache`](AstrTown/convex/agent/schema.ts:49)），实现“文本内容一致 → 复用 embedding”。

### 6.3 反思（Reflection）生成的阈值触发与 JSON 输出约束

实现位置：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:325)

- 触发条件：最近 100 条记忆中，自上次 reflection 以来的 `importance` 累加 > 500：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:339)
- 输出约束（Prompt）：要求 LLM “只输出 JSON、无换行无空白、可被 JSON.parse() 解析”：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:350)
- 解析失败会捕获异常并记录日志，返回 false：[`reflectOnMemories()`](AstrTown/convex/agent/memory.ts:371)

---

## 特别说明（基于代码可验证事实）

1. `memory.ts` 与 `schema.ts` 的字符数在 workspace 顶层文件列表中未显示（列表被截断），因此表格中这两项字符数标记为“未提供”。
2. 文档中引用到的外部文件（如 `util/llm.ts`、`aiTown/ids.ts`）仅基于 `convex/agent` 文件的 import 语句进行“符号存在性”指认，未对其实现做进一步推断。
