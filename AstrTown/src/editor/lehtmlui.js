import * as PIXI from 'pixi.js'
import { g_ctx }  from './lecontext.js' // global context
import * as CONFIG from './leconfig.js'
import { getTilesetBookmarks } from './tileset-meta.js'
import { openAssetPicker, registerUserAssetToEditor } from './asset-picker-bridge.js'

// --
//  Set sizes and limits for HTML in main UI
// --

export function initMainHTMLWindow() {
    const paneIds = ['layer0pane', 'layer1pane', 'layer2pane', 'layer3pane'];
    for (const paneId of paneIds) {
        const pane = document.getElementById(paneId);
        if (!pane) {
            continue;
        }
        pane.style.maxWidth = `${CONFIG.htmlLayerPaneW}px`;
        pane.style.maxHeight = `${CONFIG.htmlLayerPaneH}px`;
    }

    const tilesetPane = document.getElementById('tilesetpane');
    if (tilesetPane) {
        tilesetPane.style.maxWidth = '100%';
        tilesetPane.style.maxHeight = '100%';
    }

    const compositePane = document.getElementById('compositepane');
    if (compositePane) {
        compositePane.style.maxWidth = '100%';
        compositePane.style.maxHeight = '100%';
    }

    const mapPane = document.getElementById('map');
    if (mapPane) {
        mapPane.style.display = 'none';
    }
}

export function updateAuthStatus(user) {
    const authNode = document.getElementById('status-auth');
    if (!authNode) {
        return;
    }

    if (user && typeof user.username === 'string' && user.username.trim()) {
        authNode.textContent = `用户：${user.username}`;
        authNode.title = `当前已登录用户：${user.username}`;
        return;
    }

    authNode.textContent = '用户：未登录（可继续使用本地编辑功能）';
    authNode.title = '当前未登录，仅可使用无需认证的本地编辑功能';
}

// --
// Initialize handlers for file loading
// --

export function bindInspectorResizer() {
    if (g_ctx._inspectorResizerBound) {
        return;
    }

    const resizer = document.getElementById('inspector-resizer');
    if (!resizer) {
        return;
    }

    const minWidth = 240;
    const maxWidth = 420;
    let dragging = false;

    const onPointerMove = (event) => {
        if (!dragging) {
            return;
        }
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const nextWidth = Math.min(maxWidth, Math.max(minWidth, viewportWidth - event.clientX));
        document.documentElement.style.setProperty('--inspector-w', `${nextWidth}px`);
        if (typeof g_ctx.onWorkspaceLayoutChange === 'function') {
            g_ctx.onWorkspaceLayoutChange();
        }
    };

    const stopDragging = () => {
        dragging = false;
        resizer.classList.remove('is-dragging');
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', stopDragging);
        if (typeof g_ctx.onWorkspaceLayoutChange === 'function') {
            g_ctx.onWorkspaceLayoutChange();
        }
    };

    resizer.addEventListener('pointerdown', (event) => {
        dragging = true;
        resizer.classList.add('is-dragging');
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stopDragging);
        event.preventDefault();
    });

    g_ctx._inspectorResizerBound = true;
}

export function bindResourcePanelResizer() {
    if (g_ctx._resourcePanelResizerBound) {
        return;
    }

    const resizer = document.getElementById('vertical-resizer');
    const workspace = document.getElementById('app-workspace');
    if (!resizer || !workspace) {
        return;
    }

    const minHeight = 240;
    let dragging = false;

    const onPointerMove = (event) => {
        if (!dragging) {
            return;
        }

        const workspaceRect = workspace.getBoundingClientRect();
        const nextHeight = workspaceRect.bottom - event.clientY;
        const maxHeight = Math.max(minHeight, Math.floor(workspaceRect.height * 0.6));
        const clampedHeight = Math.min(maxHeight, Math.max(minHeight, nextHeight));

        workspace.style.setProperty('--resource-panel-h', `${clampedHeight}px`);
        if (typeof g_ctx.onWorkspaceLayoutChange === 'function') {
            g_ctx.onWorkspaceLayoutChange();
        }
    };

    const stopDragging = () => {
        dragging = false;
        resizer.classList.remove('is-dragging');
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', stopDragging);
        if (typeof g_ctx.onWorkspaceLayoutChange === 'function') {
            g_ctx.onWorkspaceLayoutChange();
        }
    };

    resizer.addEventListener('pointerdown', (event) => {
        dragging = true;
        resizer.classList.add('is-dragging');
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', stopDragging);
        event.preventDefault();
    });

    g_ctx._resourcePanelResizerBound = true;
}

function groupBookmarksByCategory(bookmarks = []) {
    const groups = [];
    const groupMap = new Map();

    for (const bookmark of bookmarks) {
        const category = bookmark?.category || '未分类';
        if (!groupMap.has(category)) {
            const entry = { category, items: [] };
            groupMap.set(category, entry);
            groups.push(entry);
        }
        groupMap.get(category).items.push(bookmark);
    }

    return groups;
}

function getTilesetDisplayName(tilesetPath) {
    if (typeof tilesetPath !== 'string') {
        return '';
    }

    const normalized = tilesetPath.trim();
    if (!normalized) {
        return '';
    }

    const withoutQuery = normalized.split(/[?#]/, 1)[0] || '';
    const sanitized = withoutQuery.replace(/\\/g, '/');
    const segments = sanitized.split('/').filter(Boolean);
    return segments.pop() || '';
}

function getResourceKindLabel(sourceKind, resourceType) {
    if (sourceKind === 'local') {
        return '本地导入';
    }
    if (sourceKind === 'userAsset') {
        return resourceType === 'spritesheet' ? '资源库动画' : '资源库瓦片集';
    }
    if (resourceType === 'spritesheet') {
        return '内置动画资源';
    }
    return '地图默认';
}

function getToolbarResourceType() {
    return g_ctx.resourceToolbarType === 'spritesheet' ? 'spritesheet' : 'tileset';
}

function setToolbarResourceType(type) {
    g_ctx.resourceToolbarType = type === 'spritesheet' ? 'spritesheet' : 'tileset';
}

export function renderTilesetBookmarks() {
    const list = document.getElementById('tileset-roi-list');
    const pane = document.getElementById('tilesetpane');
    if (!list || !pane) {
        return;
    }

    const tilesetZoom = Number.isFinite(g_ctx.tilesetZoom) ? g_ctx.tilesetZoom : 1;
    const activeTileset = typeof g_ctx.getActiveTilesetResource === 'function'
        ? g_ctx.getActiveTilesetResource()
        : null;
    const isBuiltinTileset = !activeTileset || activeTileset.sourceKind === 'builtin';
    const lookupPath = activeTileset?.path || g_ctx.tilesetpath;
    const bookmarks = isBuiltinTileset ? getTilesetBookmarks(lookupPath) : [];
    list.innerHTML = '';

    if (!isBuiltinTileset) {
        const empty = document.createElement('div');
        empty.id = 'tileset-roi-empty';
        empty.textContent = '自定义资源无预设分类';
        list.appendChild(empty);
        return;
    }

    if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
        const empty = document.createElement('div');
        empty.id = 'tileset-roi-empty';
        empty.textContent = '当前 Tileset 暂无快捷定位';
        list.appendChild(empty);
        return;
    }

    const groups = groupBookmarksByCategory(bookmarks);
    for (const group of groups) {
        const section = document.createElement('section');
        section.className = 'tileset-roi-group';

        const title = document.createElement('div');
        title.className = 'tileset-roi-group-title';
        title.textContent = group.category;
        section.appendChild(title);

        const buttonList = document.createElement('div');
        buttonList.className = 'tileset-roi-group-list';

        for (const item of group.items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tileset-roi-btn';
            button.textContent = item.label;
            button.addEventListener('click', () => {
                pane.scrollTo({
                    top: Math.max(0, Math.round((Number(item.y) || 0) * tilesetZoom)),
                    behavior: 'smooth',
                });
            });
            buttonList.appendChild(button);
        }

        section.appendChild(buttonList);
        list.appendChild(section);
    }
}

export function bindTilesetPrimaryActions() {
    if (g_ctx._tilesetPrimaryActionsBound) {
        return;
    }

    const changeBtn = document.getElementById('btn-change-tileset');
    const fileInput = document.getElementById('tilesetfile');
    if (changeBtn && fileInput) {
        changeBtn.addEventListener('click', () => fileInput.click());
    }

    g_ctx._tilesetPrimaryActionsBound = true;
}

export function updateResourceInfo() {
    const nameNode = document.getElementById('current-resource-name');
    const sourceNode = document.getElementById('current-resource-source');
    const label = document.getElementById('tileset-current-label');
    const type = getToolbarResourceType();
    const activeResource = type === 'spritesheet'
        ? (typeof g_ctx.getActiveSpritesheetResource === 'function' ? g_ctx.getActiveSpritesheetResource() : null)
        : (typeof g_ctx.getActiveTilesetResource === 'function' ? g_ctx.getActiveTilesetResource() : null);

    const displayName = activeResource?.fileName || activeResource?.label || getTilesetDisplayName(g_ctx.tilesetpath) || '-';
    const sourceLabel = activeResource
        ? `来源：${getResourceKindLabel(activeResource.sourceKind, activeResource.type)}${activeResource.path ? ` · ${activeResource.path}` : ''}`
        : '来源：-';
    const summary = activeResource
        ? `${activeResource.type === 'spritesheet' ? '动画资源' : '瓦片集'} · ${displayName} · ${getResourceKindLabel(activeResource.sourceKind, activeResource.type)}`
        : '当前资源：-';

    if (nameNode) {
        nameNode.textContent = `当前：${displayName}`;
    }
    if (sourceNode) {
        sourceNode.textContent = sourceLabel;
    }
    if (label) {
        label.textContent = summary;
        label.title = activeResource?.path || summary;
    }
}

export function updateTilesetMetaLabel() {
    updateResourceInfo();
}

// --
// Initialize handlers loading a PNG file into the composite window 
// --

export function initCompositePNGLoader() {
    const fileInput = document.getElementById('compositepng');
    fileInput.onchange = (evt) => {
        if (!window.FileReader) return; // Browser is not compatible
        if (g_ctx.debug_flag) {
            console.log("compositepng ", fileInput.files[0].name);
        }
        let bgname = fileInput.files[0].name;

        const texture = PIXI.Texture.from("./tilesets/"+bgname);
        const bg      = new PIXI.Sprite(texture);
        bg.zIndex = 0;
        g_ctx.composite.container.addChild(bg);
    }
}

// -- 
// initailized handler to load a spriteSheet into current working tile
// --

export function initSpriteSheetLoader(onSpritesheetLoaded = null) {
    const fileInput = document.getElementById('spritesheet');
    fileInput.onchange = async (evt) => {
        if (!window.FileReader) return; // Browser is not compatible
        if (g_ctx.debug_flag) {
            console.log("spritesheet ", fileInput.files[0].name);
        }
        const file = fileInput.files[0];
        const ssname = file.name;

        let sheet = await PIXI.Assets.load("./" + ssname);
        console.log(sheet);
        g_ctx.tileset.addTileSheet(ssname, sheet, {
            sourceKind: 'local',
            fileName: ssname,
            path: ssname,
            isActive: true,
        });
        if (typeof onSpritesheetLoaded === 'function') {
            onSpritesheetLoaded(ssname, sheet, {
                type: 'spritesheet',
                sourceKind: 'local',
                fileName: ssname,
                path: ssname,
                isActive: true,
            });
        }
        g_ctx.selected_tiles = [];
        updateResourceInfo();
        if (typeof g_ctx.refreshResourceToolbar === 'function') {
            g_ctx.refreshResourceToolbar();
        }
        if (typeof g_ctx.refreshSceneAnimationUI === 'function') {
            g_ctx.refreshSceneAnimationUI();
        }
    }
}

function parseNumberInput(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function bindSceneAnimationUI(api = {}) {
    const sheetSelect = document.getElementById('scene-anim-sheet-select');
    const animList = document.getElementById('scene-anim-list');
    const previewCanvas = document.getElementById('scene-anim-preview-canvas');
    const brushSpeedInput = document.getElementById('scene-anim-brush-speed');
    const brushLoopInput = document.getElementById('scene-anim-brush-loop');
    const instanceInfo = document.getElementById('scene-anim-instance-info');
    const instanceSpeedInput = document.getElementById('scene-anim-instance-speed');
    const instanceLoopInput = document.getElementById('scene-anim-instance-loop');
    const applyBtn = document.getElementById('scene-anim-apply-instance');

    if (!sheetSelect || !animList || !previewCanvas || !brushSpeedInput || !brushLoopInput || !instanceInfo || !instanceSpeedInput || !instanceLoopInput || !applyBtn) {
        return;
    }

    const getResourceRegistry = typeof api.getResourceRegistry === 'function'
        ? api.getResourceRegistry
        : () => ({ spritesheets: [] });
    const getBrush = typeof api.getBrush === 'function'
        ? api.getBrush
        : () => ({ sheet: '', animationName: '', speed: 0.1, loop: true });
    const setBrush = typeof api.setBrush === 'function'
        ? api.setBrush
        : () => null;
    const getSelection = typeof api.getSelection === 'function'
        ? api.getSelection
        : () => null;
    const applySelection = typeof api.applySelection === 'function'
        ? api.applySelection
        : () => false;

    const previewApp = new PIXI.Application({
        view: previewCanvas,
        width: previewCanvas.width,
        height: previewCanvas.height,
        backgroundAlpha: 0,
    });
    const previewContainer = new PIXI.Container();
    previewApp.stage.addChild(previewContainer);

    let previewSprite = null;

    function renderPreview() {
        if (previewSprite) {
            previewContainer.removeChild(previewSprite);
            previewSprite.destroy();
            previewSprite = null;
        }

        const brush = getBrush() || {};
        const registry = getResourceRegistry() || { spritesheets: [] };
        const selectedSheet = (registry.spritesheets || []).find((item) => item.name === brush.sheet);
        const sheet = selectedSheet?.sheet || null;
        const animationFrames = sheet?.animations?.[brush.animationName] || null;

        if (!animationFrames) {
            return;
        }

        previewSprite = new PIXI.AnimatedSprite(animationFrames);
        previewSprite.animationSpeed = parseNumberInput(brush.speed, 0.1);
        previewSprite.loop = !!brush.loop;
        previewSprite.anchor.set(0.5, 0.5);
        previewSprite.x = previewCanvas.width / 2;
        previewSprite.y = previewCanvas.height / 2;
        previewSprite.play();
        previewContainer.addChild(previewSprite);
    }

    function renderAnimationList(registry, brush) {
        animList.innerHTML = '';

        const selectedSheet = (registry.spritesheets || []).find((item) => item.name === brush.sheet);
        const animations = Array.isArray(selectedSheet?.animations) ? selectedSheet.animations : [];

        if (animations.length === 0) {
            const empty = document.createElement('li');
            empty.textContent = '暂无可用动画';
            animList.appendChild(empty);
            return;
        }

        for (const animationName of animations) {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = animationName;
            btn.className = 'semantic-btn';
            if (animationName === brush.animationName) {
                btn.classList.add('is-active');
            }
            btn.addEventListener('click', () => {
                setBrush({ animationName });
            });
            li.appendChild(btn);
            animList.appendChild(li);
        }
    }

    function renderSheetSelect(registry, brush) {
        const currentValue = sheetSelect.value;
        sheetSelect.innerHTML = '';

        const sheets = Array.isArray(registry.spritesheets) ? registry.spritesheets : [];
        if (sheets.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '暂无已加载 Spritesheet';
            sheetSelect.appendChild(option);
            sheetSelect.value = '';
            return;
        }

        for (const item of sheets) {
            const option = document.createElement('option');
            option.value = item.name;
            option.textContent = item.name;
            sheetSelect.appendChild(option);
        }

        if (brush.sheet) {
            sheetSelect.value = brush.sheet;
        } else if (currentValue && sheets.some((item) => item.name === currentValue)) {
            sheetSelect.value = currentValue;
        } else {
            sheetSelect.selectedIndex = 0;
        }
    }

    function renderSelection(selection) {
        if (!selection) {
            instanceInfo.textContent = '当前未选中场景动画实例';
            instanceSpeedInput.value = String(parseNumberInput(getBrush()?.speed, 0.1));
            instanceLoopInput.checked = !!(getBrush()?.loop ?? true);
            applyBtn.disabled = true;
            return;
        }

        instanceInfo.textContent = `实例 ${selection.instanceId}`;
        instanceSpeedInput.value = String(parseNumberInput(selection.speed, 0.1));
        instanceLoopInput.checked = !!selection.loop;
        applyBtn.disabled = false;
    }

    function refresh() {
        const registry = getResourceRegistry() || { spritesheets: [] };
        const brush = getBrush() || { sheet: '', animationName: '', speed: 0.1, loop: true };
        const selection = getSelection();

        renderSheetSelect(registry, brush);
        renderAnimationList(registry, brush);
        brushSpeedInput.value = String(parseNumberInput(brush.speed, 0.1));
        brushLoopInput.checked = !!brush.loop;
        renderSelection(selection);
        renderPreview();
    }

    sheetSelect.addEventListener('change', () => {
        setBrush({ sheet: sheetSelect.value });
    });

    brushSpeedInput.addEventListener('change', () => {
        setBrush({ speed: parseNumberInput(brushSpeedInput.value, 0.1) });
    });

    brushLoopInput.addEventListener('change', () => {
        setBrush({ loop: !!brushLoopInput.checked });
    });

    applyBtn.addEventListener('click', () => {
        applySelection({
            speed: parseNumberInput(instanceSpeedInput.value, 0.1),
            loop: !!instanceLoopInput.checked,
        });
    });

    g_ctx.refreshSceneAnimationUI = refresh;
    g_ctx.onSceneAnimSelectionChange = refresh;
    refresh();
}

// -- 
// initailized handler to load a new tileset 
// --

export function updateResourceSelector() {
    const select = document.getElementById('resource-select');
    if (!select || typeof g_ctx.getResourceRegistry !== 'function') {
        return;
    }

    const registry = g_ctx.getResourceRegistry() || { tilesets: [], spritesheets: [] };
    const type = getToolbarResourceType();
    const resourceList = type === 'spritesheet' ? registry.spritesheets : registry.tilesets;
    const activeValue = type === 'spritesheet' ? registry.activeSpritesheet : registry.activeTileset;

    select.innerHTML = '';

    if (!Array.isArray(resourceList) || resourceList.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = type === 'spritesheet'
            ? '暂无动画资源，请稍候等待预加载完成或点击“导入动画”'
            : '暂无瓦片资源，请点击“导入 Tileset”或恢复默认资源';
        select.appendChild(option);
        select.title = option.textContent;
        select.value = '';
        return;
    }

    select.title = '';

    for (const item of resourceList) {
        const option = document.createElement('option');
        option.value = item.key || item.name || item.path || '';
        const sourceTag = item.sourceKind === 'local' ? '本地' : '内置';
        option.textContent = `${item.fileName || item.label || option.value} · ${sourceTag}`;
        select.appendChild(option);
    }

    const targetValue = activeValue || resourceList[0]?.key || '';
    select.value = targetValue;
}

export function initResourceToolbar(api = {}) {
    if (g_ctx._resourceToolbarBound) {
        g_ctx.refreshResourceToolbar = () => {
            updateResourceSelector();
            updateResourceInfo();
            renderTilesetBookmarks();
        };
        g_ctx.refreshResourceToolbar();
        return;
    }

    const tabTileset = document.getElementById('tab-tileset');
    const tabSpritesheet = document.getElementById('tab-spritesheet');
    const select = document.getElementById('resource-select');
    const importTilesetBtn = document.getElementById('btn-import-tileset');
    const importSpritesheetBtn = document.getElementById('btn-import-spritesheet');
    const libraryPickBtn = document.getElementById('btn-pick-library-asset');
    const useDefaultBtn = document.getElementById('btn-use-default');
    const tilesetFileInput = document.getElementById('tilesetfile');
    const spritesheetFileInput = document.getElementById('spritesheet');

    const refresh = () => {
        const type = getToolbarResourceType();
        if (tabTileset) {
            tabTileset.classList.toggle('active', type === 'tileset');
        }
        if (tabSpritesheet) {
            tabSpritesheet.classList.toggle('active', type === 'spritesheet');
        }
        if (importTilesetBtn) {
            importTilesetBtn.disabled = type !== 'tileset';
        }
        if (importSpritesheetBtn) {
            importSpritesheetBtn.disabled = type !== 'spritesheet';
        }
        if (libraryPickBtn) {
            libraryPickBtn.disabled = false;
            libraryPickBtn.textContent = type === 'spritesheet' ? '从资源库选择动画' : '从资源库选择';
        }
        if (useDefaultBtn) {
            useDefaultBtn.disabled = type !== 'tileset';
        }
        updateResourceSelector();
        updateResourceInfo();
        renderTilesetBookmarks();
    };

    if (tabTileset) {
        tabTileset.addEventListener('click', () => {
            setToolbarResourceType('tileset');
            refresh();
        });
    }

    if (tabSpritesheet) {
        tabSpritesheet.addEventListener('click', () => {
            setToolbarResourceType('spritesheet');
            refresh();
        });
    }

    if (select) {
        select.addEventListener('change', () => {
            if (!select.value) {
                return;
            }
            if (getToolbarResourceType() === 'spritesheet') {
                if (typeof api.onSpritesheetChange === 'function') {
                    api.onSpritesheetChange(select.value);
                }
            } else if (typeof api.onTilesetChange === 'function') {
                api.onTilesetChange(select.value);
            }
            refresh();
        });
    }

    if (importTilesetBtn && tilesetFileInput) {
        importTilesetBtn.addEventListener('click', () => tilesetFileInput.click());
    }

    if (importSpritesheetBtn && spritesheetFileInput) {
        importSpritesheetBtn.addEventListener('click', () => spritesheetFileInput.click());
    }

    if (libraryPickBtn) {
        libraryPickBtn.addEventListener('click', () => {
            const type = getToolbarResourceType();
            openAssetPicker({
                assetKind: type === 'spritesheet' ? 'sceneAnimation' : 'tileset',
                onSelect: async (assetInfo) => {
                    const entry = await registerUserAssetToEditor(assetInfo);
                    if (assetInfo.assetKind === 'sceneAnimation') {
                        if (typeof api.onSpritesheetChange === 'function') {
                            api.onSpritesheetChange(entry.key);
                        }
                    } else if (typeof api.onTilesetChange === 'function') {
                        api.onTilesetChange(entry.key);
                    }
                    refresh();
                    if (typeof g_ctx.refreshSceneAnimationUI === 'function') {
                        g_ctx.refreshSceneAnimationUI();
                    }
                },
                onCancel: () => {
                    refresh();
                },
            });
        });
    }

    if (useDefaultBtn) {
        useDefaultBtn.addEventListener('click', () => {
            if (typeof api.onUseDefaultTileset === 'function') {
                api.onUseDefaultTileset();
            }
            refresh();
        });
    }

    setToolbarResourceType(getToolbarResourceType());
    g_ctx.refreshResourceToolbar = refresh;
    g_ctx._resourceToolbarBound = true;
    refresh();
}

export function initTilesetLoader(callme, onTilesetChanged = null) {
    const fileInput = document.getElementById('tilesetfile');
    fileInput.onchange = async (evt) => {
        if (!window.FileReader) return; // Browser is not compatible
        if (g_ctx.debug_flag) {
            console.log("tilesetfile ", fileInput.files[0].name);
        }
        const file = fileInput.files[0];
        g_ctx.tilesetpath =  "./tilesets/" + file.name;
        updateTilesetMetaLabel();
        if (typeof onTilesetChanged === 'function') {
            onTilesetChanged(g_ctx.tilesetpath, g_ctx.tilesetpath, {
                type: 'tileset',
                sourceKind: 'local',
                fileName: file.name,
                isActive: true,
            });
        }

        if (typeof g_ctx.refreshResourceToolbar === 'function') {
            g_ctx.refreshResourceToolbar();
        }
        callme();
    }
}


// -- 
// initailized handler to load a level from a file 
// --

function doimport (str) {
    if (globalThis.URL.createObjectURL) {
      const blob = new Blob([str], { type: 'text/javascript' })
      const url = URL.createObjectURL(blob)
      const module = import(url)
      URL.revokeObjectURL(url) // GC objectURLs
      return module
    }
    
    const url = "data:text/javascript;base64," + btoa(moduleData)
    return import(url)
  }

export function initLevelLoader(callme) {
    let filecontent = "";

    const fileInput = document.getElementById('levelfile');
    fileInput.onchange = (evt) => {
        if (!window.FileReader) return; // Browser is not compatible

        var reader = new FileReader();

        reader.onload = function (evt) {
            if (evt.target.readyState != 2) return;
            if (evt.target.error) {
                alert('Error while reading file');
                return;
            }

            filecontent = evt.target.result;
            doimport(filecontent).then(mod => callme(mod));
        };

        reader.readAsText(evt.target.files[0]);
    }
}