import * as CONFIG from './leconfig.js';

let editorCtx = null;

function getDraftTemplate() {
    return {
        draftId: null,
        resourceName: '',
        sourceType: 'tileset',
        sourceSheet: null,
        sourceImage: null,
        frameWidth: 32,
        frameHeight: 32,
        frames: [],
        animationName: '',
        fps: 10,
        loop: true,
        dirty: false,
    };
}

function isAnimationEditorReady() {
    return !!editorCtx;
}

function ensureEditorCtx() {
    if (!editorCtx) {
        throw new Error('animation-editor 尚未初始化');
    }
    return editorCtx;
}

function ensureDraft() {
    const ctx = ensureEditorCtx();
    if (!ctx.g_ctx.animationDraft) {
        ctx.g_ctx.animationDraft = createNewAnimationDraft();
    }
    return ctx.g_ctx.animationDraft;
}

function getAnimationStage() {
    return ensureEditorCtx().g_ctx.composite?.workspaceStages?.animationStage || null;
}

function getRegistry() {
    const ctx = ensureEditorCtx();
    return typeof ctx.g_ctx.getResourceRegistry === 'function'
        ? ctx.g_ctx.getResourceRegistry()
        : { tilesets: [], spritesheets: [], activeTileset: null, activeSpritesheet: null };
}

function getDom() {
    return ensureEditorCtx().dom;
}

function getFrameKey(frame) {
    if (!frame) {
        return '';
    }
    return String(frame.frameKey || '');
}

function markDirty(flag = true) {
    const draft = ensureDraft();
    draft.dirty = !!flag;
}

function nextDraftId() {
    return `draft_${Date.now()}`;
}

function nextFrameKey(index) {
    return `frame_${String(index + 1).padStart(4, '0')}`;
}

function clampNumber(value, fallback, min = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, parsed);
}

function getSourceImagePathFromSheetPath(sheetPath) {
    const normalized = typeof sheetPath === 'string' ? sheetPath.trim() : '';
    if (!normalized) {
        return null;
    }
    return normalized
        .replace(/^\.\//, './')
        .replace(/\\/g, '/');
}

function buildSheetFramesFromSpritesheet(sourceSheet) {
    const cache = [];
    if (!sourceSheet?.textures) {
        return cache;
    }

    const textureEntries = Object.entries(sourceSheet.textures);
    textureEntries.forEach(([name, texture], index) => {
        const frame = texture?.frame;
        if (!frame) {
            return;
        }
        cache.push({
            frameKey: nextFrameKey(index),
            x: frame.x,
            y: frame.y,
            w: frame.width,
            h: frame.height,
            order: index,
            sourceFrameName: name,
            texture,
        });
    });
    return cache;
}

function createTextureFromFrame(frame) {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();

    if (draft.sourceType === 'spritesheet' && draft.sourceSheet?.textures?.[frame.sourceFrameName]) {
        return draft.sourceSheet.textures[frame.sourceFrameName];
    }

    if (!draft.sourceImage) {
        return null;
    }

    const baseTexture = ctx.PIXI.BaseTexture.from(draft.sourceImage, {
        scaleMode: ctx.PIXI.SCALE_MODES.NEAREST,
    });

    return new ctx.PIXI.Texture(baseTexture, new ctx.PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h));
}

function clearStage() {
    const stage = getAnimationStage();
    if (!stage) {
        return;
    }
    stage.removeChildren();
}

function emitDraftChange() {
    const ctx = ensureEditorCtx();
    if (typeof ctx.g_ctx.refreshAnimationEditorUI === 'function') {
        ctx.g_ctx.refreshAnimationEditorUI();
    }
}

function ensureSelectionOrderMap() {
    const draft = ensureDraft();
    const orderMap = new Map();
    draft.frames.forEach((frame, index) => {
        orderMap.set(getFrameKey(frame), index + 1);
    });
    return orderMap;
}

function drawSelectionBadge(graphics, textLayer, frame, orderMap) {
    const ctx = ensureEditorCtx();
    const order = orderMap.get(getFrameKey(frame));
    if (!order) {
        return;
    }

    graphics.lineStyle(2, 0x22c55e, 1);
    graphics.beginFill(0x22c55e, 0.25);
    graphics.drawRect(frame.x, frame.y, frame.w, frame.h);
    graphics.endFill();

    const labelBg = new ctx.PIXI.Graphics();
    labelBg.beginFill(0x0f172a, 0.9);
    labelBg.drawRoundedRect(frame.x + 2, frame.y + 2, 22, 16, 4);
    labelBg.endFill();
    textLayer.addChild(labelBg);

    const label = new ctx.PIXI.Text(String(order), {
        fontFamily: 'Consolas',
        fontSize: 11,
        fill: 0xe2e8f0,
    });
    label.x = frame.x + 8;
    label.y = frame.y + 4;
    textLayer.addChild(label);
}

function buildGridFrameList() {
    const draft = ensureDraft();
    if (draft.sourceType === 'spritesheet' && Array.isArray(draft._sheetFrames)) {
        return draft._sheetFrames;
    }

    const frameWidth = clampNumber(draft.frameWidth, 32, 1);
    const frameHeight = clampNumber(draft.frameHeight, 32, 1);
    const baseTexture = draft.sourceImage ? ensureEditorCtx().PIXI.BaseTexture.from(draft.sourceImage) : null;
    const sourceWidth = baseTexture?.width || 0;
    const sourceHeight = baseTexture?.height || 0;
    const columns = frameWidth > 0 ? Math.floor(sourceWidth / frameWidth) : 0;
    const rows = frameHeight > 0 ? Math.floor(sourceHeight / frameHeight) : 0;
    const frames = [];

    let order = 0;
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
            frames.push({
                frameKey: nextFrameKey(order),
                x: col * frameWidth,
                y: row * frameHeight,
                w: frameWidth,
                h: frameHeight,
                order,
                sourceFrameName: null,
            });
            order += 1;
        }
    }

    draft._gridFrames = frames;
    return frames;
}

function renderAnimationWorkspace() {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    const stage = getAnimationStage();
    if (!stage) {
        return;
    }

    clearStage();

    if (!draft.sourceImage) {
        return;
    }

    const orderMap = ensureSelectionOrderMap();
    const sourceSprite = ctx.PIXI.Sprite.from(draft.sourceImage);
    sourceSprite.eventMode = 'static';
    sourceSprite.cursor = 'pointer';
    sourceSprite.on('pointertap', (event) => {
        const local = event.getLocalPosition(sourceSprite);
        selectFrameFromSource(local.x, local.y);
    });
    stage.addChild(sourceSprite);

    const overlay = new ctx.PIXI.Graphics();
    overlay.zIndex = 10;
    stage.addChild(overlay);

    const textLayer = new ctx.PIXI.Container();
    textLayer.zIndex = 11;
    stage.addChild(textLayer);

    const gridFrames = buildGridFrameList();
    gridFrames.forEach((frame) => {
        overlay.lineStyle(1, 0xffffff, 0.14);
        overlay.drawRect(frame.x, frame.y, frame.w, frame.h);
        drawSelectionBadge(overlay, textLayer, frame, orderMap);
    });

    renderPreviewSprite();
}

function clearPreviewSprite() {
    const ctx = ensureEditorCtx();
    if (ctx.previewSprite) {
        ctx.previewSprite.stop();
        ctx.previewSprite.destroy();
        ctx.previewSprite = null;
    }
}

function renderPreviewSprite() {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    const stage = getAnimationStage();
    clearPreviewSprite();

    if (!stage || !Array.isArray(draft.frames) || draft.frames.length === 0) {
        return;
    }

    const textures = draft.frames
        .map((frame) => createTextureFromFrame(frame))
        .filter(Boolean);

    if (textures.length === 0) {
        return;
    }

    const preview = new ctx.PIXI.AnimatedSprite(textures);
    preview.animationSpeed = Math.max((draft.fps || 1) / 60, 0.01);
    preview.loop = !!draft.loop;
    preview.x = Math.max(16, (ctx.g_ctx.tilesetpxw || 0) - 120);
    preview.y = 24;
    preview.scale.set(2);
    preview.zIndex = 20;
    preview.play();
    stage.addChild(preview);
    ctx.previewSprite = preview;
}

function syncDraftFromForm() {
    const draft = ensureDraft();
    const dom = getDom();

    if (dom.animationNameInput) {
        draft.animationName = dom.animationNameInput.value.trim();
    }
    if (dom.resourceNameInput) {
        draft.resourceName = dom.resourceNameInput.value.trim();
    }
    if (dom.fpsInput) {
        draft.fps = clampNumber(dom.fpsInput.value, 10, 1);
        dom.fpsInput.value = String(draft.fps);
    }
    if (dom.loopInput) {
        draft.loop = !!dom.loopInput.checked;
    }
    if (dom.frameWidthInput) {
        draft.frameWidth = clampNumber(dom.frameWidthInput.value, draft.frameWidth || 32, 1);
        dom.frameWidthInput.value = String(draft.frameWidth);
    }
    if (dom.frameHeightInput) {
        draft.frameHeight = clampNumber(dom.frameHeightInput.value, draft.frameHeight || 32, 1);
        dom.frameHeightInput.value = String(draft.frameHeight);
    }
}

function fillFormFromDraft() {
    const draft = ensureDraft();
    const dom = getDom();

    if (dom.animationNameInput) {
        dom.animationNameInput.value = draft.animationName || '';
    }
    if (dom.resourceNameInput) {
        dom.resourceNameInput.value = draft.resourceName || '';
    }
    if (dom.fpsInput) {
        dom.fpsInput.value = String(draft.fps || 10);
    }
    if (dom.loopInput) {
        dom.loopInput.checked = !!draft.loop;
    }
    if (dom.frameWidthInput) {
        dom.frameWidthInput.value = String(draft.frameWidth || 32);
    }
    if (dom.frameHeightInput) {
        dom.frameHeightInput.value = String(draft.frameHeight || 32);
    }
}

function renderTimeline() {
    const draft = ensureDraft();
    const dom = getDom();
    if (!dom.timelineList) {
        return;
    }

    dom.timelineList.innerHTML = '';

    if (!draft.frames.length) {
        const empty = document.createElement('li');
        empty.className = 'animation-timeline-empty';
        empty.textContent = '尚未添加帧，请在主画布点击源资源中的帧';
        dom.timelineList.appendChild(empty);
        return;
    }

    draft.frames.forEach((frame, index) => {
        const item = document.createElement('li');
        item.className = 'animation-timeline-item';
        item.draggable = true;
        item.dataset.frameKey = frame.frameKey;

        const thumb = document.createElement('canvas');
        thumb.className = 'animation-timeline-thumb';
        thumb.width = 48;
        thumb.height = 48;
        const thumbCtx = thumb.getContext('2d');
        if (thumbCtx && draft.sourceImage) {
            const img = new Image();
            img.onload = () => {
                thumbCtx.imageSmoothingEnabled = false;
                thumbCtx.clearRect(0, 0, 48, 48);
                thumbCtx.drawImage(img, frame.x, frame.y, frame.w, frame.h, 0, 0, 48, 48);
            };
            img.src = draft.sourceImage;
        }

        const meta = document.createElement('div');
        meta.className = 'animation-timeline-meta';
        meta.innerHTML = `<strong>第 ${index + 1} 帧</strong><span>${frame.sourceFrameName || `${frame.x},${frame.y},${frame.w},${frame.h}`}</span>`;

        const actions = document.createElement('div');
        actions.className = 'animation-timeline-actions';

        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '上移';
        upBtn.disabled = index === 0;
        upBtn.addEventListener('click', () => reorderFrames(index, index - 1));

        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '下移';
        downBtn.disabled = index === draft.frames.length - 1;
        downBtn.addEventListener('click', () => reorderFrames(index, index + 1));

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = '删除';
        removeBtn.addEventListener('click', () => removeFrameFromTimeline(frame.frameKey));

        item.addEventListener('dragstart', (event) => {
            event.dataTransfer?.setData('text/plain', String(index));
            item.classList.add('is-dragging');
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('is-dragging');
        });
        item.addEventListener('dragover', (event) => {
            event.preventDefault();
            item.classList.add('is-drop-target');
        });
        item.addEventListener('dragleave', () => {
            item.classList.remove('is-drop-target');
        });
        item.addEventListener('drop', (event) => {
            event.preventDefault();
            item.classList.remove('is-drop-target');
            const fromIndex = Number(event.dataTransfer?.getData('text/plain'));
            reorderFrames(fromIndex, index);
        });

        actions.appendChild(upBtn);
        actions.appendChild(downBtn);
        actions.appendChild(removeBtn);
        item.appendChild(thumb);
        item.appendChild(meta);
        item.appendChild(actions);
        dom.timelineList.appendChild(item);
    });
}

function updateSourceHint() {
    const draft = ensureDraft();
    const dom = getDom();
    if (!dom.sourceHint) {
        return;
    }

    if (!draft.sourceImage) {
        dom.sourceHint.textContent = '请先在底部资源区选择 tileset 或 spritesheet 作为帧源';
        return;
    }

    const frameCount = draft.frames.length;
    const sourceLabel = draft.resourceName || '未命名资源';
    dom.sourceHint.textContent = `当前帧源：${sourceLabel} · 已选 ${frameCount} 帧`;
}

function refreshEditorUI() {
    syncDraftFromForm();
    fillFormFromDraft();
    updateSourceHint();
    renderTimeline();
    renderAnimationWorkspace();
}

function bindDomEvents() {
    const dom = getDom();
    const inputs = [
        dom.animationNameInput,
        dom.resourceNameInput,
        dom.fpsInput,
        dom.loopInput,
        dom.frameWidthInput,
        dom.frameHeightInput,
    ].filter(Boolean);

    inputs.forEach((node) => {
        const eventName = node.type === 'checkbox' ? 'change' : 'input';
        node.addEventListener(eventName, () => {
            syncDraftFromForm();
            markDirty(true);
            refreshEditorUI();
        });
    });

    if (dom.applyButton) {
        dom.applyButton.addEventListener('click', () => {
            applyToResourceRegistry();
        });
    }

    if (dom.exportButton) {
        dom.exportButton.addEventListener('click', () => {
            exportAsJson();
        });
    }

    if (dom.resetButton) {
        dom.resetButton.addEventListener('click', () => {
            const nextDraft = createNewAnimationDraft();
            const ctx = ensureEditorCtx();
            ctx.g_ctx.animationDraft = nextDraft;
            refreshEditorUI();
        });
    }
}

function getTilesetSource() {
    const ctx = ensureEditorCtx();
    const active = typeof ctx.g_ctx.getActiveTilesetResource === 'function'
        ? ctx.g_ctx.getActiveTilesetResource()
        : null;
    if (!active?.path) {
        return null;
    }

    return {
        resourceName: active.fileName || active.label || active.path,
        sourceType: 'tileset',
        sourceSheet: null,
        sourceImage: active.path,
        frameWidth: ctx.g_ctx.tiledimx || 32,
        frameHeight: ctx.g_ctx.tiledimy || 32,
    };
}

function getSpritesheetSource() {
    const ctx = ensureEditorCtx();
    const active = typeof ctx.g_ctx.getActiveSpritesheetResource === 'function'
        ? ctx.g_ctx.getActiveSpritesheetResource()
        : null;
    if (!active?.sheet) {
        return null;
    }

    return {
        resourceName: active.fileName || active.label || active.name,
        sourceType: 'spritesheet',
        sourceSheet: active.sheet,
        sourceImage: getSourceImagePathFromSheetPath(active.sheet?.data?.meta?.image || active.path),
        frameWidth: active.sheet?.data?.frames
            ? Object.values(active.sheet.data.frames)[0]?.frame?.w || 32
            : 32,
        frameHeight: active.sheet?.data?.frames
            ? Object.values(active.sheet.data.frames)[0]?.frame?.h || 32
            : 32,
    };
}

function syncSourceFromResourceSelection() {
    const draft = ensureDraft();
    const registry = getRegistry();
    let source = null;

    if (registry.activeSpritesheet) {
        source = getSpritesheetSource();
    }
    if (!source && registry.activeTileset) {
        source = getTilesetSource();
    }

    if (!source) {
        refreshEditorUI();
        return draft;
    }

    const sourceChanged = draft.resourceName !== source.resourceName
        || draft.sourceType !== source.sourceType
        || draft.sourceImage !== source.sourceImage;

    draft.resourceName = source.resourceName;
    draft.sourceType = source.sourceType;
    draft.sourceSheet = source.sourceSheet;
    draft.sourceImage = source.sourceImage;
    draft.frameWidth = source.frameWidth;
    draft.frameHeight = source.frameHeight;
    if (source.sourceType === 'spritesheet') {
        draft._sheetFrames = buildSheetFramesFromSpritesheet(source.sourceSheet);
        draft._gridFrames = [];
    } else {
        draft._sheetFrames = [];
        draft._gridFrames = [];
    }

    if (sourceChanged) {
        draft.frames = [];
        markDirty(false);
    }

    refreshEditorUI();
    return draft;
}

export function initAnimationEditor(g_ctx, PIXI) {
    editorCtx = {
        g_ctx,
        PIXI,
        previewSprite: null,
        dom: {
            panel: document.getElementById('animation-editor-panel'),
            sourceHint: document.getElementById('animation-source-hint'),
            resourceNameInput: document.getElementById('animation-resource-name'),
            animationNameInput: document.getElementById('animation-name'),
            fpsInput: document.getElementById('animation-fps'),
            loopInput: document.getElementById('animation-loop'),
            frameWidthInput: document.getElementById('animation-frame-width'),
            frameHeightInput: document.getElementById('animation-frame-height'),
            timelineList: document.getElementById('animation-timeline-list'),
            applyButton: document.getElementById('animation-apply-resource'),
            exportButton: document.getElementById('animation-export-json'),
            resetButton: document.getElementById('animation-reset-draft'),
        },
    };

    g_ctx.animationDraft = createNewAnimationDraft();
    g_ctx.syncAnimationEditorSource = syncSourceFromResourceSelection;
    g_ctx.refreshAnimationEditorUI = refreshEditorUI;
    g_ctx.handleAnimationWorkspacePointer = (x, y) => selectFrameFromSource(x, y);
    bindDomEvents();
    syncSourceFromResourceSelection();
}

export function createNewAnimationDraft() {
    const draft = getDraftTemplate();
    draft.draftId = nextDraftId();
    return draft;
}

export function selectFrameFromSource(x, y) {
    const draft = ensureDraft();
    const gridFrames = buildGridFrameList();
    const target = gridFrames.find((frame) => (
        x >= frame.x
        && x < frame.x + frame.w
        && y >= frame.y
        && y < frame.y + frame.h
    ));

    if (!target) {
        return null;
    }

    const frame = {
        frameKey: `${target.frameKey}_${Date.now()}`,
        x: target.x,
        y: target.y,
        w: target.w,
        h: target.h,
        order: draft.frames.length,
        sourceFrameName: target.sourceFrameName || null,
    };

    addFrameToTimeline(frame);
    return frame;
}

export function addFrameToTimeline(frame) {
    const draft = ensureDraft();
    if (!frame) {
        return null;
    }

    draft.frames.push({
        ...frame,
        order: draft.frames.length,
    });
    markDirty(true);
    refreshEditorUI();
    return frame;
}

export function removeFrameFromTimeline(frameKey) {
    const draft = ensureDraft();
    const nextFrames = draft.frames.filter((item) => item.frameKey !== frameKey);
    draft.frames = nextFrames.map((item, index) => ({ ...item, order: index }));
    markDirty(true);
    refreshEditorUI();
}

export function reorderFrames(fromIndex, toIndex) {
    const draft = ensureDraft();
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
        return;
    }
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= draft.frames.length || toIndex >= draft.frames.length) {
        return;
    }
    if (fromIndex === toIndex) {
        return;
    }

    const nextFrames = draft.frames.slice();
    const [moved] = nextFrames.splice(fromIndex, 1);
    nextFrames.splice(toIndex, 0, moved);
    draft.frames = nextFrames.map((item, index) => ({ ...item, order: index }));
    markDirty(true);
    refreshEditorUI();
}

export function playAnimationPreview() {
    renderPreviewSprite();
}

export function stopAnimationPreview() {
    if (!isAnimationEditorReady()) {
        // 启动早期可能先切换工作区，此时动画编辑器尚未挂载完成
        console.info('stopAnimationPreview: animation-editor 尚未初始化，跳过预览清理');
        return;
    }
    clearPreviewSprite();
}

export { isAnimationEditorReady };

export function applyToResourceRegistry() {
    const ctx = ensureEditorCtx();
    const draft = ensureDraft();
    syncDraftFromForm();

    if (!draft.animationName || !draft.frames.length) {
        window.alert('请先填写动画名称并至少添加一帧');
        return null;
    }

    const textures = draft.frames
        .map((frame) => createTextureFromFrame(frame))
        .filter(Boolean);

    if (!textures.length) {
        window.alert('当前草稿无法生成有效纹理');
        return null;
    }

    const syntheticSheet = {
        animations: {
            [draft.animationName]: textures,
        },
        textures: Object.fromEntries(draft.frames.map((frame, index) => [
            `${draft.animationName}_${String(index + 1).padStart(4, '0')}.png`,
            createTextureFromFrame(frame),
        ])),
        data: exportAsJson(true),
    };

    let registeredResource = null;
    if (typeof ctx.g_ctx.registerSpritesheetResourceFromAnimationDraft === 'function') {
        registeredResource = ctx.g_ctx.registerSpritesheetResourceFromAnimationDraft(
            draft.resourceName || `${draft.animationName}.json`,
            syntheticSheet,
            draft,
        );
    }

    if (registeredResource?.name) {
        draft.resourceName = registeredResource.name;
    }

    if (typeof ctx.g_ctx.refreshResourceToolbar === 'function') {
        ctx.g_ctx.refreshResourceToolbar();
    }
    if (ctx.g_ctx.semantic && typeof ctx.g_ctx.semantic.refreshCatalog === 'function') {
        ctx.g_ctx.semantic.refreshCatalog();
    }

    markDirty(false);
    emitDraftChange();
    return syntheticSheet;
}

export function exportAsJson(returnObjectOnly = false) {
    const draft = ensureDraft();
    syncDraftFromForm();

    const frameEntries = {};
    const animationFrames = [];

    draft.frames.forEach((frame, index) => {
        const fileName = `${draft.animationName || 'animation'}_${String(index + 1).padStart(4, '0')}.png`;
        frameEntries[fileName] = {
            frame: {
                x: frame.x,
                y: frame.y,
                w: frame.w,
                h: frame.h,
            },
        };
        animationFrames.push(fileName);
    });

    const payload = {
        frames: frameEntries,
        animations: {
            [draft.animationName || 'animation']: animationFrames,
        },
        meta: {
            image: draft.sourceImage || '',
            format: 'RGBA8888',
            size: {
                w: ensureEditorCtx().PIXI.BaseTexture.from(draft.sourceImage || '').width || 0,
                h: ensureEditorCtx().PIXI.BaseTexture.from(draft.sourceImage || '').height || 0,
            },
            scale: 1,
            editor: {
                fps: draft.fps,
                loop: draft.loop,
                createdBy: 'animation-editor',
            },
        },
    };

    if (returnObjectOnly) {
        return payload;
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${draft.animationName || 'animation'}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return payload;
}
