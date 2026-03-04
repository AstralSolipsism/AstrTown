import * as PIXI from 'pixi.js';

const OVERLAY_NAME = '__semantic_overlay__';

function clampToGrid(value, tileDim) {
  return Math.floor(value / tileDim) * tileDim;
}

function createInstanceId() {
  return 'obj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function getTileSize(g_ctx) {
  return g_ctx?.tiledimx || 32;
}

function findInstanceIndexById(instances, instanceId) {
  return instances.findIndex((item) => item.instanceId === instanceId);
}

function getOverlayContainer(g_ctx) {
  if (!g_ctx?.composite?.container) {
    return null;
  }

  const children = g_ctx.composite.container.children;
  for (let i = 0; i < children.length; i++) {
    if (children[i].name === OVERLAY_NAME) {
      return children[i];
    }
  }

  const overlay = new PIXI.Container();
  overlay.name = OVERLAY_NAME;
  overlay.zIndex = 120;
  overlay.sortableChildren = true;
  g_ctx.composite.container.addChild(overlay);
  return overlay;
}

function parseObjectNote(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.trim();
}

function normalizeAppearance(catalogItem) {
  const fallbackFrame = catalogItem?.frameConfig || { x: 0, y: 0, width: 32, height: 32 };
  const fallbackTileUrl = typeof catalogItem?.tileSetUrl === 'string' ? catalogItem.tileSetUrl : '';

  const appearance = catalogItem?.appearance || {};
  const renderType = ['none', 'static', 'animated'].includes(appearance.renderType)
    ? appearance.renderType
    : (fallbackTileUrl || catalogItem?.frameConfig ? 'static' : 'none');

  const sourceType = ['tileset', 'spritesheet'].includes(appearance.sourceType)
    ? appearance.sourceType
    : (fallbackTileUrl ? 'tileset' : 'spritesheet');

  return {
    renderType,
    sourceType,
    sheet: String(appearance.sheet || fallbackTileUrl || '').trim(),
    animationName: String(appearance.animationName || '').trim(),
    frameConfig: {
      x: Number.isFinite(Number(appearance?.frameConfig?.x)) ? Number(appearance.frameConfig.x) : Number(fallbackFrame.x) || 0,
      y: Number.isFinite(Number(appearance?.frameConfig?.y)) ? Number(appearance.frameConfig.y) : Number(fallbackFrame.y) || 0,
      width: Math.max(1, Number.isFinite(Number(appearance?.frameConfig?.width)) ? Number(appearance.frameConfig.width) : Number(fallbackFrame.width) || 32),
      height: Math.max(1, Number.isFinite(Number(appearance?.frameConfig?.height)) ? Number(appearance.frameConfig.height) : Number(fallbackFrame.height) || 32),
    },
    anchorX: Number.isFinite(Number(appearance.anchorX)) ? Number(appearance.anchorX) : (Number(catalogItem?.anchorX) || 0),
    anchorY: Number.isFinite(Number(appearance.anchorY)) ? Number(appearance.anchorY) : (Number(catalogItem?.anchorY) || 0),
    previewScale: Math.max(0.1, Number.isFinite(Number(appearance.previewScale)) ? Number(appearance.previewScale) : 1),
  };
}

function ensureTextureCaches(state) {
  if (!state.textureCache) {
    state.textureCache = {
      baseTextureByUrl: new Map(),
      staticTextureByKey: new Map(),
      animationsBySheet: new Map(),
    };
  }
  return state.textureCache;
}

function getStaticTexture(cache, appearance, tileDim, catalogItem, g_ctx) {
  const sheetUrl = appearance.sourceType === 'tileset'
    ? (appearance.sheet || catalogItem?.tileSetUrl || g_ctx?.tilesetpath)
    : appearance.sheet;
  if (!sheetUrl) {
    return null;
  }

  const frame = appearance.frameConfig;
  const cacheKey = `${sheetUrl}|${frame.x},${frame.y},${frame.width},${frame.height}`;
  if (cache.staticTextureByKey.has(cacheKey)) {
    return cache.staticTextureByKey.get(cacheKey);
  }

  let baseTexture = cache.baseTextureByUrl.get(sheetUrl);
  if (!baseTexture) {
    baseTexture = PIXI.BaseTexture.from(sheetUrl, {
      scaleMode: PIXI.SCALE_MODES.NEAREST,
    });
    cache.baseTextureByUrl.set(sheetUrl, baseTexture);
  }

  const texture = new PIXI.Texture(
    baseTexture,
    new PIXI.Rectangle(frame.x, frame.y, frame.width || tileDim, frame.height || tileDim),
  );
  cache.staticTextureByKey.set(cacheKey, texture);
  return texture;
}

function getAnimationFrames(cache, appearance, g_ctx) {
  const sheetName = appearance.sheet;
  const animationName = appearance.animationName;
  if (!sheetName || !animationName) {
    return null;
  }

  let sheetEntry = cache.animationsBySheet.get(sheetName);
  if (!sheetEntry) {
    const registry = typeof g_ctx?.getResourceRegistry === 'function' ? g_ctx.getResourceRegistry() : null;
    const sheetInfo = registry?.spritesheets?.find((item) => item.name === sheetName) || null;
    const loadedSheet = sheetInfo?.sheet || null;
    if (!loadedSheet || !loadedSheet.animations) {
      cache.animationsBySheet.set(sheetName, null);
      return null;
    }
    sheetEntry = loadedSheet.animations;
    cache.animationsBySheet.set(sheetName, sheetEntry);
  }

  if (!sheetEntry || !sheetEntry[animationName]) {
    return null;
  }
  return sheetEntry[animationName];
}

function buildFallbackBlocks(container, catalogItem, tileDim, selected) {
  const occupied = Array.isArray(catalogItem?.occupiedTiles) && catalogItem.occupiedTiles.length > 0
    ? catalogItem.occupiedTiles
    : [{ dx: 0, dy: 0 }];

  const fillColor = selected ? 0x2ecc71 : 0x3498db;
  const borderColor = selected ? 0x27ae60 : 0x1f2d3a;

  for (let i = 0; i < occupied.length; i++) {
    const tile = occupied[i];
    const block = new PIXI.Graphics();
    block.beginFill(fillColor, 0.28);
    block.lineStyle(2, borderColor, 0.95);
    block.drawRect(tile.dx * tileDim, tile.dy * tileDim, tileDim, tileDim);
    block.endFill();
    container.addChild(block);
  }
}

function appendSelectionOutline(container, tileDim, selected) {
  if (!selected) {
    return;
  }
  const bounds = container.getLocalBounds();
  const outline = new PIXI.Graphics();
  outline.lineStyle(2, 0xf1c40f, 1);
  outline.drawRect(
    bounds.x,
    bounds.y,
    Math.max(bounds.width, tileDim),
    Math.max(bounds.height, tileDim),
  );
  outline.zIndex = 10;
  container.addChild(outline);
}

function buildVisual(instance, catalogItem, tileDim, selected, state, g_ctx) {
  const container = new PIXI.Container();
  container.name = 'semantic_instance_' + instance.instanceId;
  container.interactive = true;
  container.eventMode = 'dynamic';
  container.cursor = 'pointer';
  container.x = instance.x;
  container.y = instance.y;

  const cache = ensureTextureCaches(state);
  const appearance = normalizeAppearance(catalogItem);

  let appearanceApplied = false;

  if (appearance.renderType === 'static') {
    const texture = getStaticTexture(cache, appearance, tileDim, catalogItem, g_ctx);
    if (texture) {
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(appearance.anchorX, appearance.anchorY);
      sprite.scale.set(appearance.previewScale, appearance.previewScale);
      container.addChild(sprite);
      appearanceApplied = true;
    }
  } else if (appearance.renderType === 'animated') {
    const frames = getAnimationFrames(cache, appearance, g_ctx);
    if (Array.isArray(frames) && frames.length > 0) {
      const animatedSprite = new PIXI.AnimatedSprite(frames);
      animatedSprite.anchor.set(appearance.anchorX, appearance.anchorY);
      animatedSprite.scale.set(appearance.previewScale, appearance.previewScale);
      animatedSprite.animationSpeed = 0.1;
      animatedSprite.autoUpdate = true;
      animatedSprite.play();
      container.addChild(animatedSprite);
      appearanceApplied = true;
    }
  }

  if (!appearanceApplied) {
    buildFallbackBlocks(container, catalogItem, tileDim, selected);
  }

  const label = new PIXI.Text(catalogItem?.name || instance.catalogKey, {
    fontFamily: 'Courier',
    fontSize: 12,
    fill: selected ? 0x2ecc71 : 0xffffff,
    stroke: 0x000000,
    strokeThickness: 3,
  });
  label.x = 2;
  label.y = -16;
  label.zIndex = 1;
  container.addChild(label);

  appendSelectionOutline(container, tileDim, selected);

  container.__instanceId = instance.instanceId;
  return container;
}

function attachDragHandlers(state, visual, g_ctx, callbacks) {
  visual.on('pointerdown', (event) => {
    if (!state.placementEnabled) {
      return;
    }

    if (event.button === 2 || event.data?.originalEvent?.button === 2) {
      return;
    }

    state.draggingInstanceId = visual.__instanceId;
    const local = event.data.getLocalPosition(visual.parent);
    state.dragOffsetX = local.x - visual.x;
    state.dragOffsetY = local.y - visual.y;

    if (typeof callbacks?.onSelectInstance === 'function') {
      callbacks.onSelectInstance(visual.__instanceId);
    }

    event.stopPropagation();
  });
}

function addContextDelete(visual, callbacks) {
  visual.on('rightdown', (event) => {
    if (event?.data?.originalEvent?.preventDefault) {
      event.data.originalEvent.preventDefault();
    }
    if (typeof callbacks?.onDeleteInstance === 'function') {
      callbacks.onDeleteInstance(visual.__instanceId);
    }
  });
}

function bindStageEvents(stage, state, g_ctx, callbacks, stageKey) {
  if (!stage || state.stageEventsWired[stageKey]) {
    return;
  }

  stage.eventMode = 'static';

  stage.on('pointerdown', (event) => {
    if (!state.placementEnabled) {
      return;
    }

    if (event.button === 2 || event.data?.originalEvent?.button === 2) {
      return;
    }

    let target = event.target;
    while (target) {
      if (typeof target.__instanceId === 'string') {
        return;
      }
      target = target.parent;
    }

    if (!state.selectedCatalogKey) {
      return;
    }

    const tileDim = getTileSize(g_ctx);
    const world = event.data.getLocalPosition(g_ctx.composite.container);
    const x = clampToGrid(world.x, tileDim);
    const y = clampToGrid(world.y, tileDim);

    if (typeof callbacks?.onPlaceInstance === 'function') {
      callbacks.onPlaceInstance({
        instanceId: createInstanceId(),
        catalogKey: state.selectedCatalogKey,
        x,
        y,
        note: '',
      });
    }

    event.stopPropagation();
  });

  stage.on('pointermove', (event) => {
    if (!state.placementEnabled || !state.draggingInstanceId) {
      return;
    }

    const tileDim = getTileSize(g_ctx);
    const world = event.data.getLocalPosition(g_ctx.composite.container);
    const x = clampToGrid(world.x - state.dragOffsetX, tileDim);
    const y = clampToGrid(world.y - state.dragOffsetY, tileDim);

    if (typeof callbacks?.onMoveInstance === 'function') {
      callbacks.onMoveInstance(state.draggingInstanceId, x, y);
    }
  });

  const stopDrag = () => {
    state.draggingInstanceId = null;
  };

  stage.on('pointerup', stopDrag);
  stage.on('pointerupoutside', stopDrag);

  state.stageEventsWired[stageKey] = true;
}

function wireStageEvents(state, g_ctx, callbacks) {
  bindStageEvents(g_ctx?.composite_app?.stage, state, g_ctx, callbacks, 'composite');
  bindStageEvents(g_ctx?.map_app?.stage, state, g_ctx, callbacks, 'map');
}

function wireKeyboardDelete(state, callbacks) {
  if (state.keyboardDeleteWired) {
    return;
  }

  window.addEventListener('keydown', (event) => {
    if (!state.placementEnabled) {
      return;
    }
    if (event.code !== 'Delete') {
      return;
    }
    if (!state.selectedInstanceId) {
      return;
    }

    if (typeof callbacks?.onDeleteInstance === 'function') {
      callbacks.onDeleteInstance(state.selectedInstanceId);
    }
  });

  state.keyboardDeleteWired = true;
}

export function createSemanticPlacer(g_ctx, options = {}) {
  const state = {
    objectInstances: Array.isArray(options.initialObjectInstances)
      ? options.initialObjectInstances.slice()
      : [],
    zones: Array.isArray(options.initialZones) ? options.initialZones.slice() : [],
    catalog: Array.isArray(options.catalog) ? options.catalog.slice() : [],
    selectedCatalogKey: null,
    selectedInstanceId: null,
    placementEnabled: false,
    draggingInstanceId: null,
    dragOffsetX: 0,
    dragOffsetY: 0,
    stageEventsWired: {
      composite: false,
      map: false,
    },
    keyboardDeleteWired: false,
    textureCache: {
      baseTextureByUrl: new Map(),
      staticTextureByKey: new Map(),
      animationsBySheet: new Map(),
    },
  };

  const callbacks = {
    onPlaceInstance(instance) {
      state.objectInstances.push(instance);
      state.selectedInstanceId = instance.instanceId;
      render();
      if (typeof options.onInstancesChanged === 'function') {
        options.onInstancesChanged(state.objectInstances.slice());
      }
    },
    onDeleteInstance(instanceId) {
      const index = findInstanceIndexById(state.objectInstances, instanceId);
      if (index < 0) {
        return;
      }

      state.objectInstances.splice(index, 1);
      if (state.selectedInstanceId === instanceId) {
        state.selectedInstanceId = null;
      }

      state.zones = state.zones.map((zone) => {
        if (!Array.isArray(zone.containedInstanceIds)) {
          return zone;
        }
        return {
          ...zone,
          containedInstanceIds: zone.containedInstanceIds.filter((id) => id !== instanceId),
        };
      });

      render();
      if (typeof options.onInstancesChanged === 'function') {
        options.onInstancesChanged(state.objectInstances.slice());
      }
    },
    onMoveInstance(instanceId, x, y) {
      const index = findInstanceIndexById(state.objectInstances, instanceId);
      if (index < 0) {
        return;
      }
      state.objectInstances[index].x = x;
      state.objectInstances[index].y = y;
      render();
      if (typeof options.onInstancesChanged === 'function') {
        options.onInstancesChanged(state.objectInstances.slice());
      }
    },
    onSelectInstance(instanceId) {
      state.selectedInstanceId = instanceId;
      render();
      if (typeof options.onSelectInstance === 'function') {
        options.onSelectInstance(instanceId);
      }
    },
  };

  function refreshCatalog(nextCatalog) {
    state.catalog = Array.isArray(nextCatalog) ? nextCatalog.slice() : [];
    if (
      state.selectedCatalogKey &&
      !state.catalog.some((item) => item.key === state.selectedCatalogKey)
    ) {
      state.selectedCatalogKey = null;
    }
    render();
  }

  function setPlacementEnabled(enabled) {
    state.placementEnabled = !!enabled;
  }

  function setSelectedCatalogKey(key) {
    state.selectedCatalogKey = key || null;
  }

  function setObjectInstances(instances) {
    state.objectInstances = Array.isArray(instances) ? instances.slice() : [];
    state.selectedInstanceId = null;
    render();
  }

  function setZones(zones) {
    state.zones = Array.isArray(zones) ? zones.slice() : [];
  }

  function getObjectInstances() {
    return state.objectInstances.map((item) => ({
      instanceId: item.instanceId,
      catalogKey: item.catalogKey,
      x: item.x,
      y: item.y,
      note: parseObjectNote(item.note),
    }));
  }

  function getZones() {
    return state.zones.map((zone) => ({ ...zone }));
  }

  function render() {
    const overlay = getOverlayContainer(g_ctx);
    if (!overlay) {
      return;
    }

    overlay.removeChildren();
    const tileDim = getTileSize(g_ctx);

    for (let i = 0; i < state.objectInstances.length; i++) {
      const instance = state.objectInstances[i];
      const catalogItem = state.catalog.find((item) => item.key === instance.catalogKey);
      const selected = instance.instanceId === state.selectedInstanceId;
      const visual = buildVisual(instance, catalogItem, tileDim, selected, state, g_ctx);
      attachDragHandlers(state, visual, g_ctx, callbacks);
      addContextDelete(visual, callbacks);
      overlay.addChild(visual);
    }
  }

  function init() {
    wireStageEvents(state, g_ctx, callbacks);
    wireKeyboardDelete(state, callbacks);
    render();
  }

  return {
    init,
    render,
    refreshCatalog,
    setPlacementEnabled,
    setSelectedCatalogKey,
    setObjectInstances,
    setZones,
    getObjectInstances,
    getZones,
    deleteSelectedInstance() {
      if (!state.selectedInstanceId) {
        return;
      }
      callbacks.onDeleteInstance(state.selectedInstanceId);
    },
    clearSelection() {
      state.selectedInstanceId = null;
      render();
    },
  };
}
