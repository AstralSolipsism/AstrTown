# 第一阶段：地图编辑器UX优化 - 执行方案

## 1. 概述
- **目标**：改善编辑器中瓦片选择器(Tileset)的用户体验，重点解决侧栏宽度受限、浏览困难、缺乏分类检索和选中反馈等问题。
- **范围**：限制在前端UI层面，针对 `le.html`、`le-layout.css`、`lehtmlui.js`、`le.js` 以及可能新增的前端配置文件，不涉及后端架构变更。
- **前置条件**：基于现有项目代码架构（DOM结合原生PixiJS和全局对象 `g_ctx`），新增代码需适配现有地图层加载逻辑。

## 2. 任务清单
| 任务ID | 任务名称 | 优先级 | 依赖 | 预估复杂度 |
|--------|----------|--------|------|------------|
| S.1 | 去除硬编码尺寸与样式冲突清理 | 高 | 无 | 低 |
| S.2 | 右侧拉框宽度支持拖拽动态调整 | 高 | S.1 | 中 |
| S.3 | 引入瓦片命中区域持久高亮反馈 | 高 | 无 | 中 |
| S.4 | 便捷入口：Tileset切换移植到主区 | 中高 | 无 | 低 |
| S.5 | 添加画布鼠标滚轮事件支持缩放 | 中 | 无 | 低 |
| S.6 | 瓦片ROI书签分类及捷径搜寻 | 高 | 无 | 中 |

## 3. 详细方案设计与任务说明

### 布局改进方案设计（针对"侧栏过窄"）
- **方案选择**：**拖拽栏增宽 (Resize Handle) + Flex高度自适应**。不采用弹出式面板以免遮挡主画布。直接修改局限于 320px 的 `--inspector-w` 变量提供动态调整，并将Tileset面板高度改为 `flex-grow: 1` 撑满视口，剔除固定的max-height。
- **响应式适配**：`#app-inspector` 本身具备 `overflow: auto`，使用弹性布局能在视口高度变小时自动控制滚动条。

### 分类/搜索功能设计（针对"无分类/无搜索"）
- **分类数据结构**：鉴于目前使用一张长图(如 `gentle.png`)，无单体瓦片数据分离结构。采用**ROI（感兴趣区域）坐标书签法**解决分类映射问题。
  - 在前端配置：`export const TILESET_CATEGORIES = [{name:'地形', y:0}, {name:'墙体', y:600}]`。
- **交互设计**：在瓦片上方增加一组快捷分类按钮或下拉框，点击后直接用 `element.scrollTo` 将视口平滑滚动（计算当前 Zoom 倍率后映射的高度）到对于组的起始点。

### 选中反馈增强（针对"选择反馈不足"）
- **视觉效果**：为选中的块区域附加持久且高辨识度的图形描边（例如明绿色/红色高亮线框）。
- **渲染逻辑**：在 `TilesetContext` 新增 `this.selectionBox = new PIXI.Graphics()`。单选或框选结束时，先 `clear()` 再根据 `g_ctx.selected_tiles` 的相对坐标使用 `drawRect()` 渲染选区。该图形一直浮在画布上方直到下次选择。

---

## 4. 分解任务详情

### 任务S.1：清除硬编码与面板高度自适应
**目标**：消除 HTML/JS 里画布尺寸(5632x8672)的定死限制，以及解除 CSS 中的高度阻碍，实现面板按内容自适应延伸。
**修改文件**：
- `AstrTown/src/editor/le.html` - 移除 `<canvas id="tileset">` 的 `width`、`height` 属性。
- `AstrTown/src/editor/le-layout.css` - 移除 `#tilesetpane` 的 `max-height: 340px`，并将父级 `#tileset-container` 等配置为 `display: flex; flex-direction: column; flex: 1`。
- `AstrTown/src/editor/le.js` - 修改 Pixi Application 初始化，改为基于加载出来Texture大小的自适应计算 (`PIXI.Texture.width`)。

### 任务S.2：右侧拉框宽度支持拖拽动态调整
**目标**：解决“侧栏过窄”造成的浏览大图吃力的问题，使得区域支持拖拽拓展宽度。
**修改文件**：
- `AstrTown/src/editor/le.html` - 在中段画布和右侧属性区直接增加隔离分界 `div#inspector-resizer`。
- `AstrTown/src/editor/le-layout.css` - 新设置 `#inspector-resizer` CSS（设置 `cursor: col-resize; width: 4px;` 等）。
- `AstrTown/src/editor/lehtmlui.js` - 追加响应拖曳代码，利用 `document.documentElement.style.setProperty('--inspector-w', ...)` 处理鼠标滑动事件动态调整宽度。

### 任务S.3：引入瓦片命中区域持久高亮反馈
**目标**：单击选取、区间多选之后，画板上绘制明色选框，永久提示焦点位置。
**修改文件**：
- `AstrTown/src/editor/le.js` - 在 `TilesetContext` 中操作。
**实施步骤**：
1. `TilesetContext` 构造内追加 PIXI 节点图层：`this.selectionBox = new PIXI.Graphics(); this.container.addChild(this.selectionBox);`。
2. 将绘制焦点的方法独立为 `drawActiveSelection()`。利用循环获取并遍历 `g_ctx.selected_tiles` （如果空则基于 `g_ctx.tile_index`）。调用 `drawRect()` 绘制边框并填充高亮色彩框架。
3. 保证坐标定位加装上原瓦片原自身的 `fudgex/fudgey` 的偏移修正计算。

### 任务S.4：便捷入口：Tileset切换移植到主区
**目标**：资源更换功能前移，解决多切板卡顿操作的不连贯问题。
**修改文件**：
- `AstrTown/src/editor/le.html` 
**实施步骤**：
1. 定位到 `#panel-files` 里的更新 Tileset 按钮并将其提级拷贝到 `#panel-terrain` 瓦片工具栏头处。复用隐藏的 input file `onchange` 事件即可调起替换窗口。

### 任务S.5：添加画布鼠标滚轮事件支持缩放
**目标**：利用鼠标滚轮直接对操作面板进行拉近拉远的微调缩放。
**修改文件**：
- `AstrTown/src/editor/le.js` 或 `lehtmlui.js` 的 toolbar 监听区。
**实施步骤**：
1. 对 `tilesetpane` 增加原生的 DOM 原生 `wheel` 监听捕获。
2. 分析 `e.deltaY` 来判定方向。
3. 抑制原本滑轮的区域翻滚 `e.preventDefault()` 从而触发现有的 `setTilesetZoom(newZoom)` 缩放档位。

### 任务S.6：瓦片ROI书签分类及快速定位
**目标**：将杂乱大画板抽象分组，允许用户跨区域即时浏览。
**修改文件**：
- `AstrTown/src/editor/tileset-meta.js` (新建)
- `AstrTown/src/editor/le.html`
- `AstrTown/src/editor/lehtmlui.js`
**实施步骤**：
1. 新添分类配置映射：记录名称至所指图片区间坐标 Y 值。
2. `#tileset-toolbar` 下附上一列组标签(`buttons` 或 `select`)供展示。
3. `lehtmlui` 处理按钮单击反馈：通过 `(Y * 当前Zoom率)` 去操纵 `document.getElementById('tilesetpane').scrollTo({ top: ... , behavior: 'smooth' })` 进行滚轮位移。

## 5. 风险与注意事项
- 改动 `PIXI.Application` 的 resize 初始化过程需反复确认原 `g_ctx.tiledimx` 栅格在绘制时与新宽高兼容匹配，防出现缩放时画布外点击穿透报错。
- `e.preventDefault()` 屏蔽滚轮行为时需只在 `tilesetpane` 区域起效，避免误杀右侧全屏滚动能力。
- 高亮框在缩放时坐标仍使用 Pixi 的本地坐标系，缩放不影响其真实对齐效果。