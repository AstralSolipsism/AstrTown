import * as PIXI from 'pixi.js';

const ZONE_OVERLAY_NAME = '__semantic_zone_overlay__';

function createZoneId() {
  return 'zone_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function getTileSize(g_ctx) {
  return g_ctx?.tiledimx || 32;
}

function clampToGrid(value, tileDim) {
  return Math.floor(value / tileDim) * tileDim;
}

function ceilToGrid(value, tileDim) {
  return Math.ceil(value / tileDim) * tileDim;
}

function normalizeBounds(rawBounds, tileDim) {
  const source = rawBounds || {};

  const x = clampToGrid(Number(source.x) || 0, tileDim);
  const y = clampToGrid(Number(source.y) || 0, tileDim);

  const widthRaw = Number(source.width);
  const heightRaw = Number(source.height);

  const width = Math.max(tileDim, ceilToGrid(Number.isFinite(widthRaw) ? widthRaw : tileDim, tileDim));
  const height = Math.max(tileDim, ceilToGrid(Number.isFinite(heightRaw) ? heightRaw : tileDim, tileDim));

  return {
    x,
    y,
    width,
    height,
  };
}

function normalizeActivities(activities) {
  if (!Array.isArray(activities)) {
    return [];
  }
  return activities
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0);
}

function normalizeContainedInstanceIds(instanceIds) {
  if (!Array.isArray(instanceIds)) {
    return [];
  }
  const dedup = new Set();
  for (let i = 0; i < instanceIds.length; i++) {
    const id = String(instanceIds[i] || '').trim();
    if (id.length > 0) {
      dedup.add(id);
    }
  }
  return Array.from(dedup);
}

function normalizeZone(raw, tileDim, editOrder) {
  const source = raw || {};
  const bounds = normalizeBounds(source.bounds, tileDim);
  const priorityNumber = Number(source.priority);

  return {
    zoneId: String(source.zoneId || createZoneId()),
    name: String(source.name || '未命名区域').trim() || '未命名区域',
    description: String(source.description || '').trim(),
    priority: Number.isFinite(priorityNumber) ? priorityNumber : 0,
    bounds,
    suggestedActivities: normalizeActivities(source.suggestedActivities),
    containedInstanceIds: normalizeContainedInstanceIds(source.containedInstanceIds),
    _editOrder: Number.isFinite(source._editOrder) ? source._editOrder : editOrder,
  };
}

function cloneBounds(bounds) {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function copyZoneForOutput(zone) {
  const output = {
    zoneId: zone.zoneId,
    name: zone.name,
    description: zone.description,
    priority: zone.priority,
    bounds: cloneBounds(zone.bounds),
  };

  if (Array.isArray(zone.suggestedActivities) && zone.suggestedActivities.length > 0) {
    output.suggestedActivities = zone.suggestedActivities.slice();
  }

  if (Array.isArray(zone.containedInstanceIds) && zone.containedInstanceIds.length > 0) {
    output.containedInstanceIds = zone.containedInstanceIds.slice();
  }

  return output;
}

function resolveTargetMeta(target) {
  let current = target;
  while (current) {
    if (current.__zoneHandle && current.__zoneHandle.zoneId) {
      return {
        type: 'handle',
        zoneId: current.__zoneHandle.zoneId,
        corner: current.__zoneHandle.corner,
      };
    }
    if (typeof current.__zoneId === 'string') {
      return {
        type: 'zone',
        zoneId: current.__zoneId,
      };
    }
    if (typeof current.__instanceId === 'string') {
      return {
        type: 'instance',
      };
    }
    current = current.parent;
  }

  return null;
}

function buildBoundsFromDrag(startX, startY, endX, endY, tileDim) {
  const left = clampToGrid(Math.min(startX, endX), tileDim);
  const top = clampToGrid(Math.min(startY, endY), tileDim);
  const right = clampToGrid(Math.max(startX, endX), tileDim) + tileDim;
  const bottom = clampToGrid(Math.max(startY, endY), tileDim) + tileDim;

  return {
    x: left,
    y: top,
    width: Math.max(tileDim, right - left),
    height: Math.max(tileDim, bottom - top),
  };
}

function containsPoint(zone, worldX, worldY) {
  const b = zone.bounds;
  return worldX >= b.x && worldX < b.x + b.width && worldY >= b.y && worldY < b.y + b.height;
}

function compareByPriorityThenEditForPrimary(a, b) {
  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }
  return (b._editOrder || 0) - (a._editOrder || 0);
}

function compareByPriorityThenEditForRender(a, b) {
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  return (a._editOrder || 0) - (b._editOrder || 0);
}

function getOverlayContainer(g_ctx) {
  if (!g_ctx?.composite?.container) {
    return null;
  }

  const children = g_ctx.composite.container.children;
  for (let i = 0; i < children.length; i++) {
    if (children[i].name === ZONE_OVERLAY_NAME) {
      return children[i];
    }
  }

  const overlay = new PIXI.Container();
  overlay.name = ZONE_OVERLAY_NAME;
  overlay.zIndex = 110;
  overlay.sortableChildren = true;
  g_ctx.composite.container.addChild(overlay);
  return overlay;
}

function priorityTint(priority) {
  const base = 0x8e44ad;
  const p = Math.max(0, Math.min(20, priority));
  const factor = 1 - p * 0.03;

  const r = ((base >> 16) & 0xff) * factor;
  const g = ((base >> 8) & 0xff) * factor;
  const b = (base & 0xff) * factor;

  return ((Math.max(0, Math.min(255, Math.floor(r))) << 16)
    | (Math.max(0, Math.min(255, Math.floor(g))) << 8)
    | Math.max(0, Math.min(255, Math.floor(b))));
}

function createHandle(corner) {
  const handle = new PIXI.Graphics();
  handle.beginFill(0xffffff, 1);
  handle.lineStyle(1, 0x111111, 1);
  handle.drawRect(-5, -5, 10, 10);
  handle.endFill();
  handle.eventMode = 'static';
  handle.cursor = corner.includes('n') || corner.includes('s') ? 'nwse-resize' : 'nesw-resize';
  return handle;
}

function getHandlePositions(bounds) {
  return {
    nw: { x: bounds.x, y: bounds.y },
    ne: { x: bounds.x + bounds.width, y: bounds.y },
    sw: { x: bounds.x, y: bounds.y + bounds.height },
    se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  };
}

export function createSemanticZoner(g_ctx, options = {}) {
  const state = {
    zones: [],
    selectedZoneId: null,
    drawingEnabled: false,
    stageEventsWired: {
      composite: false,
      map: false,
    },
    keyboardDeleteWired: false,
    editOrderCounter: 0,
    drag: {
      mode: null,
      zoneId: null,
      handle: null,
      startWorldX: 0,
      startWorldY: 0,
      offsetX: 0,
      offsetY: 0,
      baseBounds: null,
      previewBounds: null,
      changed: false,
    },
  };

  function nextEditOrder() {
    state.editOrderCounter += 1;
    return state.editOrderCounter;
  }

  function findZoneIndexById(zoneId) {
    return state.zones.findIndex((zone) => zone.zoneId === zoneId);
  }

  function getZoneById(zoneId) {
    const index = findZoneIndexById(zoneId);
    if (index < 0) {
      return null;
    }
    return state.zones[index];
  }

  function emitZonesChanged() {
    if (typeof options.onZonesChanged === 'function') {
      options.onZonesChanged(getZones());
    }
  }

  function emitSelectZone() {
    if (typeof options.onSelectZone === 'function') {
      options.onSelectZone(state.selectedZoneId, getSelectedZone());
    }
  }

  function markZoneEdited(zoneId) {
    const zone = getZoneById(zoneId);
    if (!zone) {
      return;
    }
    zone._editOrder = nextEditOrder();
  }

  function setZones(zones) {
    const tileDim = getTileSize(g_ctx);
    const source = Array.isArray(zones) ? zones : [];
    const next = [];

    for (let i = 0; i < source.length; i++) {
      const editOrder = Number.isFinite(source[i]?._editOrder)
        ? source[i]._editOrder
        : nextEditOrder();
      state.editOrderCounter = Math.max(state.editOrderCounter, editOrder);
      next.push(normalizeZone(source[i], tileDim, editOrder));
    }

    state.zones = next;

    if (state.selectedZoneId && findZoneIndexById(state.selectedZoneId) < 0) {
      state.selectedZoneId = null;
      emitSelectZone();
    }

    render();
    emitZonesChanged();
  }

  function getZones() {
    return state.zones.map((zone) => copyZoneForOutput(zone));
  }

  function selectZone(zoneId) {
    const nextZoneId = zoneId && findZoneIndexById(zoneId) >= 0 ? zoneId : null;
    if (state.selectedZoneId === nextZoneId) {
      return;
    }
    state.selectedZoneId = nextZoneId;
    render();
    emitSelectZone();
  }

  function getSelectedZone() {
    const zone = getZoneById(state.selectedZoneId);
    if (!zone) {
      return null;
    }
    return copyZoneForOutput(zone);
  }

  function setDrawingEnabled(enabled) {
    state.drawingEnabled = !!enabled;
    render();
  }

  function getDrawingEnabled() {
    return state.drawingEnabled;
  }

  function createZone(zoneDraft = {}, bounds = null) {
    const tileDim = getTileSize(g_ctx);
    const zoneRaw = {
      zoneId: createZoneId(),
      name: zoneDraft.name,
      description: zoneDraft.description,
      priority: zoneDraft.priority,
      suggestedActivities: zoneDraft.suggestedActivities,
      containedInstanceIds: zoneDraft.containedInstanceIds,
      bounds: bounds || { x: 0, y: 0, width: tileDim, height: tileDim },
      _editOrder: nextEditOrder(),
    };

    const zone = normalizeZone(zoneRaw, tileDim, zoneRaw._editOrder);
    state.zones.push(zone);
    state.selectedZoneId = zone.zoneId;
    render();
    emitSelectZone();
    emitZonesChanged();
    return copyZoneForOutput(zone);
  }

  function updateSelectedZoneMeta(payload = {}) {
    if (!state.selectedZoneId) {
      return null;
    }
    const zone = getZoneById(state.selectedZoneId);
    if (!zone) {
      return null;
    }

    const nextPriority = Number(payload.priority);
    zone.name = String(payload.name || zone.name || '未命名区域').trim() || '未命名区域';
    zone.description = String(payload.description || '').trim();
    zone.priority = Number.isFinite(nextPriority) ? nextPriority : 0;
    zone.suggestedActivities = normalizeActivities(payload.suggestedActivities);
    markZoneEdited(zone.zoneId);

    render();
    emitZonesChanged();
    return copyZoneForOutput(zone);
  }

  function deleteZoneById(zoneId) {
    const index = findZoneIndexById(zoneId);
    if (index < 0) {
      return;
    }

    state.zones.splice(index, 1);
    if (state.selectedZoneId === zoneId) {
      state.selectedZoneId = null;
      emitSelectZone();
    }
    render();
    emitZonesChanged();
  }

  function deleteSelectedZone() {
    if (!state.selectedZoneId) {
      return;
    }
    deleteZoneById(state.selectedZoneId);
  }

  function setContainedInstanceIds(zoneToInstanceIdsMap = {}) {
    for (let i = 0; i < state.zones.length; i++) {
      const zone = state.zones[i];
      const nextIds = normalizeContainedInstanceIds(zoneToInstanceIdsMap[zone.zoneId]);
      zone.containedInstanceIds = nextIds;
    }
  }

  function getPrimaryZoneAtWorld(worldX, worldY) {
    const hits = [];
    for (let i = 0; i < state.zones.length; i++) {
      if (containsPoint(state.zones[i], worldX, worldY)) {
        hits.push(state.zones[i]);
      }
    }

    if (hits.length === 0) {
      return null;
    }

    hits.sort(compareByPriorityThenEditForPrimary);
    return copyZoneForOutput(hits[0]);
  }

  function getPrimaryZoneAtCell(cellX, cellY) {
    const tileDim = getTileSize(g_ctx);
    const worldX = cellX * tileDim + tileDim / 2;
    const worldY = cellY * tileDim + tileDim / 2;
    return getPrimaryZoneAtWorld(worldX, worldY);
  }

  function getPrimaryZoneForZoneCenter(zoneId) {
    const zone = getZoneById(zoneId);
    if (!zone) {
      return null;
    }
    const tileDim = getTileSize(g_ctx);
    const centerX = zone.bounds.x + zone.bounds.width / 2;
    const centerY = zone.bounds.y + zone.bounds.height / 2;
    const cellX = Math.floor(centerX / tileDim);
    const cellY = Math.floor(centerY / tileDim);
    return getPrimaryZoneAtCell(cellX, cellY);
  }

  function render() {
    const overlay = getOverlayContainer(g_ctx);
    if (!overlay) {
      return;
    }

    overlay.removeChildren();

    const sortedZones = state.zones.slice().sort(compareByPriorityThenEditForRender);

    for (let i = 0; i < sortedZones.length; i++) {
      const zone = sortedZones[i];
      const selected = zone.zoneId === state.selectedZoneId;
      const bounds = zone.bounds;

      const zoneContainer = new PIXI.Container();
      zoneContainer.name = 'semantic_zone_' + zone.zoneId;
      zoneContainer.zIndex = zone.priority * 100000 + (zone._editOrder || 0) + (selected ? 500000000 : 0);
      zoneContainer.__zoneId = zone.zoneId;

      const body = new PIXI.Graphics();
      const fillColor = priorityTint(zone.priority);
      const fillAlpha = Math.max(0.14, Math.min(0.5, 0.2 + Math.max(0, zone.priority) * 0.02));
      const borderColor = selected ? 0xffd166 : 0x1f2d3a;
      const borderWidth = selected ? 3 : 2;

      body.beginFill(fillColor, fillAlpha);
      body.lineStyle(borderWidth, borderColor, 0.95);
      body.drawRect(bounds.x, bounds.y, bounds.width, bounds.height);
      body.endFill();
      body.eventMode = 'static';
      body.cursor = state.drawingEnabled ? 'move' : 'pointer';
      body.__zoneId = zone.zoneId;
      zoneContainer.addChild(body);

      const label = new PIXI.Text(`${zone.name} (P${zone.priority})`, {
        fontFamily: 'Courier',
        fontSize: 12,
        fill: selected ? 0xfff4ce : 0xffffff,
        stroke: 0x000000,
        strokeThickness: 3,
      });
      label.x = bounds.x + 4;
      label.y = bounds.y + 2;
      label.zIndex = zoneContainer.zIndex + 1;
      label.__zoneId = zone.zoneId;
      zoneContainer.addChild(label);

      if (selected && state.drawingEnabled) {
        const positions = getHandlePositions(bounds);
        const corners = ['nw', 'ne', 'sw', 'se'];
        for (let c = 0; c < corners.length; c++) {
          const corner = corners[c];
          const handle = createHandle(corner);
          handle.x = positions[corner].x;
          handle.y = positions[corner].y;
          handle.__zoneHandle = {
            zoneId: zone.zoneId,
            corner,
          };
          zoneContainer.addChild(handle);
        }
      }

      overlay.addChild(zoneContainer);
    }

    if (state.drag.mode === 'draw' && state.drag.previewBounds) {
      const preview = new PIXI.Graphics();
      preview.beginFill(0x2ecc71, 0.2);
      preview.lineStyle(2, 0x27ae60, 1);
      preview.drawRect(
        state.drag.previewBounds.x,
        state.drag.previewBounds.y,
        state.drag.previewBounds.width,
        state.drag.previewBounds.height,
      );
      preview.endFill();
      preview.zIndex = 999999999;
      overlay.addChild(preview);
    }
  }

  function beginDraw(worldX, worldY) {
    const tileDim = getTileSize(g_ctx);
    state.drag.mode = 'draw';
    state.drag.zoneId = null;
    state.drag.handle = null;
    state.drag.startWorldX = worldX;
    state.drag.startWorldY = worldY;
    state.drag.previewBounds = buildBoundsFromDrag(worldX, worldY, worldX, worldY, tileDim);
    state.drag.changed = false;
    render();
  }

  function beginMove(zoneId, worldX, worldY) {
    const zone = getZoneById(zoneId);
    if (!zone) {
      return;
    }

    state.drag.mode = 'move';
    state.drag.zoneId = zoneId;
    state.drag.handle = null;
    state.drag.offsetX = worldX - zone.bounds.x;
    state.drag.offsetY = worldY - zone.bounds.y;
    state.drag.baseBounds = cloneBounds(zone.bounds);
    state.drag.changed = false;
  }

  function beginResize(zoneId, corner) {
    const zone = getZoneById(zoneId);
    if (!zone) {
      return;
    }

    state.drag.mode = 'resize';
    state.drag.zoneId = zoneId;
    state.drag.handle = corner;
    state.drag.baseBounds = cloneBounds(zone.bounds);
    state.drag.changed = false;
  }

  function updateMove(worldX, worldY) {
    const zone = getZoneById(state.drag.zoneId);
    if (!zone) {
      return;
    }
    const tileDim = getTileSize(g_ctx);
    const nextX = clampToGrid(worldX - state.drag.offsetX, tileDim);
    const nextY = clampToGrid(worldY - state.drag.offsetY, tileDim);

    if (zone.bounds.x !== nextX || zone.bounds.y !== nextY) {
      zone.bounds.x = nextX;
      zone.bounds.y = nextY;
      state.drag.changed = true;
      render();
    }
  }

  function updateResize(worldX, worldY) {
    const zone = getZoneById(state.drag.zoneId);
    if (!zone) {
      return;
    }

    const tileDim = getTileSize(g_ctx);
    const base = state.drag.baseBounds;
    const snappedX = clampToGrid(worldX, tileDim);
    const snappedY = clampToGrid(worldY, tileDim);

    let left = base.x;
    let right = base.x + base.width;
    let top = base.y;
    let bottom = base.y + base.height;

    const corner = state.drag.handle;
    if (corner.includes('w')) {
      left = Math.min(snappedX, right - tileDim);
    }
    if (corner.includes('e')) {
      right = Math.max(snappedX + tileDim, left + tileDim);
    }
    if (corner.includes('n')) {
      top = Math.min(snappedY, bottom - tileDim);
    }
    if (corner.includes('s')) {
      bottom = Math.max(snappedY + tileDim, top + tileDim);
    }

    const nextBounds = {
      x: left,
      y: top,
      width: Math.max(tileDim, right - left),
      height: Math.max(tileDim, bottom - top),
    };

    if (
      zone.bounds.x !== nextBounds.x
      || zone.bounds.y !== nextBounds.y
      || zone.bounds.width !== nextBounds.width
      || zone.bounds.height !== nextBounds.height
    ) {
      zone.bounds = nextBounds;
      state.drag.changed = true;
      render();
    }
  }

  function updateDraw(worldX, worldY) {
    const tileDim = getTileSize(g_ctx);
    state.drag.previewBounds = buildBoundsFromDrag(
      state.drag.startWorldX,
      state.drag.startWorldY,
      worldX,
      worldY,
      tileDim,
    );
    state.drag.changed = true;
    render();
  }

  function resetDragState() {
    state.drag.mode = null;
    state.drag.zoneId = null;
    state.drag.handle = null;
    state.drag.startWorldX = 0;
    state.drag.startWorldY = 0;
    state.drag.offsetX = 0;
    state.drag.offsetY = 0;
    state.drag.baseBounds = null;
    state.drag.previewBounds = null;
    state.drag.changed = false;
  }

  function bindStageEvents(stage, stageKey) {
    if (!stage || state.stageEventsWired[stageKey]) {
      return;
    }

    stage.eventMode = 'static';

    stage.on('pointerdown', (event) => {
      if (!state.drawingEnabled) {
        return;
      }

      if (event.button === 2 || event.data?.originalEvent?.button === 2) {
        return;
      }

      const world = event.data.getLocalPosition(g_ctx.composite.container);
      const targetMeta = resolveTargetMeta(event.target);

      if (targetMeta?.type === 'handle') {
        selectZone(targetMeta.zoneId);
        beginResize(targetMeta.zoneId, targetMeta.corner);
      } else if (targetMeta?.type === 'zone') {
        selectZone(targetMeta.zoneId);
        beginMove(targetMeta.zoneId, world.x, world.y);
      } else if (targetMeta?.type === 'instance') {
        return;
      } else {
        selectZone(null);
        beginDraw(world.x, world.y);
      }

      event.stopPropagation();
    });

    stage.on('pointermove', (event) => {
      if (!state.drawingEnabled || !state.drag.mode) {
        return;
      }

      const world = event.data.getLocalPosition(g_ctx.composite.container);

      if (state.drag.mode === 'move') {
        updateMove(world.x, world.y);
      } else if (state.drag.mode === 'resize') {
        updateResize(world.x, world.y);
      } else if (state.drag.mode === 'draw') {
        updateDraw(world.x, world.y);
      }
    });

    const endDrag = (event) => {
      if (!state.drag.mode) {
        return;
      }

      if (state.drag.mode === 'draw' && state.drag.previewBounds) {
        const draft = typeof options.getDraftZoneData === 'function'
          ? options.getDraftZoneData()
          : {};
        createZone(draft, state.drag.previewBounds);
      } else if ((state.drag.mode === 'move' || state.drag.mode === 'resize') && state.drag.zoneId) {
        if (state.drag.changed) {
          markZoneEdited(state.drag.zoneId);
          emitZonesChanged();
        }
      }

      resetDragState();
      render();

      if (event?.stopPropagation) {
        event.stopPropagation();
      }
    };

    stage.on('pointerup', endDrag);
    stage.on('pointerupoutside', endDrag);

    state.stageEventsWired[stageKey] = true;
  }

  function wireStageEvents() {
    bindStageEvents(g_ctx?.composite_app?.stage, 'composite');
    bindStageEvents(g_ctx?.map_app?.stage, 'map');
  }

  function wireKeyboardDelete() {
    if (state.keyboardDeleteWired) {
      return;
    }

    window.addEventListener('keydown', (event) => {
      if (!state.drawingEnabled) {
        return;
      }
      if (event.code !== 'Delete') {
        return;
      }
      if (!state.selectedZoneId) {
        return;
      }
      deleteSelectedZone();
    });

    state.keyboardDeleteWired = true;
  }

  function init() {
    if (Array.isArray(options.initialZones) && options.initialZones.length > 0) {
      setZones(options.initialZones);
    }

    wireStageEvents();
    wireKeyboardDelete();
    render();
  }

  return {
    init,
    render,
    setZones,
    getZones,
    selectZone,
    getSelectedZone,
    createZone,
    updateSelectedZoneMeta,
    deleteSelectedZone,
    deleteZoneById,
    setDrawingEnabled,
    getDrawingEnabled,
    setContainedInstanceIds,
    getPrimaryZoneAtWorld,
    getPrimaryZoneAtCell,
    getPrimaryZoneForZoneCenter,
  };
}

