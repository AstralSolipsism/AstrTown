# AstrTown

## 项目简介
AstrTown 是一个面向 NPC/Agent 的 2D 实时世界项目，采用 **Convex 后端 + React/Pixi.js 前端** 架构，支持：

- 持续运行的世界模拟（step/tick + 输入队列）
- NPC 对话、记忆检索与反思能力
- 通过 Gateway 的外部控制（Bot/AstrBot）
- 前端实时状态订阅与可视化交互

## 项目目标
- 构建可持续运行的 AI 世界模拟引擎。
- 将“世界状态机 + 对话记忆系统 + 外部控制接口”解耦为独立模块。
- 支持多端接入：Web 前端、Bot 客户端、AstrBot 插件。

## 架构概览
整体可分为 6 层：

1. **前端层（AstrTown/src）**
   - React 组件与 Pixi 场景渲染
   - 与 Convex API 交互，实时展示世界、角色、会话状态

2. **领域模拟层（AstrTown/convex/aiTown）**
   - 世界/玩家/地图/移动等基础模型
   - Agent 状态机、对话状态机、输入处理与事件分发

3. **Agent 记忆层（AstrTown/convex/agent）**
   - 对话生成、记忆写入、向量检索、embedding 缓存
   - 基于相关性/重要性/近期性进行记忆排序

4. **后端入口层（AstrTown/convex 根目录）**
   - HTTP 路由、鉴权、世界生命周期、消息与 NPC 历史查询
   - botApi / npcService 对外 API

5. **接入网关层（gateway）**
   - Fastify WebSocket + HTTP
   - 命令路由、事件队列、ACK 机制、连接与会话管理

6. **外部插件层（astrbot_plugin_astrtown）**
   - AstrBot 平台适配插件
   - 通过 Gateway 控制 NPC 并接收世界事件

## 目录结构
```text
.
├─ AstrTown/                     # 主应用（前端 + Convex 后端 + 数据/编辑器）
│  ├─ convex/                    # aiTown、agent、engine、root API
│  ├─ src/                       # React + Pixi 前端
│  ├─ data/                      # 角色、地图、spritesheet 等静态数据
│  └─ src/editor/                # 地图/精灵编辑器（Level Editor / Sprite Editor）
├─ gateway/                      # WebSocket/HTTP 网关服务
├─ astrbot_plugin_astrtown/      # AstrBot 插件
├─ plans/                        # 架构分析文档
└─ docker-compose.yml            # 一体化部署编排
```

## 快速开始（Docker Compose）
基于根目录 `docker-compose.yml`，默认会编排以下服务：

- `frontend`（Vite 前端）
- `backend`（Convex self-hosted backend）
- `gateway`（WebSocket/HTTP 网关）
- `dashboard`（Convex Dashboard）
- `convex-init`（初始化 Convex 环境变量）
- `level-editor`（地图编辑器）

### 1) 启动
```bash
docker compose up -d --build
```

### 2) 初始化管理员 Key（若未配置）
`convex-init` 会检查 `CONVEX_ADMIN_KEY`；若为空会提示先生成。

```bash
docker compose exec backend ./generate_admin_key.sh
```

将生成结果写入 `.env` 的 `CONVEX_ADMIN_KEY` 后，重新执行：

```bash
docker compose up -d convex-init
```

### 3) 默认访问地址
- 前端：`http://127.0.0.1:40009`
- Gateway：`http://127.0.0.1:40010`
- Dashboard：`http://127.0.0.1:6791`（默认端口）
- Level Editor：`http://127.0.0.1:40011/map-editor/`
- Convex Backend：`http://127.0.0.1:3210`（默认映射）

### 4) 停止
```bash
docker compose down
```

## 技术栈
- **前端**：React 18、TypeScript、Vite、Pixi.js、@pixi/react、pixi-viewport、@pixi/sound
- **后端**：Convex（函数 + 数据库 + 实时同步）
- **网关**：Node.js、Fastify、@fastify/websocket、@fastify/cors、prom-client、pino
- **插件**：Python、AstrBot（WebSocket 适配）
- **样式与国际化**：Tailwind CSS、react-i18next
- **部署**：Docker、Docker Compose

## 参考文档
本 README 主要依据以下文档与配置整理：

- `plans/架构分析-aiTown-基础.md`
- `plans/架构分析-aiTown-agent.md`
- `plans/架构分析-convex-根目录.md`
- `plans/架构分析-convex-botApi-npcService.md`
- `plans/架构分析-convex-agent.md`
- `plans/架构分析-convex-engine-util.md`
- `plans/架构分析-data.md`
- `plans/架构分析-editor.md`
- `docker-compose.yml`
- `AstrTown/package.json`
- `gateway/package.json`
- `astrbot_plugin_astrtown/`
