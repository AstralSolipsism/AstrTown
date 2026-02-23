# 架构分析：aiTown 基础类模块（convex/aiTown）

> 范围：本文件聚焦 aiTown 在 [`AstrTown/convex/aiTown/`](../AstrTown/convex/aiTown) 下“基础类模块”相关实现（世界/玩家/地图/移动/ID/Schema/输入写入与 Game 总控）。分析基于实际代码：
>
>- [`AstrTown/convex/aiTown/game.ts`](../AstrTown/convex/aiTown/game.ts)
>- [`AstrTown/convex/aiTown/world.ts`](../AstrTown/convex/aiTown/world.ts)
>- [`AstrTown/convex/aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts)
>- [`AstrTown/convex/aiTown/schema.ts`](../AstrTown/convex/aiTown/schema.ts)
>- [`AstrTown/convex/aiTown/insertInput.ts`](../AstrTown/convex/aiTown/insertInput.ts)
>- [`AstrTown/convex/aiTown/location.ts`](../AstrTown/convex/aiTown/location.ts)
>- [`AstrTown/convex/aiTown/worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts)
>- [`AstrTown/convex/aiTown/player.ts`](../AstrTown/convex/aiTown/player.ts)
>- [`AstrTown/convex/aiTown/playerDescription.ts`](../AstrTown/convex/aiTown/playerDescription.ts)
>- [`AstrTown/convex/aiTown/movement.ts`](../AstrTown/convex/aiTown/movement.ts)

---

## 1. 模块概述

### 1.1 功能与总体架构

该“基础类模块”围绕一个持续运行的游戏世界（World）与其上活动的玩家（Player）/会话（Conversation）构建**服务器端模拟**：

> 现状约束：引擎侧不再提供内置 LLM 的自主 NPC 决策；NPC 统一由外部插件以“外控 Player”的方式驱动。

- **运行时容器（Game）**：
  - 由 [`Game`](../AstrTown/convex/aiTown/game.ts) 继承引擎抽象基类 [`AbstractGame`](../AstrTown/convex/engine/abstractGame.ts) 统一驱动 step/tick、输入处理、状态差量（diff）生成与持久化。
  - 负责把“世界状态”（world）与“描述性数据”（仅 `playerDescriptions`）与“地图数据”（worldMap）组合成可加载/可保存的整体。

- **世界模型（World / WorldMap / Location）**：
  - [`World`](../AstrTown/convex/aiTown/world.ts) 聚合 `players/conversations` 并提供序列化能力（本模块不再内置“自主 Agent/NPC”决策）。
  - [`WorldMap`](../AstrTown/convex/aiTown/worldMap.ts) 保存地图 tile 图层与动画精灵数据，用于移动碰撞与前端渲染。
  - [`Location`](../AstrTown/convex/aiTown/location.ts) 定义玩家位置/朝向/速度的“压缩记录字段”与从 Player 抽取的方法。

- **玩家与移动（Player / movement）**：
  - [`Player`](../AstrTown/convex/aiTown/player.ts) 管理玩家的 pathfinding 状态、活动(activity)、位置/朝向/速度，并在每个 tick 中进行离线检测、路径规划与位置更新。
  - [`movement`](../AstrTown/convex/aiTown/movement.ts) 提供 `movePlayer/findRoute/blocked` 等移动与寻路逻辑，是玩家移动的核心算法模块。

- **ID 与表结构（ids / schema）**：
  - [`ids`](../AstrTown/convex/aiTown/ids.ts) 定义 Game 内部的字符串 ID（短码+序号）规则，并提供解析/分配函数。
  - [`schema`](../AstrTown/convex/aiTown/schema.ts) 定义 aiTown 在 Convex 数据库的表结构：worlds/worldStatus/maps/playerDescriptions 以及归档表与参与关系图表（`agentDescriptions` 已移除）。

- **输入写入（insertInput）**：
  - [`insertInput`](../AstrTown/convex/aiTown/insertInput.ts) 将世界级输入写入到底层 engine input 表（经 engineId 索引），是 UI/外部调用到引擎输入队列的桥。

### 1.2 在整体项目中的位置与作用

- 位置：`AstrTown/convex/aiTown` 是后端（Convex）侧的 aiTown 领域逻辑，实现“可持续运行的多人世界模拟”。
- 与引擎层关系：
  - [`Game`](../AstrTown/convex/aiTown/game.ts) 依赖 [`AbstractGame`](../AstrTown/convex/engine/abstractGame.ts) 的 engine 持久化机制（`loadEngine/applyEngineUpdate/engineUpdate` 等）来实现回放/推进。
- 与前端关系：
  - 前端组件会直接引用领域类型用于渲染与状态展示，例如 [`AstrTown/src/components/Player.tsx`](../AstrTown/src/components/Player.tsx) 引用 [`Player`](../AstrTown/convex/aiTown/player.ts)、[`GameId`](../AstrTown/convex/aiTown/ids.ts)、[`Location`](../AstrTown/convex/aiTown/location.ts)、[`WorldMap`](../AstrTown/convex/aiTown/worldMap.ts) 等。

### 1.3 游戏引擎核心概念（以代码为准）

- **step vs tick**：
  - [`Game`](../AstrTown/convex/aiTown/game.ts) 声明 `tickDuration=16ms`、`stepDuration=1000ms`、`maxTicksPerStep=600`、`maxInputsPerStep=32`（见 [`Game`](../AstrTown/convex/aiTown/game.ts:48)）。
  - 在每个 step 内多次 tick：tick 负责执行世界模拟（玩家/会话/智能体）。

- **输入（inputs）**：
  - [`Game.handleInput()`](../AstrTown/convex/aiTown/game.ts:157) 通过 `inputs[name].handler` 分发输入；玩家相关输入在 [`playerInputs`](../AstrTown/convex/aiTown/player.ts:266) 中定义（join/leave/moveTo）。

- **差量保存（diff）与历史轨迹**：
  - [`Game.beginStep()`](../AstrTown/convex/aiTown/game.ts:165) 为每个玩家创建 [`HistoricalObject`](../AstrTown/convex/engine/historicalObject.ts) 并持续更新。
  - [`Game.takeDiff()`](../AstrTown/convex/aiTown/game.ts:213) 将打包后的历史 buffer 写入 `world.historicalLocations`，并在需要时携带 descriptions/worldMap 的更新。

---

## 2. 文件清单

> 说明：行数来自本次读取到的文件行范围（工具输出）；字符数需要通过本地脚本统计，但由于终端输出未回传（命令执行成功但无 stdout 展示），本表“字符数”暂缺。

| 文件 | 功能概述 | 行数 | 字符数 |
|---|---|---:|---:|
| [`AstrTown/convex/aiTown/game.ts`](../AstrTown/convex/aiTown/game.ts) | Game 总控：加载/运行/tick、diff 生成与保存、触发 agent 操作与 world 事件调度 | 497 | （未获取） |
| [`AstrTown/convex/aiTown/world.ts`](../AstrTown/convex/aiTown/world.ts) | World 聚合容器：players/conversations + 历史位置 buffer 的序列化 | 65 | （未获取） |
| [`AstrTown/convex/aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts) | GameId 规则：短码+序号；解析与分配；输入校验器（v.string） | 32 | （未获取） |
| [`AstrTown/convex/aiTown/schema.ts`](../AstrTown/convex/aiTown/schema.ts) | Convex 表定义：worlds/worldStatus/maps/playerDescriptions/归档表/参与关系图 | 79 | （未获取） |
| [`AstrTown/convex/aiTown/insertInput.ts`](../AstrTown/convex/aiTown/insertInput.ts) | 世界输入写入：根据 worldId 找 engineId，调用引擎层插入 inputs | 20 | （未获取） |
| [`AstrTown/convex/aiTown/location.ts`](../AstrTown/convex/aiTown/location.ts) | Location 数据结构与历史字段配置；从 Player 抽取当前位置 | 32 | （未获取） |
| [`AstrTown/convex/aiTown/worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts) | WorldMap 地图数据结构：tile 层、动画精灵；序列化 | 74 | （未获取） |
| [`AstrTown/convex/aiTown/player.ts`](../AstrTown/convex/aiTown/player.ts) | Player：pathfinding 状态机、tick 生命周期、join/leave/moveTo 输入 | 310 | （未获取） |
| [`AstrTown/convex/aiTown/playerDescription.ts`](../AstrTown/convex/aiTown/playerDescription.ts) | 玩家描述（name/description/character）结构与序列化 | 35 | （未获取） |
| [`AstrTown/convex/aiTown/movement.ts`](../AstrTown/convex/aiTown/movement.ts) | 移动/碰撞/寻路：A* 风格最小堆探索 + 路径压缩 | 189 | （未获取） |

---

## 3. 文件详细分析

### 3.1 [`AstrTown/convex/aiTown/ids.ts`](../AstrTown/convex/aiTown/ids.ts)

- 文件基本信息
  - 角色：定义 aiTown 内部使用的 ID 编码（`a/c/p/o` 前缀）与解析/生成函数，同时导出 Convex validator（`v.string()`）用于 schema 与输入。

- 导入的模块
  - `convex/values`：`v`（见 [`ids.ts`](../AstrTown/convex/aiTown/ids.ts:1)）。

- 导出的内容
  - 类型：[`IdTypes`](../AstrTown/convex/aiTown/ids.ts:4)、[`GameId`](../AstrTown/convex/aiTown/ids.ts:6)
  - 函数：[`parseGameId()`](../AstrTown/convex/aiTown/ids.ts:8)、[`allocGameId()`](../AstrTown/convex/aiTown/ids.ts:21)
  - 校验器：`conversationId/playerId/agentId/operationId`（见 [`ids.ts`](../AstrTown/convex/aiTown/ids.ts:29)）

- 定义的函数和变量
  - 常量：`IdShortCodes`（见 [`ids.ts`](../AstrTown/convex/aiTown/ids.ts:3)）
  - 解析函数：[`parseGameId()`](../AstrTown/convex/aiTown/ids.ts:8)
    - 校验前缀短码是否匹配期望类型
    - 解析 `":"` 后数字段为非负整数
  - 分配函数：[`allocGameId()`](../AstrTown/convex/aiTown/ids.ts:21)
    - 将 `idType + idNumber` 组合成 `${short}:${number}`

- 文件内部关系
  - `IdShortCodes` 被 `parse/alloc` 使用。

- 文件间关系
  - 被 [`Player`](../AstrTown/convex/aiTown/player.ts:3) 用于将 `serialized.id` 转为 `GameId<'players'>`。
  - 被 [`World`](../AstrTown/convex/aiTown/world.ts:5) 用于历史位置解析。
  - 被 [`schema`](../AstrTown/convex/aiTown/schema.ts:10) 用于字段 validator。
  - 在前端也被引用：例如 [`AstrTown/src/components/Player.tsx`](../AstrTown/src/components/Player.tsx) 引用 `GameId`。

---

### 3.2 [`AstrTown/convex/aiTown/worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts)

- 文件基本信息
  - 角色：定义世界地图静态数据结构（背景 tiles、物体 tiles、动画精灵等），并提供序列化/反序列化。

- 导入的模块
  - `convex/values`：`Infer/ObjectType/v`（见 [`worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts:1)）。

- 导出的内容
  - `TileLayer` 类型（见 [`worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts:5)）
  - `AnimatedSprite` 类型（见 [`worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts:16)）
  - `serializedWorldMap` validator（见 [`worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts:18)）
  - 类：[`WorldMap`](../AstrTown/convex/aiTown/worldMap.ts:35)

- 定义的函数和变量
  - `tileLayer`：二维数组 validator，注释说明 `layer[x][y]` 访问方式（见 [`worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts:3)）。
  - `WorldMap.serialize()`（见 [`WorldMap.serialize()`](../AstrTown/convex/aiTown/worldMap.ts:61)）：返回 `SerializedWorldMap`。

- 文件内部关系
  - `serializedWorldMap` 既用于 Convex 表 schema（maps 表），也用于 GameState 的持久化。

- 文件间关系
  - 被 [`Game`](../AstrTown/convex/aiTown/game.ts:11) 持有并在 diff 时可选更新。
  - 被 [`movement.blockedWithPositions()`](../AstrTown/convex/aiTown/movement.ts:171) 用于碰撞判定（objectTiles/width/height）。

---

### 3.3 [`AstrTown/convex/aiTown/playerDescription.ts`](../AstrTown/convex/aiTown/playerDescription.ts)

- 文件基本信息
  - 角色：存放“人类可读的玩家描述信息”（name/description/character）。该信息与世界状态分表存储（见 schema 的 playerDescriptions 表）。

- 导入的模块
  - `convex/values`：`ObjectType/v`
  - [`GameId/parseGameId/playerId`](../AstrTown/convex/aiTown/ids.ts)（见 [`playerDescription.ts`](../AstrTown/convex/aiTown/playerDescription.ts:2)）

- 导出的内容
  - `serializedPlayerDescription` validator（见 [`playerDescription.ts`](../AstrTown/convex/aiTown/playerDescription.ts:4)）
  - 类：[`PlayerDescription`](../AstrTown/convex/aiTown/playerDescription.ts:12)

- 定义的函数和变量
  - [`PlayerDescription.serialize()`](../AstrTown/convex/aiTown/playerDescription.ts:26)

- 文件间关系
  - 被 [`Game`](../AstrTown/convex/aiTown/game.ts:12) 维护成 `Map<GameId<'players'>, PlayerDescription>`。
  - 被 [`Player.join()`](../AstrTown/convex/aiTown/player.ts:168) 创建并写入 `game.playerDescriptions`。
  - 被 [`schema`](../AstrTown/convex/aiTown/schema.ts:4) 用于 playerDescriptions 表字段。

---

### 3.4 [`AstrTown/convex/aiTown/location.ts`](../AstrTown/convex/aiTown/location.ts)

- 文件基本信息
  - 角色：为历史轨迹/位置同步定义 `Location` 结构，并以 `FieldConfig` 形式声明字段精度，用于 [`HistoricalObject`](../AstrTown/convex/engine/historicalObject.ts) 压缩打包。

- 导入的模块
  - [`FieldConfig`](../AstrTown/convex/engine/historicalObject.ts)（见 [`location.ts`](../AstrTown/convex/aiTown/location.ts:1)）
  - [`Player`](../AstrTown/convex/aiTown/player.ts)（见 [`location.ts`](../AstrTown/convex/aiTown/location.ts:2)）

- 导出的内容
  - `Location` 类型（见 [`location.ts`](../AstrTown/convex/aiTown/location.ts:4)）
  - 常量：[`locationFields`](../AstrTown/convex/aiTown/location.ts:16)
  - 函数：[`playerLocation()`](../AstrTown/convex/aiTown/location.ts:24)

- 文件间关系
  - 被 [`Game.beginStep()`](../AstrTown/convex/aiTown/game.ts:165) 与 tick 的历史更新逻辑使用。
  - 被前端历史显示使用：例如 [`AstrTown/src/components/Player.tsx`](../AstrTown/src/components/Player.tsx) 引用 `locationFields/playerLocation`。

---

### 3.5 [`AstrTown/convex/aiTown/world.ts`](../AstrTown/convex/aiTown/world.ts)

- 文件基本信息
  - 角色：世界聚合体，包含 `players/conversations` 以及可选的 `historicalLocations`（玩家位置历史 buffer）。

- 导入的模块
  - `convex/values`：`ObjectType/v`
  - [`Conversation`](../AstrTown/convex/aiTown/conversation.ts)、[`Player`](../AstrTown/convex/aiTown/player.ts)、[`Agent`](../AstrTown/convex/aiTown/agent.ts)
  - [`GameId/parseGameId/playerId`](../AstrTown/convex/aiTown/ids.ts)
  - [`parseMap`](../AstrTown/convex/util/object.ts)

- 导出的内容
  - `historicalLocations` validator（见 [`world.ts`](../AstrTown/convex/aiTown/world.ts:8)）
  - `serializedWorld` validator（见 [`world.ts`](../AstrTown/convex/aiTown/world.ts:15)）
  - 类：[`World`](../AstrTown/convex/aiTown/world.ts:24)

- 关键方法
  - [`World.playerConversation()`](../AstrTown/convex/aiTown/world.ts:47)：查找玩家所在会话（扫描 `conversations`）。
  - [`World.serialize()`](../AstrTown/convex/aiTown/world.ts:51)：将 Map 转回数组，并可选写出 `historicalLocations`。

- 文件间关系
  - 被 [`Game`](../AstrTown/convex/aiTown/game.ts:10) 持有为 `game.world`。
  - `historicalLocations` 与 [`Game.takeDiff()`](../AstrTown/convex/aiTown/game.ts:213) 生成的 packed buffer 对接。

---

### 3.6 [`AstrTown/convex/aiTown/movement.ts`](../AstrTown/convex/aiTown/movement.ts)

- 文件基本信息
  - 角色：移动与寻路算法实现；提供碰撞检测（地图+玩家）与路径规划。

- 导入的模块
  - 数据：`movementSpeed`（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:1)）
  - 常量：`COLLISION_THRESHOLD`（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:2)）
  - 几何：`compressPath/distance/manhattanDistance/pointsEqual`（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:3)）
  - 结构：[`MinHeap`](../AstrTown/convex/util/minheap.ts)（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:4)）
  - 类型：`Point/Vector`（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:5)）
  - 领域：[`Game`](../AstrTown/convex/aiTown/game.ts)、[`GameId`](../AstrTown/convex/aiTown/ids.ts)、[`Player`](../AstrTown/convex/aiTown/player.ts)、[`WorldMap`](../AstrTown/convex/aiTown/worldMap.ts)

- 导出的内容
  - [`stopPlayer()`](../AstrTown/convex/aiTown/movement.ts:20)
  - [`movePlayer()`](../AstrTown/convex/aiTown/movement.ts:25)
  - [`findRoute()`](../AstrTown/convex/aiTown/movement.ts:57)
  - [`blocked()`](../AstrTown/convex/aiTown/movement.ts:164)
  - [`blockedWithPositions()`](../AstrTown/convex/aiTown/movement.ts:171)

- 文件内部关系
  - `movePlayer` 只负责设置 `player.pathfinding = {destination, started, state:needsPath}`；真正的路径计算在 `Player.tickPathfinding` 调用 `findRoute`。
  - `blocked` 用当前 world 的其他玩家位置集合调用 `blockedWithPositions`。

- 文件间关系
  - 被 [`Player.tickPathfinding()`](../AstrTown/convex/aiTown/player.ts:90) 使用：`findRoute/blocked/stopPlayer/movePlayer`。
  - 被 [`Conversation`](../AstrTown/convex/aiTown/conversation.ts) 引用（工具检索到 `stopPlayer/blocked/movePlayer` 的导入，见 [`conversation.ts`](../AstrTown/convex/aiTown/conversation.ts:11)）。

---

### 3.7 [`AstrTown/convex/aiTown/player.ts`](../AstrTown/convex/aiTown/player.ts)

- 文件基本信息
  - 角色：玩家实体与其 tick 生命周期（离线检测、路径规划、位置更新）+ 玩家输入（join/leave/moveTo）。

- 导入的模块
  - `convex/values`：`Infer/ObjectType/v`
  - 类型/validator：`Point/Vector/path/point/vector`（见 [`player.ts`](../AstrTown/convex/aiTown/player.ts:2)）
  - ID：[`GameId/parseGameId/playerId`](../AstrTown/convex/aiTown/ids.ts)
  - 常量：`PATHFINDING_TIMEOUT/BACKOFF/HUMAN_IDLE_TOO_LONG/MAX_HUMAN_PLAYERS/MAX_PATHFINDS_PER_STEP`（见 [`player.ts`](../AstrTown/convex/aiTown/player.ts:5)）
  - 几何：`pointsEqual/pathPosition`（见 [`player.ts`](../AstrTown/convex/aiTown/player.ts:12)）
  - 领域：[`Game`](../AstrTown/convex/aiTown/game.ts)
  - 移动：[`stopPlayer/findRoute/blocked/movePlayer`](../AstrTown/convex/aiTown/movement.ts)
  - 输入包装：[`inputHandler`](../AstrTown/convex/aiTown/inputHandler.ts)
  - 角色数据：`characters`（见 [`player.ts`](../AstrTown/convex/aiTown/player.ts:16)）
  - 描述：[`PlayerDescription`](../AstrTown/convex/aiTown/playerDescription.ts)

- 导出的内容
  - `Pathfinding`、`Activity`、`serializedPlayer`、[`Player`](../AstrTown/convex/aiTown/player.ts:60)
  - `playerInputs`（见 [`playerInputs`](../AstrTown/convex/aiTown/player.ts:266)）

- 关键字段与状态
  - `pathfinding` 状态机：`needsPath/waiting/moving`（见 `pathfinding` validator， [`player.ts`](../AstrTown/convex/aiTown/player.ts:19)）。

- 关键方法（以实际代码为准）
  - [`Player.tick()`](../AstrTown/convex/aiTown/player.ts:84)：人类玩家超时未输入则离开世界（调用 [`leave()`](../AstrTown/convex/aiTown/player.ts:240)）。
  - [`Player.tickPathfinding()`](../AstrTown/convex/aiTown/player.ts:90)：
    - 到达目的地 => [`stopPlayer()`](../AstrTown/convex/aiTown/movement.ts:20)
    - 超时 => stop
    - waiting 到期 => needsPath
    - needsPath 且未超过本 step 最大寻路次数 => 调用 [`findRoute()`](../AstrTown/convex/aiTown/movement.ts:57)，成功则进入 moving，失败则 stop
  - [`Player.tickPosition()`](../AstrTown/convex/aiTown/player.ts:137)：
    - moving 才更新速度/位置
    - 使用 [`pathPosition()`](../AstrTown/convex/util/geometry.ts:?)（文件未在本任务读取范围内，仅在导入处可见）计算候选点
    - 调用 [`blocked()`](../AstrTown/convex/aiTown/movement.ts:164) 检测碰撞：若阻塞则进入 waiting 并 backoff
    - 否则更新 `position/facing/speed`
  - [`Player.join()`](../AstrTown/convex/aiTown/player.ts:168)：
    - 限制同 tokenIdentifier 不能重复加入
    - 限制最大人类玩家数
    - 随机选择空闲格子（最多 10 次，调用 [`blocked()`](../AstrTown/convex/aiTown/movement.ts:164)）
    - 校验 character 存在
    - 分配 playerId（调用 [`Game.allocId()`](../AstrTown/convex/aiTown/game.ts:147)）并插入 `game.world.players`
    - 同时插入 `game.playerDescriptions` 并标记 `game.descriptionsModified=true`
  - [`Player.leave()`](../AstrTown/convex/aiTown/player.ts:240)：
    - 若处于会话中，调用 `conversation.stop`（conversation 定义不在本次基础类文件清单内）
    - 从 `game.world.players` 删除自身

- 文件间关系
  - 依赖 [`movement`](../AstrTown/convex/aiTown/movement.ts) 的寻路与碰撞。
  - 依赖 [`Game`](../AstrTown/convex/aiTown/game.ts) 作为运行时上下文（world/worldMap/pathfind 计数、allocId、descriptionsModified）。

---

### 3.8 [`AstrTown/convex/aiTown/schema.ts`](../AstrTown/convex/aiTown/schema.ts)

- 文件基本信息
  - 角色：集中定义 aiTown 的 Convex 数据表（用于持久化世界状态、地图、描述与归档）。

- 导入的模块
  - `convex/values`：`v`
  - `convex/server`：`defineTable`
  - 领域序列化对象：[`serializedPlayer`](../AstrTown/convex/aiTown/player.ts)、[`serializedWorld`](../AstrTown/convex/aiTown/world.ts)、[`serializedWorldMap`](../AstrTown/convex/aiTown/worldMap.ts)、[`serializedConversation`](../AstrTown/convex/aiTown/conversation.ts)、以及 agent 相关序列化（不在本清单范围内）。
  - ID validator：[`conversationId/playerId`](../AstrTown/convex/aiTown/ids.ts)

- 导出的内容
  - `aiTownTables`：对象字面量，包含多张表定义（见 [`schema.ts`](../AstrTown/convex/aiTown/schema.ts:12)）。

- 表与索引（摘要）
  - `worlds`：主世界文档（players/conversations 等）
  - `worldStatus`：世界运行状态，索引 `worldId`
  - `maps`：世界地图数据，索引 `worldId`
  - `playerDescriptions`：描述性文本数据，索引 `worldId + playerId`
  - `archivedPlayers/archivedConversations/archivedAgents`：归档表
  - `participatedTogether`：玩家间关系图（多索引：edge/conversation/playerHistory）

---

### 3.9 [`AstrTown/convex/aiTown/insertInput.ts`](../AstrTown/convex/aiTown/insertInput.ts)

- 文件基本信息
  - 角色：按 `worldId` 找到 `engineId`，然后写入 `inputs` 表（通过 engine 抽象层 API）。

- 导入的模块
  - `MutationCtx`（Convex mutation 上下文）
  - `Id`（Convex 表 Id 类型）
  - [`engineInsertInput()`](../AstrTown/convex/engine/abstractGame.ts:133)
  - `InputNames/InputArgs`（来自 [`AstrTown/convex/aiTown/inputs.ts`](../AstrTown/convex/aiTown/inputs.ts)，不在本基础类清单内）

- 导出的内容
  - [`insertInput()`](../AstrTown/convex/aiTown/insertInput.ts:6)

- 关键流程
  - 查询 `worldStatus` 表，使用索引 `worldId`（见 [`insertInput()`](../AstrTown/convex/aiTown/insertInput.ts:6)）。
  - 找不到 worldStatus 直接抛错。
  - 调用 [`engineInsertInput()`](../AstrTown/convex/engine/abstractGame.ts:133) 写入输入。

---

### 3.10 [`AstrTown/convex/aiTown/game.ts`](../AstrTown/convex/aiTown/game.ts)

- 文件基本信息
  - 角色：aiTown 运行时“总控”与 Convex 内部 API（loadWorld/saveWorld）。

- 导入的模块（按功能归类）
  - Convex 类型/ctx：`Doc/Id`、`ActionCtx/MutationCtx/DatabaseReader`、`internalMutation/internalQuery`
  - 世界/地图/描述：[`World`](../AstrTown/convex/aiTown/world.ts)、[`WorldMap`](../AstrTown/convex/aiTown/worldMap.ts)、[`PlayerDescription`](../AstrTown/convex/aiTown/playerDescription.ts)
  - 历史：[`HistoricalObject`](../AstrTown/convex/engine/historicalObject.ts)、[`locationFields/playerLocation`](../AstrTown/convex/aiTown/location.ts)
  - 引擎抽象：[`AbstractGame`](../AstrTown/convex/engine/abstractGame.ts)、`loadEngine/applyEngineUpdate/engineUpdate` 等
  - agent 运行：`runAgentOperation`（来自 `./agent`，非本清单）
  - 其他：`distance` 与 `CONVERSATION_DISTANCE`（用于 world event 的 nearby players 计算）

- 导出的内容
  - 类：[`Game`](../AstrTown/convex/aiTown/game.ts:48)
  - Convex 内部函数：[`loadWorld`](../AstrTown/convex/aiTown/game.ts:476)、[`saveWorld`](../AstrTown/convex/aiTown/game.ts:486)

- 关键结构
  - `gameState/gameStateDiff`：用于 load/save 的 validator（见 [`game.ts`](../AstrTown/convex/aiTown/game.ts:31)）。
  - `GameState` 包含：world、playerDescriptions、worldMap（`agentDescriptions` 已移除）。
  - `GameStateDiff` 包含：world（含历史位置）、可选 playerDescriptions/worldMap、以及 agentOperations 队列。

- 关键方法与逻辑
  - [`Game.load()`](../AstrTown/convex/aiTown/game.ts:91)：
    - `db.get(worldId)` 读 worlds 文档
    - `worldStatus` 取 `engineId`
    - 调用 `loadEngine`
     - 读取 playerDescriptions/maps（`agentDescriptions` 已在当前代码中移除）
     - **过滤** descriptions：只保留 world 中仍存在对应 player 的描述（见 [`Game.load()`](../AstrTown/convex/aiTown/game.ts:124)）。
- [`Game.allocId()`](../AstrTown/convex/aiTown/game.ts:147)：调用 [`allocGameId()`](../AstrTown/convex/aiTown/ids.ts:21)，并递增 `world.nextId`。
  - [`Game.beginStep()`](../AstrTown/convex/aiTown/game.ts:165)：为每个 player 建立 `HistoricalObject<Location>` 并清零 `numPathfinds`。
  - [`Game.tick()`](../AstrTown/convex/aiTown/game.ts:176)：
    - 依次 tick 玩家/玩家寻路/玩家位置/会话（不再包含内置 LLM 的自主 agent tick）
    - 汇总并更新每个玩家的历史位置（`HistoricalObject.update`），为 diff 打包做准备。
  - [`Game.takeDiff()`](../AstrTown/convex/aiTown/game.ts:213)：
    - 将历史对象 `pack()` 的 buffer 收集为 `historicalLocations` 并写入 diff.world
    - 若 `descriptionsModified` 则将 map/description 全量序列化写入 diff（见 [`Game.takeDiff()`](../AstrTown/convex/aiTown/game.ts:238)）
    - 取走并清空 `pendingOperations`
   - [`Game.saveDiff()`](../AstrTown/convex/aiTown/game.ts:247)：
     - world 替换前执行归档：players/conversations 被删除时写入 archived 表
- `db.replace(worldId, newWorld)`
     - 可选 upsert playerDescriptions/maps
     - 根据 `agentOperations` 分发 worldEventDispatcher 事件（conversationStarted/invited/message/conversation.timeout/action.finished/agentStateChanged/queueRefillRequested）
       - 注：当前架构中 NPC 统一视为“外部插件控制的 Player（外控 NPC）”，引擎侧不再内置 LLM prompt 拼接与自主决策逻辑。
- 文件间关系（核心依赖）
  - Game 组合并驱动：[`World`](../AstrTown/convex/aiTown/world.ts)、[`Player`](../AstrTown/convex/aiTown/player.ts)、`Conversation/Agent`（不在本清单）
  - 持久化：Convex tables（worlds、worldStatus、maps、descriptions、archived*、participatedTogether）由 [`schema`](../AstrTown/convex/aiTown/schema.ts) 定义
  - 数据压缩：[`HistoricalObject`](../AstrTown/convex/engine/historicalObject.ts) + [`locationFields`](../AstrTown/convex/aiTown/location.ts)

---

## 4. 模块关系图（文字依赖描述）

以“基础类模块”内文件为节点：

- [`ids.ts`](../AstrTown/convex/aiTown/ids.ts)
  - 被 [`world.ts`](../AstrTown/convex/aiTown/world.ts)、[`player.ts`](../AstrTown/convex/aiTown/player.ts)、[`playerDescription.ts`](../AstrTown/convex/aiTown/playerDescription.ts)、[`schema.ts`](../AstrTown/convex/aiTown/schema.ts)、[`game.ts`](../AstrTown/convex/aiTown/game.ts) 使用。

- [`worldMap.ts`](../AstrTown/convex/aiTown/worldMap.ts)
  - 被 [`game.ts`](../AstrTown/convex/aiTown/game.ts) 持有与序列化。
  - 被 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts) 用于地图阻挡（objectTiles/边界）。

- [`movement.ts`](../AstrTown/convex/aiTown/movement.ts)
  - 被 [`player.ts`](../AstrTown/convex/aiTown/player.ts) 在 tickPathfinding/tickPosition 与 moveTo 输入中调用。

- [`player.ts`](../AstrTown/convex/aiTown/player.ts)
  - 依赖 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts)、[`ids.ts`](../AstrTown/convex/aiTown/ids.ts)、[`playerDescription.ts`](../AstrTown/convex/aiTown/playerDescription.ts)
  - 被 [`world.ts`](../AstrTown/convex/aiTown/world.ts) 聚合。
  - 被 [`location.ts`](../AstrTown/convex/aiTown/location.ts) 用于抽取位置。

- [`location.ts`](../AstrTown/convex/aiTown/location.ts)
  - 被 [`game.ts`](../AstrTown/convex/aiTown/game.ts) 用于历史轨迹记录。

- [`world.ts`](../AstrTown/convex/aiTown/world.ts)
  - 被 [`game.ts`](../AstrTown/convex/aiTown/game.ts) 组合为 `game.world`。

- [`schema.ts`](../AstrTown/convex/aiTown/schema.ts)
  - 依赖各实体的 `serialized*` 对象；是数据持久化结构的中心。

- [`insertInput.ts`](../AstrTown/convex/aiTown/insertInput.ts)
  - 依赖引擎层 [`engineInsertInput()`](../AstrTown/convex/engine/abstractGame.ts:133) 与 `worldStatus` 表（由 schema 定义）。

---

## 5. 数据流分析

### 5.1 世界加载 -> 运行 -> 保存（主循环数据流）

1. **加载阶段**
   - 内部查询 [`loadWorld`](../AstrTown/convex/aiTown/game.ts:476) 调用 [`Game.load()`](../AstrTown/convex/aiTown/game.ts:91)
    - 读取：
      - `worlds` 表 world 文档（players/conversations + nextId 等）
      - `worldStatus` 表（engineId）
      - engine 状态（`loadEngine`）
      - `maps` 表 worldMap
      - `playerDescriptions` 表
- 组装：`new Game(engine, worldId, gameState)`

2. **运行阶段（step/tick）**
   - step 开始：[`Game.beginStep()`](../AstrTown/convex/aiTown/game.ts:165)
     - 为每个 player 建立 `HistoricalObject<Location>`（字段来自 [`locationFields`](../AstrTown/convex/aiTown/location.ts:16)）
   - tick：[`Game.tick()`](../AstrTown/convex/aiTown/game.ts:176)
     - 玩家：[`Player.tick()`](../AstrTown/convex/aiTown/player.ts:84)（离线检测）
     - 寻路：[`Player.tickPathfinding()`](../AstrTown/convex/aiTown/player.ts:90) -> [`findRoute()`](../AstrTown/convex/aiTown/movement.ts:57)
     - 位置更新：[`Player.tickPosition()`](../AstrTown/convex/aiTown/player.ts:137) -> [`blocked()`](../AstrTown/convex/aiTown/movement.ts:164)
     - 历史位置：`HistoricalObject.update(now, playerLocation(player))`（见 [`Game.tick()`](../AstrTown/convex/aiTown/game.ts:193) 与 [`playerLocation()`](../AstrTown/convex/aiTown/location.ts:24)）

3. **保存阶段（diff -> DB）**
   - [`Game.takeDiff()`](../AstrTown/convex/aiTown/game.ts:213) 生成 `GameStateDiff`
     - world：含 `historicalLocations`（bytes array）
     - 可选：playerDescriptions/worldMap（仅在 `descriptionsModified` 为 true）
     - agentOperations：本 step 收集到的操作队列
   - [`Game.saveStep()`](../AstrTown/convex/aiTown/game.ts:203) 调用内部 mutation [`saveWorld`](../AstrTown/convex/aiTown/game.ts:486)
   - [`saveWorld`](../AstrTown/convex/aiTown/game.ts:486) 流程：
     - `applyEngineUpdate`
     - [`Game.saveDiff()`](../AstrTown/convex/aiTown/game.ts:247)：replace world、upsert descriptions/maps、触发 agent operation、分发 world events

### 5.2 游戏状态管理流程（以现有代码为准）

- **世界状态（worlds 表）**：
  - `players/conversations` 被整体存放在单个 world 文档中（见 [`schema.ts`](../AstrTown/convex/aiTown/schema.ts:15)）。
  - 每步保存采用 `db.replace(worldId, newWorld)`（见 [`Game.saveDiff()`](../AstrTown/convex/aiTown/game.ts:328)），属于“整文档替换 + 辅助分表”。

- **分表数据（maps / descriptions）**：
  - `maps` 与 `playerDescriptions` 单独表存储，减少 world 主文档体积并支持独立更新（`agentDescriptions` 已移除）。
  - 但更新策略是：当 `Game.descriptionsModified` 为 true 时，在 diff 中携带全量序列化结果并逐条 upsert（见 [`Game.takeDiff()`](../AstrTown/convex/aiTown/game.ts:238) 与 [`Game.saveDiff()`](../AstrTown/convex/aiTown/game.ts:330)）。

- **归档与关系图**：
  - 当 world 中移除 player/conversation/agent 时，写入 archived* 表。
  - conversation 归档同时写 `participatedTogether` 图边（见 [`Game.saveDiff()`](../AstrTown/convex/aiTown/game.ts:258)）。

---

## 6. 关键算法

### 6.1 移动与寻路（A* 风格最小代价搜索）

实现位置：[`findRoute()`](../AstrTown/convex/aiTown/movement.ts:57)

- 状态节点：`PathCandidate`（位置、朝向、时间 t、路径长度、总代价 cost、prev 指针，见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:11)）。
- 邻居扩展：`explore(current)`（见 [`findRoute()`](../AstrTown/convex/aiTown/movement.ts:57) 内部函数）
  - 若当前位置不在整数格点，先“吸附”到相邻格点（保持 facing 向量）。
  - 若在格点，则四向扩展。
- 代价与启发式：
  - `length` 为已走欧氏距离累加。
  - `remaining = manhattanDistance(position, destination)` 作为启发式。
  - `cost = length + remaining`。
- 碰撞剪枝：每个邻居用 [`blocked()`](../AstrTown/convex/aiTown/movement.ts:164) 过滤。
- 去重/最优记录：使用 `minDistances[y][x]` 保存当前点最小 `cost`（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:106)）。
- 搜索结构：最小堆 [`MinHeap`](../AstrTown/convex/util/minheap.ts)（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:128)）。
- 不可达处理：若堆耗尽，选择 `bestCandidate`（离目标最近的 manhattan）作为替代终点，并返回 `newDestination`（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:144)）。
- 输出路径：通过 `prev` 回溯生成 `densePath`，再调用 `compressPath` 进行路径压缩（见 [`movement.ts`](../AstrTown/convex/aiTown/movement.ts:161)）。

### 6.2 碰撞检测（地图阻挡 + 玩家间距阈值）

实现位置：[`blockedWithPositions()`](../AstrTown/convex/aiTown/movement.ts:171)

- 边界：超出 `map.width/height` 返回 `'out of bounds'`。
- 地图阻挡：遍历 `map.objectTiles` 各层，只要 `layer[floor(x)][floor(y)] !== -1` 返回 `'world blocked'`。
- 玩家碰撞：若与任一其他玩家距离 `< COLLISION_THRESHOLD` 返回 `'player'`。
- 否则返回 `null`。

---

## 特别说明 / 已知问题

1. **字符数未填**：按要求需要“字符数”，已尝试通过本地脚本统计，但终端命令输出未回传（执行成功但无 stdout 展示）。本文件没有在缺乏证据的情况下补填字符数。
2. **引用定位的行号**：本文对本次读取的文件，函数引用均带了行号链接（例如 [`Game.tick()`](../AstrTown/convex/aiTown/game.ts:176)）。对未在本任务读取范围内但被导入的外部文件（如 `geometry.ts` 的某些函数），未强行给出行号以避免猜测。
