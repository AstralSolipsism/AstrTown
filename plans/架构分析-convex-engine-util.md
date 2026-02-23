# AstrTown Convex engine/util 架构分析（基于源代码）

> 覆盖范围：[`AstrTown/convex/engine/`](AstrTown/convex/engine) 与 [`AstrTown/convex/util/`](AstrTown/convex/util) 目录下**全部源代码文件**（含测试）。
>
> 说明：本文所有结论均来自实际代码阅读；引用遵循“文件/符号 -> 可点击链接”规则。

---

## 1. 模块概述

### 1.1 `engine` 模块整体职责

`engine` 目录提供了一个**通用的、可重放/可并发控制的离散时间模拟引擎骨架**：

- 以 “Engine Doc（表 `engines`）+ Inputs 队列（表 `inputs`）” 作为持久化驱动。
- 每次运行以**Step**为单位推进：在一个 step 内，循环执行多个 tick，并在每个 tick 前处理截止到当前 tick 时间点的输入。
- 通过 `generationNumber` 做乐观并发序列化（防止重叠 step）。
- 通过 `processedInputNumber` 从输入队列中增量读取。

核心抽象与 API 位于：[`AbstractGame`](AstrTown/convex/engine/abstractGame.ts:7) 及其配套的 [`loadEngine`](AstrTown/convex/engine/abstractGame.ts:112)、[`engineInsertInput`](AstrTown/convex/engine/abstractGame.ts:133)、[`applyEngineUpdate`](AstrTown/convex/engine/abstractGame.ts:173)。

### 1.2 `util` 模块整体职责

`util` 目录提供**跨 engine/aiTown/agent 等模块复用**的工具：

- **压缩与编码**：[`compression.ts`](AstrTown/convex/util/compression.ts:1)、[`FastIntegerCompression.ts`](AstrTown/convex/util/FastIntegerCompression.ts:1)、[`xxhash.ts`](AstrTown/convex/util/xxhash.ts:1)
- **几何与路径**：[`geometry.ts`](AstrTown/convex/util/geometry.ts:1)、[`types.ts`](AstrTown/convex/util/types.ts:1)
- **通用数据结构/对象**：[`minheap.ts`](AstrTown/convex/util/minheap.ts:1)、[`object.ts`](AstrTown/convex/util/object.ts:1)
- **异步与调度**：[`asyncMap.ts`](AstrTown/convex/util/asyncMap.ts:9)、[`sleep.ts`](AstrTown/convex/util/sleep.ts:1)
- **类型安全与判别**：[`assertNever.ts`](AstrTown/convex/util/assertNever.ts:2)、[`isSimpleObject.ts`](AstrTown/convex/util/isSimpleObject.ts:1)
- **LLM 访问封装（无依赖）**：[`llm.ts`](AstrTown/convex/util/llm.ts:10)

---

## 2. engine 模块分析

### 2.1 游戏引擎核心抽象：`AbstractGame`

- 通过抽象方法把“输入处理/模拟推进/落盘提交”解耦：
  - [`AbstractGame.handleInput()`](AstrTown/convex/engine/abstractGame.ts:15)：把输入（name,args）映射为可序列化返回值（`convex/values` 的 `Value`）。
  - [`AbstractGame.tick()`](AstrTown/convex/engine/abstractGame.ts:16)：推进 1 个 tick。
  - [`AbstractGame.saveStep()`](AstrTown/convex/engine/abstractGame.ts:20)：把一步的引擎状态与 input 完成结果写入存储（由具体游戏实现决定写哪张表、如何冲突处理）。
- Step 运行逻辑集中于 [`AbstractGame.runStep()`](AstrTown/convex/engine/abstractGame.ts:22)：
  - 从内部 query [`loadInputs`](AstrTown/convex/engine/abstractGame.ts:156) 取本 step 允许处理的 inputs（maxInputsPerStep）。
  - 计算 step 的模拟起点 `startTs`：若引擎已有 `currentTime`，则从 `lastStepTs + tickDuration` 起；否则从 `now` 起（见 [`runStep`](AstrTown/convex/engine/abstractGame.ts:29)）。
  - while 循环限制 `maxTicksPerStep`：每 tick 收集 `received <= currentTs` 的 inputs，逐个调用 [`handleInput`](AstrTown/convex/engine/abstractGame.ts:15) 并捕获错误，累计 `completedInputs`。
  - tick 推进后如果下一 tick 时间 `candidateTs` 已超过当前真实时间 `now` 则停止（见 [`runStep`](AstrTown/convex/engine/abstractGame.ts:70)）。
  - 结束时更新 engine doc 的 `currentTime/lastStepTs/generationNumber/processedInputNumber`，并调用 [`saveStep`](AstrTown/convex/engine/abstractGame.ts:20) 提交。

### 2.2 历史对象系统：`HistoricalObject`

- 目标：为一组连续数值字段维护随时间演化的**分段常值/分段线性可回放**序列，并可压缩成二进制下发。
- 核心类型：[`History`](AstrTown/convex/engine/historicalObject.ts:52)、[`Sample`](AstrTown/convex/engine/historicalObject.ts:57)
- 核心类：[`HistoricalObject`](AstrTown/convex/engine/historicalObject.ts:72)
  - 维护 `data: T` 与 `history: Record<string, History>`。
  - [`HistoricalObject.update()`](AstrTown/convex/engine/historicalObject.ts:108)：检查字段合法性后，对变更字段追加 sample（同一时间戳则覆盖最后值）。禁止时间倒退（见 [`update`](AstrTown/convex/engine/historicalObject.ts:121)）。
  - [`HistoricalObject.pack()`](AstrTown/convex/engine/historicalObject.ts:137)：无历史则返回 `null`，否则调用 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213)。

### 2.3 数据结构定义：engine schema

- 引擎表与输入表的 schema 在 [`engine/schema.ts`](AstrTown/convex/engine/schema.ts:1)
  - `inputs`：包含 `engineId/number/name/args/returnValue/received`，并建立索引 `byInputNumber(engineId, number)`（见 [`engineTables`](AstrTown/convex/engine/schema.ts:53)）。
  - `engines`：包含 `currentTime/lastStepTs/processedInputNumber/running/generationNumber`（见 [`engine`](AstrTown/convex/engine/schema.ts:35)）。

---

## 3. util 模块分析

### 3.1 工具函数分类与用途总览

| 分类 | 相关文件 | 主要导出 | 主要用途 |
|---|---|---|---|
| 断言/类型安全 | [`assertNever.ts`](AstrTown/convex/util/assertNever.ts) | [`assertNever`](AstrTown/convex/util/assertNever.ts:2) | 联合类型 exhaustiveness 检查 |
| 异步批处理 | [`asyncMap.ts`](AstrTown/convex/util/asyncMap.ts) | [`asyncMap`](AstrTown/convex/util/asyncMap.ts:9) | 并发 `Promise.all` map |
| 压缩（数列） | [`compression.ts`](AstrTown/convex/util/compression.ts) | [`quantize`](AstrTown/convex/util/compression.ts:1)、[`deltaEncode`](AstrTown/convex/util/compression.ts:11)、[`runLengthEncode`](AstrTown/convex/util/compression.ts:32)… | 量化/差分/RLE 编解码 |
| 变长整数压缩 | [`FastIntegerCompression.ts`](AstrTown/convex/util/FastIntegerCompression.ts) | [`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)、[`uncompressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:186)… | varint + zigzag 编码压缩整数数组 |
| 哈希 | [`xxhash.ts`](AstrTown/convex/util/xxhash.ts) | [`xxHash32`](AstrTown/convex/util/xxhash.ts:61)、[`toUtf8`](AstrTown/convex/util/xxhash.ts:33) | 32-bit xxHash（用于配置一致性校验） |
| 几何/路径 | [`types.ts`](AstrTown/convex/util/types.ts)、[`geometry.ts`](AstrTown/convex/util/geometry.ts) | `Point/Vector/Path` 与路径插值/压缩 | 角色移动、路径回放与压缩 |
| 数据结构 | [`minheap.ts`](AstrTown/convex/util/minheap.ts) | [`MinHeap`](AstrTown/convex/util/minheap.ts:2) | 1-indexed 最小堆 |
| 对象/序列化 | [`object.ts`](AstrTown/convex/util/object.ts) | [`parseMap`](AstrTown/convex/util/object.ts:1)、[`serializeMap`](AstrTown/convex/util/object.ts:18) | 数组<->Map 解析/序列化 |
| 小工具 | [`sleep.ts`](AstrTown/convex/util/sleep.ts) | [`sleep`](AstrTown/convex/util/sleep.ts:1) | 延迟 |
| 对象判别 | [`isSimpleObject.ts`](AstrTown/convex/util/isSimpleObject.ts) | [`isSimpleObject`](AstrTown/convex/util/isSimpleObject.ts:1) | 判断“简单对象”原型 |
| LLM 访问 | [`llm.ts`](AstrTown/convex/util/llm.ts) | [`getLLMConfig`](AstrTown/convex/util/llm.ts:70)、[`chatCompletion`](AstrTown/convex/util/llm.ts:146)、[`fetchEmbeddingBatch`](AstrTown/convex/util/llm.ts:231)… | 统一封装 OpenAI/Together/Ollama/Custom 的 chat/embedding/moderation |

---

## 4. 详细分析（逐文件）

> 统一说明：本节“文件行数”基于本次读取到的行号范围；“字符数”若用户提供则沿用清单，否则以仓库列表中的 `# chars` 作为近似。

### 4.1 engine/abstractGame.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/engine/abstractGame.ts`](AstrTown/convex/engine/abstractGame.ts)
- 功能概述：
  - 定义引擎抽象基类 [`AbstractGame`](AstrTown/convex/engine/abstractGame.ts:7)，提供 step/tick/input 消费与提交骨架。
  - 提供 engine 输入读写与更新应用：[`engineInsertInput`](AstrTown/convex/engine/abstractGame.ts:133)、[`loadInputs`](AstrTown/convex/engine/abstractGame.ts:156)、[`applyEngineUpdate`](AstrTown/convex/engine/abstractGame.ts:173)。
- 行数/字符数：约 199 行（本次读取到 199 行），清单字符数 6154。

#### 2) 导入的模块
- `convex/values`：`ConvexError, Infer, Value, v`（见 [`abstractGame.ts`](AstrTown/convex/engine/abstractGame.ts:1)）
  - `v/Infer` 用于定义与推断 `EngineUpdate` 的验证 schema。
  - `ConvexError` 用于向客户端/调用方抛出结构化错误。
- `../_generated/dataModel`：`Doc, Id`（见 [`abstractGame.ts`](AstrTown/convex/engine/abstractGame.ts:2)）
  - Convex 生成类型，标注表 doc 与 id。
- `../_generated/server`：`ActionCtx, DatabaseReader, MutationCtx, internalQuery`（见 [`abstractGame.ts`](AstrTown/convex/engine/abstractGame.ts:3)）
  - Convex 函数上下文与内部 query 定义。
- `../engine/schema`：`engine`（见 [`abstractGame.ts`](AstrTown/convex/engine/abstractGame.ts:4)）
  - 引擎 doc 的 `v.object` schema，用于 `engineUpdate`。
- `../_generated/api`：`internal`（见 [`abstractGame.ts`](AstrTown/convex/engine/abstractGame.ts:5)）
  - 用于在 action 中调用内部 query：[`internal.engine.abstractGame.loadInputs`](AstrTown/convex/engine/abstractGame.ts:23)。

#### 3) 导出的内容
- 类：[`AbstractGame`](AstrTown/convex/engine/abstractGame.ts:7)
- schema 与类型：[`engineUpdate`](AstrTown/convex/engine/abstractGame.ts:105)、[`EngineUpdate`](AstrTown/convex/engine/abstractGame.ts:110)
- 函数：[`loadEngine`](AstrTown/convex/engine/abstractGame.ts:112)、[`engineInsertInput`](AstrTown/convex/engine/abstractGame.ts:133)、[`loadInputs`](AstrTown/convex/engine/abstractGame.ts:156)（内部 query 常量导出）、[`applyEngineUpdate`](AstrTown/convex/engine/abstractGame.ts:173)

#### 4) 定义的函数和变量
- `completedInput`：`v.object`，描述输入完成记录（inputId + returnValue union）（见 [`completedInput`](AstrTown/convex/engine/abstractGame.ts:91)）。
- [`AbstractGame.runStep()`](AstrTown/convex/engine/abstractGame.ts:22)
  - 参数：`(ctx: ActionCtx, now: number)`
  - 返回：`Promise<void>`
  - 关键变量：`inputs/currentTs/inputIndex/numTicks/processedInputNumber/completedInputs`（见 [`runStep`](AstrTown/convex/engine/abstractGame.ts:22)）。
- [`loadEngine`](AstrTown/convex/engine/abstractGame.ts:112)
  - 参数：`(db: DatabaseReader, engineId: Id<'engines'>, generationNumber: number)`
  - 行为：校验 engine 存在、`running` 为真、`generationNumber` 匹配；失败抛 `ConvexError` 或 `Error`。
- [`engineInsertInput`](AstrTown/convex/engine/abstractGame.ts:133)
  - 参数：`(ctx: MutationCtx, engineId, name, args)`
  - 行为：查询 inputs 最新 `number`，分配自增 number，插入 inputs，返回 inputId。
- [`loadInputs`](AstrTown/convex/engine/abstractGame.ts:156)
  - internalQuery：按索引 `byInputNumber` 取 `number > processedInputNumber` 的 inputs，升序取 `max`。
- [`applyEngineUpdate`](AstrTown/convex/engine/abstractGame.ts:173)
  - 参数：`(ctx: MutationCtx, engineId, update)`
  - 行为：
    - 通过 [`loadEngine`](AstrTown/convex/engine/abstractGame.ts:112) 做并发校验。
    - 检查时间不倒退（见 [`applyEngineUpdate`](AstrTown/convex/engine/abstractGame.ts:179)）。
    - `replace` engines doc。
    - 遍历 `completedInputs`，对每个 input：校验存在且未完成，然后写入 `returnValue` 并 replace。

#### 5) 文件内部关系
- [`runStep`](AstrTown/convex/engine/abstractGame.ts:22) 依赖内部 query [`loadInputs`](AstrTown/convex/engine/abstractGame.ts:156) 来取输入。
- 提交阶段由抽象方法 [`saveStep`](AstrTown/convex/engine/abstractGame.ts:20) 承接；具体实现通常会在 mutation 中调用 [`applyEngineUpdate`](AstrTown/convex/engine/abstractGame.ts:173) 完成落盘。

#### 6) 文件间关系
- 引用本文件的关键位置（来自全仓 regex 搜索结果）：
  - [`engineInsertInput`](AstrTown/convex/engine/abstractGame.ts:133) 被 [`AstrTown/convex/world.ts`](AstrTown/convex/world.ts:13) 与 [`AstrTown/convex/aiTown/insertInput.ts`](AstrTown/convex/aiTown/insertInput.ts:3) 引用。
  - [`loadEngine`](AstrTown/convex/engine/abstractGame.ts:112) 在 [`AstrTown/convex/aiTown/game.ts`](AstrTown/convex/aiTown/game.ts:24) 引用。
- 本文件引用：
  - schema：[`engine`](AstrTown/convex/engine/schema.ts:35)
  - Convex generated API：`internal` 等。
- 架构位置：engine 模块的“调度与一致性”核心。

---

### 4.2 engine/schema.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/engine/schema.ts`](AstrTown/convex/engine/schema.ts)
- 功能概述：定义 engine 子系统表结构与输入结构。
- 行数/字符数：约 56 行；清单字符数 1823。

#### 2) 导入的模块
- `convex/server`：`defineTable`（见 [`schema.ts`](AstrTown/convex/engine/schema.ts:1)）
- `convex/values`：`Infer, v`（见 [`schema.ts`](AstrTown/convex/engine/schema.ts:2)）

#### 3) 导出的内容
- 常量：[`engine`](AstrTown/convex/engine/schema.ts:35)、[`engineTables`](AstrTown/convex/engine/schema.ts:53)
- 类型：[`Engine`](AstrTown/convex/engine/schema.ts:51)

#### 4) 定义的函数和变量
- `input`：inputs 表 doc schema（见 [`input`](AstrTown/convex/engine/schema.ts:4)）。
- [`engine`](AstrTown/convex/engine/schema.ts:35)：引擎状态 doc schema。
- [`engineTables`](AstrTown/convex/engine/schema.ts:53)：包含 `inputs` 与 `engines` 两张表。

#### 5) 文件内部关系
- `Engine` 类型由 `Infer<typeof engine>` 得出（见 [`Engine`](AstrTown/convex/engine/schema.ts:51)）。

#### 6) 文件间关系
- [`engine`](AstrTown/convex/engine/schema.ts:35) 被 [`engineUpdate`](AstrTown/convex/engine/abstractGame.ts:105) 复用。
- `engineTables` 应被更上层 schema 聚合（本次任务范围外，但该导出显然用于主 schema 组合）。

---

### 4.3 engine/historicalObject.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/engine/historicalObject.ts`](AstrTown/convex/engine/historicalObject.ts)
- 功能概述：
  - 历史对象：记录多个数值字段的时间序列变更；
  - 提供“样本记录”压缩格式：字段配置哈希校验 + 时间戳压缩 + 值压缩。
- 行数/字符数：约 355 行；清单字符数 11726。

#### 2) 导入的模块
- [`xxHash32`](AstrTown/convex/util/xxhash.ts:61) 来自 [`../util/xxhash`](AstrTown/convex/util/xxhash.ts:1)
  - 用于对字段配置做 32-bit hash，保证解包时 config 一致（见 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:221) 与 [`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:288)）。
- [`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)、[`uncompressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:186) 来自 [`../util/FastIntegerCompression`](AstrTown/convex/util/FastIntegerCompression.ts:1)
  - 用于把编码后的整数数组压缩到字节流（varint）。
- 来自 [`../util/compression`](AstrTown/convex/util/compression.ts:1)
  - [`runLengthEncode`](AstrTown/convex/util/compression.ts:32)/[`runLengthDecode`](AstrTown/convex/util/compression.ts:58)
  - [`deltaEncode`](AstrTown/convex/util/compression.ts:11)/[`deltaDecode`](AstrTown/convex/util/compression.ts:21)
  - [`quantize`](AstrTown/convex/util/compression.ts:1)/[`unquantize`](AstrTown/convex/util/compression.ts:6)

#### 3) 导出的内容
- 类型：[`FieldConfig`](AstrTown/convex/engine/historicalObject.ts:20)、[`History`](AstrTown/convex/engine/historicalObject.ts:52)、[`Sample`](AstrTown/convex/engine/historicalObject.ts:57)
- 类：[`HistoricalObject`](AstrTown/convex/engine/historicalObject.ts:72)
- 函数：[`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213)、[`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283)

#### 4) 定义的函数和变量
- 常量：`MAX_FIELDS=16`（见 [`MAX_FIELDS`](AstrTown/convex/engine/historicalObject.ts:23)）、`PACKED_VERSION=1`（见 [`PACKED_VERSION`](AstrTown/convex/engine/historicalObject.ts:25)）。
- 内部类型：`NormalizedFieldConfig`（见 [`NormalizedFieldConfig`](AstrTown/convex/engine/historicalObject.ts:27)）。
- 方法：
  - [`HistoricalObject.historyLength()`](AstrTown/convex/engine/historicalObject.ts:89)：统计所有字段 samples 总数。
  - [`HistoricalObject.checkShape()`](AstrTown/convex/engine/historicalObject.ts:95)：校验字段声明与数值类型。
  - [`HistoricalObject.update()`](AstrTown/convex/engine/historicalObject.ts:108)：追加/覆盖 sample。
  - [`HistoricalObject.pack()`](AstrTown/convex/engine/historicalObject.ts:137)：生成压缩 buffer 或 null。
- 内部函数：
  - `packFieldConfig(fields)`（见 [`packFieldConfig`](AstrTown/convex/engine/historicalObject.ts:155)）：把字段名与精度序列化成 buffer（版本+nameLen+name+precision）。
  - [`normalizeFieldConfig`](AstrTown/convex/engine/historicalObject.ts:353)：把 `string | {name,precision}` 归一。

#### 5) 文件内部关系
- [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213) 调用链：
  - `packFieldConfig` -> [`xxHash32`](AstrTown/convex/util/xxhash.ts:61)
  - 时间戳：[`deltaEncode`](AstrTown/convex/util/compression.ts:11) -> [`runLengthEncode`](AstrTown/convex/util/compression.ts:32) -> [`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)
  - 值：[`quantize`](AstrTown/convex/util/compression.ts:1) -> [`deltaEncode`](AstrTown/convex/util/compression.ts:11) -> (可选)[`runLengthEncode`](AstrTown/convex/util/compression.ts:32) -> [`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)
- [`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283) 反向解码：
  - 校验 config hash -> 读取 fieldHeader -> 解 timestamp buffer（[`uncompressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:186) -> [`runLengthDecode`](AstrTown/convex/util/compression.ts:58) -> [`deltaDecode`](AstrTown/convex/util/compression.ts:21)）
  - 解 values buffer（[`uncompressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:186) -> (可选)[`runLengthDecode`](AstrTown/convex/util/compression.ts:58) -> [`deltaDecode`](AstrTown/convex/util/compression.ts:21) -> [`unquantize`](AstrTown/convex/util/compression.ts:6)）

#### 6) 文件间关系
- 被引用：
  - `FieldConfig` 在 [`AstrTown/convex/aiTown/location.ts`](AstrTown/convex/aiTown/location.ts:1) 引用。
  - `HistoricalObject` 在 [`AstrTown/convex/aiTown/game.ts`](AstrTown/convex/aiTown/game.ts:27) 引用。
- 引用 util：`xxhash`、`FastIntegerCompression`、`compression`。
- 架构位置：为引擎/游戏对象提供“高频连续值”的网络友好序列化与一致性校验。

---

### 4.4 engine/historicalObject.test.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/engine/historicalObject.test.ts`](AstrTown/convex/engine/historicalObject.test.ts)
- 功能概述：验证 sample record 的 pack/unpack 近似回环（量化误差范围内）。
- 行数/字符数：约 47 行；清单字符数 1770。

#### 2) 导入的模块
- 从 [`./historicalObject`](AstrTown/convex/engine/historicalObject.ts:1) 导入：
  - [`History`](AstrTown/convex/engine/historicalObject.ts:52)
  - [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213)
  - [`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283)

#### 3) 导出的内容
- 无（测试文件）。

#### 4) 定义的函数和变量
- 测试用数据 `data: Record<string, History>`（见 [`historicalObject.test.ts`](AstrTown/convex/engine/historicalObject.test.ts:5)）。
- `fields = [{name, precision}]`（见 [`historicalObject.test.ts`](AstrTown/convex/engine/historicalObject.test.ts:25)）。
- 断言：
  - key 一致
  - initialValue 与 sample.value 在 `maxError` 内（`maxError = max(1/2^precision, 1e-8)`，见 [`historicalObject.test.ts`](AstrTown/convex/engine/historicalObject.test.ts:31)）
  - sample.time 严格相等

#### 5) 文件内部关系
- pack -> unpack -> 逐字段逐样本比对。

#### 6) 文件间关系
- 覆盖 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213)/[`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283) 的正确性与误差界。

---

### 4.5 util/assertNever.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/assertNever.ts`](AstrTown/convex/util/assertNever.ts)
- 功能概述：联合类型穷尽校验辅助函数。
- 行数/字符数：约 4 行；清单字符数 228。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- 函数：[`assertNever`](AstrTown/convex/util/assertNever.ts:2)

#### 4) 定义的函数和变量
- [`assertNever(x: never): never`](AstrTown/convex/util/assertNever.ts:2)：直接 throw。

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 被引用：[`AstrTown/convex/aiTown/agentOperations.ts`](AstrTown/convex/aiTown/agentOperations.ts:11)（根据搜索结果）。

---

### 4.6 util/asyncMap.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/asyncMap.ts`](AstrTown/convex/util/asyncMap.ts)
- 功能概述：对可迭代对象并发执行异步 transform，返回结果数组。
- 行数/字符数：约 20 行；清单字符数 575。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- 函数：[`asyncMap`](AstrTown/convex/util/asyncMap.ts:9)

#### 4) 定义的函数和变量
- [`asyncMap<FromType, ToType>`](AstrTown/convex/util/asyncMap.ts:9)
  - 参数：`list: Iterable<FromType>`，`asyncTransform: (item, index) => Promise<ToType>`
  - 返回：`Promise<ToType[]>`
  - 实现：构造 promises 列表，迭代推进 idx，最终 `Promise.all`。

#### 5) 文件内部关系
- 单函数实现。

#### 6) 文件间关系
- 被引用：[`AstrTown/convex/agent/memory.ts`](AstrTown/convex/agent/memory.ts:6)（搜索结果）。

---

### 4.7 util/asyncMap.test.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/asyncMap.test.ts`](AstrTown/convex/util/asyncMap.test.ts)
- 功能概述：验证 `asyncMap` 对非空/空列表的行为。
- 行数/字符数：约 15 行；清单字符数 492。

#### 2) 导入的模块
- [`asyncMap`](AstrTown/convex/util/asyncMap.ts:9) from [`./asyncMap`](AstrTown/convex/util/asyncMap.ts:1)

#### 3) 导出的内容
- 无。

#### 4) 定义的函数和变量
- 两个测试：
  - 非空：[1,2,3] -> *2
  - 空：[] -> []

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 覆盖 [`asyncMap`](AstrTown/convex/util/asyncMap.ts:9) 的基本语义。

---

### 4.8 util/compression.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/compression.ts`](AstrTown/convex/util/compression.ts)
- 功能概述：提供数值序列的量化/反量化、差分编解码、RLE 编解码。
- 行数/字符数：约 71 行；清单字符数 1745。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- 函数：
  - [`quantize`](AstrTown/convex/util/compression.ts:1)
  - [`unquantize`](AstrTown/convex/util/compression.ts:6)
  - [`deltaEncode`](AstrTown/convex/util/compression.ts:11)
  - [`deltaDecode`](AstrTown/convex/util/compression.ts:21)
  - [`runLengthEncode`](AstrTown/convex/util/compression.ts:32)
  - [`runLengthDecode`](AstrTown/convex/util/compression.ts:58)

#### 4) 定义的函数和变量
- 量化：`factor = 1 << precision`（见 [`quantize`](AstrTown/convex/util/compression.ts:1)）。注意 precision 为负数时，位移在 JS 中会按 32 位处理（本库测试覆盖了 `precision = -1`，见 [`compression.test.ts`](AstrTown/convex/util/compression.test.ts:12)）。
- 差分：支持传入 `initialValue`（默认 0）。
- RLE：编码输出 `[value,count,value,count,...]`；解码时要求偶数长度（见 [`runLengthDecode`](AstrTown/convex/util/compression.ts:59)）。

#### 5) 文件内部关系
- 无复杂调用链，函数彼此独立。

#### 6) 文件间关系
- 被 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213) 与 [`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283) 用于时间戳/数值序列预编码。

---

### 4.9 util/compression.test.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/compression.test.ts`](AstrTown/convex/util/compression.test.ts)
- 功能概述：验证 quantize/unquantize 近似回环、delta 编解码回环、RLE 编解码回环。
- 行数/字符数：本次读取到 90 行（文件可能更长但测试主体已覆盖）；清单字符数 3654。

#### 2) 导入的模块
- 从 [`./compression`](AstrTown/convex/util/compression.ts:1) 导入：
  - [`deltaDecode`](AstrTown/convex/util/compression.ts:21)、[`deltaEncode`](AstrTown/convex/util/compression.ts:11)
  - [`quantize`](AstrTown/convex/util/compression.ts:1)、[`unquantize`](AstrTown/convex/util/compression.ts:6)
  - [`runLengthDecode`](AstrTown/convex/util/compression.ts:58)、[`runLengthEncode`](AstrTown/convex/util/compression.ts:32)

#### 3) 导出的内容
- 无。

#### 4) 定义的函数和变量
- `quantize` 测试覆盖多个数据集与 precision（含 -1），误差界同 historicalObject 测试的 `maxError`（见 [`compression.test.ts`](AstrTown/convex/util/compression.test.ts:48)）。
- `deltaEncode` roundtrip：随机整数数组（见 [`compression.test.ts`](AstrTown/convex/util/compression.test.ts:61)）。
- `runLengthEncode` roundtrip：无重复/全重复/单值/中间重复（见 [`compression.test.ts`](AstrTown/convex/util/compression.test.ts:71)）。

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 验证 [`compression.ts`](AstrTown/convex/util/compression.ts:1) 的核心编码函数。

---

### 4.10 util/FastIntegerCompression.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/FastIntegerCompression.ts`](AstrTown/convex/util/FastIntegerCompression.ts)
- 功能概述：来自 Lemire 的 FastIntegerCompression.js 实现（varint 编码），并扩展 signed 版本（zigzag）。
- 行数/字符数：约 221 行；清单字符数 6772。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- 函数：
  - [`computeCompressedSizeInBytes`](AstrTown/convex/util/FastIntegerCompression.ts:42)
  - [`computeCompressedSizeInBytesSigned`](AstrTown/convex/util/FastIntegerCompression.ts:53)
  - [`compress`](AstrTown/convex/util/FastIntegerCompression.ts:65)
  - [`computeHowManyIntegers`](AstrTown/convex/util/FastIntegerCompression.ts:99)
  - [`uncompress`](AstrTown/convex/util/FastIntegerCompression.ts:111)
  - [`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)
  - [`uncompressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:186)

#### 4) 定义的函数和变量
- 内部函数：`bytelog`、`zigzag_encode`、`zigzag_decode`（见 [`FastIntegerCompression.ts`](AstrTown/convex/util/FastIntegerCompression.ts:19)）。
- `compress/uncompress`：对非负整数数组进行 varint 编码。
- `compressSigned/uncompressSigned`：对有符号整数数组先 zigzag 再 varint。

#### 5) 文件内部关系
- signed 与 unsigned 共享相同的 varint 编码形态，只是入参映射不同。

#### 6) 文件间关系
- 被 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213)/[`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283) 用作最终字节级压缩层。

---

### 4.11 util/types.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/types.ts`](AstrTown/convex/util/types.ts)
- 功能概述：定义 Point/Vector/Path 的 Convex schema 与 TS 类型，并提供 PathComponent 的 pack/unpack/query。
- 行数/字符数：约 33 行；清单字符数 1017。

#### 2) 导入的模块
- `convex/values`：`Infer, v`（见 [`types.ts`](AstrTown/convex/util/types.ts:1)）。

#### 3) 导出的内容
- schema 与类型：
  - [`point`](AstrTown/convex/util/types.ts:3)、[`Point`](AstrTown/convex/util/types.ts:7)
  - [`vector`](AstrTown/convex/util/types.ts:9)、[`Vector`](AstrTown/convex/util/types.ts:13)
  - [`path`](AstrTown/convex/util/types.ts:16)、[`Path`](AstrTown/convex/util/types.ts:17)
- 类型：[`PathComponent`](AstrTown/convex/util/types.ts:19)
- 函数：[`queryPath`](AstrTown/convex/util/types.ts:21)、[`packPathComponent`](AstrTown/convex/util/types.ts:24)、[`unpackPathComponent`](AstrTown/convex/util/types.ts:27)

#### 4) 定义的函数和变量
- [`queryPath`](AstrTown/convex/util/types.ts:21)：取 path[at] 并解包。
- [`packPathComponent`](AstrTown/convex/util/types.ts:24)：对象 -> 元组 `[x,y,dx,dy,t]`。
- [`unpackPathComponent`](AstrTown/convex/util/types.ts:27)：元组 -> 对象。

#### 5) 文件内部关系
- `queryPath` 直接调用 `unpackPathComponent`（见 [`queryPath`](AstrTown/convex/util/types.ts:21)）。

#### 6) 文件间关系
- 被 [`geometry.ts`](AstrTown/convex/util/geometry.ts:1) 导入用于路径插值与压缩。
- 在 aiTown 多处使用（如 [`AstrTown/convex/aiTown/player.ts`](AstrTown/convex/aiTown/player.ts:2)、[`AstrTown/convex/aiTown/movement.ts`](AstrTown/convex/aiTown/movement.ts:5)）。

---

### 4.12 util/types.test.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/types.test.ts`](AstrTown/convex/util/types.test.ts)
- 功能概述：验证 `queryPath/packPathComponent/unpackPathComponent`。
- 行数/字符数：约 42 行；清单字符数 1194。

#### 2) 导入的模块
- 从 [`./types`](AstrTown/convex/util/types.ts:1) 导入：
  - `Path, PathComponent`
  - [`packPathComponent`](AstrTown/convex/util/types.ts:24)
  - [`queryPath`](AstrTown/convex/util/types.ts:21)
  - [`unpackPathComponent`](AstrTown/convex/util/types.ts:27)

#### 3) 导出的内容
- 无。

#### 4) 定义的函数和变量
- 三个 describe 块：分别覆盖 query/pack/unpack。

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 覆盖 [`types.ts`](AstrTown/convex/util/types.ts:1) 的核心函数。

---

### 4.13 util/geometry.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/geometry.ts`](AstrTown/convex/util/geometry.ts)
- 功能概述：提供几何计算、路径时间插值、路径压缩（去除可线性插值的中间点）。
- 行数/字符数：约 132 行；清单字符数 4203。

#### 2) 导入的模块
- 从 [`./types`](AstrTown/convex/util/types.ts:1) 导入：`Path, PathComponent, Point, Vector, packPathComponent, queryPath`（见 [`geometry.ts`](AstrTown/convex/util/geometry.ts:1)）。

#### 3) 导出的内容
- 函数：
  - [`distance`](AstrTown/convex/util/geometry.ts:3)
  - [`pointsEqual`](AstrTown/convex/util/geometry.ts:9)
  - [`manhattanDistance`](AstrTown/convex/util/geometry.ts:13)
  - [`pathOverlaps`](AstrTown/convex/util/geometry.ts:17)
  - [`pathPosition`](AstrTown/convex/util/geometry.ts:26)
  - [`vector`](AstrTown/convex/util/geometry.ts:62)
  - [`vectorLength`](AstrTown/convex/util/geometry.ts:68)
  - [`normalize`](AstrTown/convex/util/geometry.ts:72)
  - [`orientationDegrees`](AstrTown/convex/util/geometry.ts:84)
  - [`compressPath`](AstrTown/convex/util/geometry.ts:93)
- 常量：[`EPSILON`](AstrTown/convex/util/geometry.ts:60)

#### 4) 定义的函数和变量
- [`pathPosition`](AstrTown/convex/util/geometry.ts:26)：
  - 输入：`path: Path, time: number`
  - 输出：`{ position: Point; facing: Vector; velocity: number }`
  - 语义：对 path 的相邻点按时间线性插值位置，facing 取 segmentStart.facing，velocity 为段距离/时间差。
- [`compressPath`](AstrTown/convex/util/geometry.ts:93)：
  - 输入：稠密 PathComponent[]
  - 输出：压缩后的 `Path`（packed 元组数组）
  - 规则：若候选点可由 `last` 与 `point` 对其时间插值得到同样 position/facing（误差 < EPSILON），则丢弃该候选点；否则保留。

#### 5) 文件内部关系
- [`compressPath`](AstrTown/convex/util/geometry.ts:93) 在判定中调用 [`pathPosition`](AstrTown/convex/util/geometry.ts:26) 与 [`distance`](AstrTown/convex/util/geometry.ts:3)、[`vectorLength`](AstrTown/convex/util/geometry.ts:68)。

#### 6) 文件间关系
- 被引用：
  - [`distance`](AstrTown/convex/util/geometry.ts:3) 在 [`AstrTown/convex/testing.ts`](AstrTown/convex/testing.ts:20)、[`AstrTown/convex/aiTown/game.ts`](AstrTown/convex/aiTown/game.ts:16) 等引用（搜索结果）。
  - `compressPath` 与 `MinHeap` 一起在 [`AstrTown/convex/aiTown/movement.ts`](AstrTown/convex/aiTown/movement.ts:3) 使用（搜索结果）。

---

### 4.14 util/geometry.test.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/geometry.test.ts`](AstrTown/convex/util/geometry.test.ts)
- 功能概述：覆盖 geometry 的大多数公开函数，包括路径插值、方向角、路径压缩。
- 行数/字符数：本次读取到 298 行；清单字符数 9242。

#### 2) 导入的模块
- 从 [`./geometry`](AstrTown/convex/util/geometry.ts:1) 导入：
  - [`compressPath`](AstrTown/convex/util/geometry.ts:93)、[`distance`](AstrTown/convex/util/geometry.ts:3)、[`manhattanDistance`](AstrTown/convex/util/geometry.ts:13)、[`normalize`](AstrTown/convex/util/geometry.ts:72)、[`orientationDegrees`](AstrTown/convex/util/geometry.ts:84)、[`pathOverlaps`](AstrTown/convex/util/geometry.ts:17)、[`pathPosition`](AstrTown/convex/util/geometry.ts:26)、[`pointsEqual`](AstrTown/convex/util/geometry.ts:9)、[`vector`](AstrTown/convex/util/geometry.ts:62)、[`vectorLength`](AstrTown/convex/util/geometry.ts:68)
- 从 [`./types`](AstrTown/convex/util/types.ts:1) 导入：`Path, Vector`

#### 3) 导出的内容
- 无。

#### 4) 定义的函数和变量
- 覆盖点：
  - 距离/曼哈顿距离/相等性
  - `pathOverlaps` 对 path 长度校验与边界
  - `pathPosition` 的越界与插值
  - `normalize` 对 EPSILON
  - `orientationDegrees` 四象限
  - `compressPath` 对直线与转弯

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 高覆盖度验证 [`geometry.ts`](AstrTown/convex/util/geometry.ts:1)。

---

### 4.15 util/minheap.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/minheap.ts`](AstrTown/convex/util/minheap.ts)
- 功能概述：1-indexed min-heap（通过比较函数定义优先级）。
- 行数/字符数：约 38 行；清单字符数 1302。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- 工厂函数：[`MinHeap`](AstrTown/convex/util/minheap.ts:2)

#### 4) 定义的函数和变量
- [`MinHeap<T>(compare)`](AstrTown/convex/util/minheap.ts:2)
  - 返回对象方法：
    - [`peek`](AstrTown/convex/util/minheap.ts:6)：看最小元素
    - [`length`](AstrTown/convex/util/minheap.ts:7)
    - [`push`](AstrTown/convex/util/minheap.ts:8)：上滤
    - [`pop`](AstrTown/convex/util/minheap.ts:19)：下滤
- 内部状态：`tree`（首元素为 null 占位），`endIndex`（下一插入位置）。

#### 5) 文件内部关系
- `push/pop` 共享 `tree/endIndex`，通过位运算求父子索引。

#### 6) 文件间关系
- 被引用：[`AstrTown/convex/aiTown/movement.ts`](AstrTown/convex/aiTown/movement.ts:4)（搜索结果）。

---

### 4.16 util/minheap.test.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/minheap.test.ts`](AstrTown/convex/util/minheap.test.ts)
- 功能概述：验证 MinHeap 的基本堆性质与自定义比较函数。
- 行数/字符数：约 62 行；清单字符数 1798。

#### 2) 导入的模块
- [`MinHeap`](AstrTown/convex/util/minheap.ts:2) from [`./minheap`](AstrTown/convex/util/minheap.ts:1)

#### 3) 导出的内容
- 无。

#### 4) 定义的函数和变量
- `compareNumbers = (a,b) => a > b`（见 [`minheap.test.ts`](AstrTown/convex/util/minheap.test.ts:4)）：使更小的数成为堆顶。
- 测试：空堆、push 后 peek/length、pop 顺序、空 pop、空 peek、字符串按长度比较。

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 验证 [`MinHeap`](AstrTown/convex/util/minheap.ts:2)。

---

### 4.17 util/object.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/object.ts`](AstrTown/convex/util/object.ts)
- 功能概述：Map 的 parse/serialize 辅助。
- 行数/字符数：约 22 行；清单字符数 623。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- [`parseMap`](AstrTown/convex/util/object.ts:1)
- [`serializeMap`](AstrTown/convex/util/object.ts:18)

#### 4) 定义的函数和变量
- [`parseMap`](AstrTown/convex/util/object.ts:1)
  - 输入：`records[]`、`constructor`（new）、`getId`
  - 输出：`Map<Id, Parsed>`（运行时 `new Map()` 未显式泛型）
  - 语义：构造 Parsed，提取 id，检测重复。
- [`serializeMap`](AstrTown/convex/util/object.ts:18)
  - 输入：`Map<string, T extends { serialize(): Serialized }>`
  - 输出：`Serialized[]`

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 被引用：
  - [`AstrTown/convex/aiTown/game.ts`](AstrTown/convex/aiTown/game.ts:29)
  - [`AstrTown/convex/aiTown/world.ts`](AstrTown/convex/aiTown/world.ts:6)
  - [`AstrTown/convex/aiTown/conversation.ts`](AstrTown/convex/aiTown/conversation.ts:13)

---

### 4.18 util/sleep.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/sleep.ts`](AstrTown/convex/util/sleep.ts)
- 功能概述：Promise 包装的 setTimeout。
- 行数/字符数：约 3 行；清单字符数 107。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- [`sleep`](AstrTown/convex/util/sleep.ts:1)

#### 4) 定义的函数和变量
- [`sleep(ms)`](AstrTown/convex/util/sleep.ts:1)：返回 `new Promise(resolve => setTimeout(resolve, ms))`。

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 未在本次 regex 结果中出现（不代表全仓未使用，仅代表本次模式搜索未覆盖到）。

---

### 4.19 util/isSimpleObject.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/isSimpleObject.ts`](AstrTown/convex/util/isSimpleObject.ts)
- 功能概述：判断 unknown 是否为“简单对象”（原型为 null/Object.prototype/或构造名为 Object）。
- 行数/字符数：约 11 行；清单字符数 477。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- [`isSimpleObject`](AstrTown/convex/util/isSimpleObject.ts:1)

#### 4) 定义的函数和变量
- [`isSimpleObject(value)`](AstrTown/convex/util/isSimpleObject.ts:1)
  - 注意：`typeof null === 'object'`，且 `Object.getPrototypeOf(null)` 会抛错；该实现未显式防护 null（这是代码事实，需上层保证入参非 null）。

#### 5) 文件内部关系
- 无。

#### 6) 文件间关系
- 未在本次 regex 结果中出现。

---

### 4.20 util/xxhash.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/xxhash.ts`](AstrTown/convex/util/xxhash.ts)
- 功能概述：xxHash32 的纯 TS/JS 实现，含 UTF-8 编码辅助。
- 行数/字符数：本次读取到 228 行；仓库列表显示 8444 chars。

#### 2) 导入的模块
- 无。

#### 3) 导出的内容
- [`toUtf8`](AstrTown/convex/util/xxhash.ts:33)
- [`xxHash32`](AstrTown/convex/util/xxhash.ts:61)

#### 4) 定义的函数和变量
- 常量：`PRIME32_1..5`（见 [`xxhash.ts`](AstrTown/convex/util/xxhash.ts:27)）。
- [`xxHash32`](AstrTown/convex/util/xxhash.ts:61)
  - 支持 `Uint8Array | string`，string 先走 [`toUtf8`](AstrTown/convex/util/xxhash.ts:33)。
  - 实现遵循 xxHash32 步骤：初始化、条带处理、收敛、处理剩余、雪崩混合。

#### 5) 文件内部关系
- `xxHash32` 内部按输入长度分支（<16 与 >=16），并在最后做 avalanche。

#### 6) 文件间关系
- 被 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213)/[`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283) 使用。

---

### 4.21 util/llm.ts

#### 1) 文件基本信息
- 路径：[`AstrTown/convex/util/llm.ts`](AstrTown/convex/util/llm.ts)
- 功能概述：
  - 在无第三方依赖的前提下封装 LLM provider 配置、chat completion（支持流式）、embedding、moderation，以及带退避重试。
  - 同时提供 schema-time 常量 `EMBEDDING_DIMENSION`（Convex schema 评估期禁用 `process.env` 的 workaround）。
- 行数/字符数：本次读取到 732 行；仓库列表显示 25514 chars。

#### 2) 导入的模块
- 无（文件顶部声明无 imports，见 [`llm.ts`](AstrTown/convex/util/llm.ts:1)）。

#### 3) 导出的内容（按功能分组）
- 维度与检查：
  - [`EMBEDDING_DIMENSION`](AstrTown/convex/util/llm.ts:10)
  - [`detectMismatchedLLMProvider`](AstrTown/convex/util/llm.ts:24)
- 配置：
  - 接口 [`LLMConfig`](AstrTown/convex/util/llm.ts:61)
  - [`getLLMConfig`](AstrTown/convex/util/llm.ts:70)
- Chat：
  - 重载函数 [`chatCompletion`](AstrTown/convex/util/llm.ts:146)（stream 与非 stream 两种返回）
  - 流式内容类 [`ChatCompletionContent`](AstrTown/convex/util/llm.ts:627)
- Embedding：
  - [`fetchEmbeddingBatch`](AstrTown/convex/util/llm.ts:231)
  - [`fetchEmbedding`](AstrTown/convex/util/llm.ts:281)
  - [`ollamaFetchEmbedding`](AstrTown/convex/util/llm.ts:714)
- Moderation：[`fetchModeration`](AstrTown/convex/util/llm.ts:286)
- 重试：[`retryWithBackoff`](AstrTown/convex/util/llm.ts:315)
- 相关类型：[`LLMMessage`](AstrTown/convex/util/llm.ts:347)、`CreateChatCompletionRequest`（导出 interface，见 [`CreateChatCompletionRequest`](AstrTown/convex/util/llm.ts:421)）
- Ollama 拉取模型：[`tryPullOllama`](AstrTown/convex/util/llm.ts:216)

#### 4) 定义的函数和变量（关键点）
- Provider 识别：[`getLLMConfig`](AstrTown/convex/util/llm.ts:70)
  - 若 `LLM_PROVIDER==='openai'` 或存在 `OPENAI_API_KEY` -> OpenAI
  - 否则若存在 `TOGETHER_API_KEY` -> Together
  - 否则若存在 `LLM_API_URL` -> Custom
  - 否则默认 Ollama
- `AuthHeaders`：闭包函数，根据 `getLLMConfig().apiKey` 生成 Bearer（见 [`AuthHeaders`](AstrTown/convex/util/llm.ts:138)）。
- [`chatCompletion`](AstrTown/convex/util/llm.ts:146)
  - 会把 stop words 合并 provider stopWords，且在流式情况下用 [`ChatCompletionContent`](AstrTown/convex/util/llm.ts:627) 做客户端侧 stop 截断。
  - 失败时抛出 `{retry:boolean,error:Error}` 形态以驱动 [`retryWithBackoff`](AstrTown/convex/util/llm.ts:315)。
- [`retryWithBackoff`](AstrTown/convex/util/llm.ts:315)
  - 退避序列 `RETRY_BACKOFF=[1000,10000,20000]`（见 [`llm.ts`](AstrTown/convex/util/llm.ts:311)）。

#### 5) 文件内部关系
- `chatCompletion/fetchEmbeddingBatch/fetchModeration/ollamaFetchEmbedding` 都通过 [`retryWithBackoff`](AstrTown/convex/util/llm.ts:315) 统一重试。
- 流式处理：[`ChatCompletionContent.read()`](AstrTown/convex/util/llm.ts:655) -> `readInner` -> `splitStream`。

#### 6) 文件间关系
- 被引用（来自搜索结果）：
  - [`detectMismatchedLLMProvider`](AstrTown/convex/util/llm.ts:24) 在 [`AstrTown/convex/init.ts`](AstrTown/convex/init.ts:10) 调用。
  - [`EMBEDDING_DIMENSION`](AstrTown/convex/util/llm.ts:10) 在 [`AstrTown/convex/agent/schema.ts`](AstrTown/convex/agent/schema.ts:4) 使用。
  - [`chatCompletion`](AstrTown/convex/util/llm.ts:146)、[`fetchEmbedding`](AstrTown/convex/util/llm.ts:281)、`LLMMessage` 在 [`AstrTown/convex/agent/memory.ts`](AstrTown/convex/agent/memory.ts:5) 与 [`AstrTown/convex/agent/conversation.ts`](AstrTown/convex/agent/conversation.ts:4) 使用。
  - [`fetchEmbeddingBatch`](AstrTown/convex/util/llm.ts:231) 在 [`AstrTown/convex/agent/embeddingsCache.ts`](AstrTown/convex/agent/embeddingsCache.ts:5) 使用。

---

## 5. 模块关系图（文字依赖关系）

### 5.1 engine <-> util 依赖
- `engine/historicalObject.ts` 依赖 util：
  - 哈希：[`xxHash32`](AstrTown/convex/util/xxhash.ts:61)
  - 整数压缩：[`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)/[`uncompressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:186)
  - 序列编码：[`quantize`](AstrTown/convex/util/compression.ts:1)、[`deltaEncode`](AstrTown/convex/util/compression.ts:11)、[`runLengthEncode`](AstrTown/convex/util/compression.ts:32)…
- `engine/abstractGame.ts` 依赖 engine schema：[`engine`](AstrTown/convex/engine/schema.ts:35)

### 5.2 util 之间的依赖
- `geometry.ts` 依赖 `types.ts`（路径与 pack/unpack/query）。
- 其余 util 大多为独立模块（compression/FastIntegerCompression/xxhash/asyncMap/minheap/object/sleep/assertNever）。

### 5.3 engine/util 在上层模块中的位置（举例）
- 输入队列：[`engineInsertInput`](AstrTown/convex/engine/abstractGame.ts:133) 被 world/insertInput 等上层写入。
- 历史对象：[`HistoricalObject`](AstrTown/convex/engine/historicalObject.ts:72) 在 aiTown game 中使用。
- 路径与堆：[`compressPath`](AstrTown/convex/util/geometry.ts:93) + [`MinHeap`](AstrTown/convex/util/minheap.ts:2) 在 movement 中被组合使用。
- LLM：[`chatCompletion`](AstrTown/convex/util/llm.ts:146) 等在 agent 子系统被使用。

---

## 6. 关键算法与数据格式

### 6.1 HistoricalObject 的 sample record 二进制格式

入口：[`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:213)，出口：[`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:283)。

#### 6.1.1 配置一致性校验
- 先将字段配置通过内部函数 `packFieldConfig` 序列化（版本+字段名+精度），再用 [`xxHash32`](AstrTown/convex/util/xxhash.ts:61) 计算 32-bit hash。
- buffer 开头写入该 hash（4 字节 little-endian）。解包时重新计算 expected hash 并对比（见 [`unpackSampleRecord`](AstrTown/convex/engine/historicalObject.ts:288)）。

#### 6.1.2 时间戳压缩链
- timestamps：取 samples 的 `time` 向下取整（见 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:232)）。
- 初始时间戳 `initialTimestamp` 用 8 字节 `u64le` 存。
- 剩余时间戳序列：
  1) [`deltaEncode`](AstrTown/convex/util/compression.ts:11)（相对 initialTimestamp）
  2) [`runLengthEncode`](AstrTown/convex/util/compression.ts:32)
  3) [`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)
- 再写入 `u16le` bufferLength + bytes。

#### 6.1.3 数值压缩链（可选 RLE）
- values = `[initialValue, ...samples.value]`（见 [`packSampleRecord`](AstrTown/convex/engine/historicalObject.ts:240)）。
- 1) [`quantize`](AstrTown/convex/util/compression.ts:1)（按字段 precision）
- 2) [`deltaEncode`](AstrTown/convex/util/compression.ts:11)
- 3) 可选 [`runLengthEncode`](AstrTown/convex/util/compression.ts:32)：若 RLE 后更短则启用（见 [`useRLE`](AstrTown/convex/engine/historicalObject.ts:247)）
- 4) [`compressSigned`](AstrTown/convex/util/FastIntegerCompression.ts:151)
- fieldHeader 用低 4 bit 存 fieldNumber，第 5 bit 表示是否启用 RLE（见 [`fieldHeader`](AstrTown/convex/engine/historicalObject.ts:248)）。

### 6.2 geometry 的路径压缩（去冗余点）

入口：[`compressPath`](AstrTown/convex/util/geometry.ts:93)

- 核心思想：如果中间点 `candidate` 可以通过“前点 last 与后点 point 的线性插值”精确复原（位置与朝向误差 < EPSILON），则该点在客户端回放中可省略。
- 判定依赖：[`pathPosition`](AstrTown/convex/util/geometry.ts:26)（线性插值）、[`distance`](AstrTown/convex/util/geometry.ts:3)、[`vectorLength`](AstrTown/convex/util/geometry.ts:68)、阈值 [`EPSILON`](AstrTown/convex/util/geometry.ts:60)。

### 6.3 AbstractGame 的 step/tick/input 消费模型

入口：[`AbstractGame.runStep`](AstrTown/convex/engine/abstractGame.ts:22)

- 输入消费窗口：每 tick 收集 `received <= currentTs` 的 inputs（见 [`runStep`](AstrTown/convex/engine/abstractGame.ts:46)），因此输入按接收时间被分配到最接近的 tick。
- 并发与一致性：依赖 `generationNumber`（见 [`loadEngine`](AstrTown/convex/engine/abstractGame.ts:127)）与 `expectedGenerationNumber`（见 [`engineUpdate`](AstrTown/convex/engine/abstractGame.ts:105)）实现乐观并发控制。

---

## 7. 附：覆盖的文件清单（共 21 个）

### engine（4）
1. [`AstrTown/convex/engine/abstractGame.ts`](AstrTown/convex/engine/abstractGame.ts)
2. [`AstrTown/convex/engine/historicalObject.test.ts`](AstrTown/convex/engine/historicalObject.test.ts)
3. [`AstrTown/convex/engine/historicalObject.ts`](AstrTown/convex/engine/historicalObject.ts)
4. [`AstrTown/convex/engine/schema.ts`](AstrTown/convex/engine/schema.ts)

### util（17）
1. [`AstrTown/convex/util/assertNever.ts`](AstrTown/convex/util/assertNever.ts)
2. [`AstrTown/convex/util/asyncMap.test.ts`](AstrTown/convex/util/asyncMap.test.ts)
3. [`AstrTown/convex/util/asyncMap.ts`](AstrTown/convex/util/asyncMap.ts)
4. [`AstrTown/convex/util/compression.test.ts`](AstrTown/convex/util/compression.test.ts)
5. [`AstrTown/convex/util/compression.ts`](AstrTown/convex/util/compression.ts)
6. [`AstrTown/convex/util/FastIntegerCompression.ts`](AstrTown/convex/util/FastIntegerCompression.ts)
7. [`AstrTown/convex/util/geometry.test.ts`](AstrTown/convex/util/geometry.test.ts)
8. [`AstrTown/convex/util/geometry.ts`](AstrTown/convex/util/geometry.ts)
9. [`AstrTown/convex/util/minheap.test.ts`](AstrTown/convex/util/minheap.test.ts)
10. [`AstrTown/convex/util/minheap.ts`](AstrTown/convex/util/minheap.ts)
11. [`AstrTown/convex/util/object.ts`](AstrTown/convex/util/object.ts)
12. [`AstrTown/convex/util/sleep.ts`](AstrTown/convex/util/sleep.ts)
13. [`AstrTown/convex/util/types.test.ts`](AstrTown/convex/util/types.test.ts)
14. [`AstrTown/convex/util/types.ts`](AstrTown/convex/util/types.ts)
15. [`AstrTown/convex/util/xxhash.ts`](AstrTown/convex/util/xxhash.ts)
16. [`AstrTown/convex/util/isSimpleObject.ts`](AstrTown/convex/util/isSimpleObject.ts)
17. [`AstrTown/convex/util/llm.ts`](AstrTown/convex/util/llm.ts)
