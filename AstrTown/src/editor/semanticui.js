import * as PIXI from 'pixi.js';
import { createSemanticPlacer } from './semanticplacer.js';
import { createSemanticZoner } from './semanticzoner.js';
import { mapObjectCatalog as seedCatalog } from '../../data/mapObjectCatalog.js';

const DEFAULT_APPEARANCE = {
  renderType: 'none',
  sourceType: 'tileset',
  sheet: '',
  animationName: '',
  frameConfig: {
    x: 0,
    y: 0,
    width: 32,
    height: 32,
  },
  tileSetUrl: '',
  anchorX: 0,
  anchorY: 0,
  previewScale: 1,
};

const DEFAULT_FORM = {
  key: '',
  name: '',
  category: 'default',
  description: '',
  interactionHint: '',
  occupiedTiles: '0,0',
  blocksMovement: true,
  appearanceRenderType: DEFAULT_APPEARANCE.renderType,
  appearanceSourceType: DEFAULT_APPEARANCE.sourceType,
  appearanceSheet: DEFAULT_APPEARANCE.sheet,
  appearanceAnimationName: DEFAULT_APPEARANCE.animationName,
  appearanceFrameX: String(DEFAULT_APPEARANCE.frameConfig.x),
  appearanceFrameY: String(DEFAULT_APPEARANCE.frameConfig.y),
  appearanceFrameWidth: String(DEFAULT_APPEARANCE.frameConfig.width),
  appearanceFrameHeight: String(DEFAULT_APPEARANCE.frameConfig.height),
  appearanceAnchorX: String(DEFAULT_APPEARANCE.anchorX),
  appearanceAnchorY: String(DEFAULT_APPEARANCE.anchorY),
  appearancePreviewScale: String(DEFAULT_APPEARANCE.previewScale),
};

const DEFAULT_ZONE_FORM = {
  name: '',
  description: '',
  priority: '0',
  activities: '',
};

function parseFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeFrameConfig(frameConfig, fallback = DEFAULT_APPEARANCE.frameConfig) {
  const source = frameConfig || {};
  return {
    x: parseFiniteNumber(source.x, fallback.x),
    y: parseFiniteNumber(source.y, fallback.y),
    width: Math.max(1, parseFiniteNumber(source.width, fallback.width)),
    height: Math.max(1, parseFiniteNumber(source.height, fallback.height)),
  };
}

function normalizeAppearance(item = {}) {
  const renderType = ['none', 'static', 'animated'].includes(item.renderType)
    ? item.renderType
    : DEFAULT_APPEARANCE.renderType;
  const sourceType = ['tileset', 'spritesheet'].includes(item.sourceType)
    ? item.sourceType
    : DEFAULT_APPEARANCE.sourceType;

  return {
    renderType,
    sourceType,
    sheet: String(item.sheet || '').trim(),
    animationName: String(item.animationName || '').trim(),
    frameConfig: normalizeFrameConfig(item.frameConfig),
    tileSetUrl: String(item.tileSetUrl || '').trim(),
    anchorX: parseFiniteNumber(item.anchorX, DEFAULT_APPEARANCE.anchorX),
    anchorY: parseFiniteNumber(item.anchorY, DEFAULT_APPEARANCE.anchorY),
    previewScale: Math.max(0.1, parseFiniteNumber(item.previewScale, DEFAULT_APPEARANCE.previewScale)),
  };
}

function buildAppearanceFromLegacy(item = {}) {
  const hasLegacyFrame = !!item.frameConfig;
  const hasLegacyTile = typeof item.tileSetUrl === 'string' && item.tileSetUrl.trim().length > 0;
  if (!hasLegacyFrame && !hasLegacyTile) {
    return normalizeAppearance(DEFAULT_APPEARANCE);
  }

  return normalizeAppearance({
    renderType: 'static',
    sourceType: hasLegacyTile ? 'tileset' : 'spritesheet',
    sheet: hasLegacyTile ? item.tileSetUrl : '',
    tileSetUrl: hasLegacyTile ? item.tileSetUrl : '',
    frameConfig: item.frameConfig || DEFAULT_APPEARANCE.frameConfig,
    anchorX: item.anchorX,
    anchorY: item.anchorY,
    previewScale: DEFAULT_APPEARANCE.previewScale,
  });
}

function deriveAppearance(item = {}) {
  if (item.appearance) {
    return normalizeAppearance(item.appearance);
  }
  return buildAppearanceFromLegacy(item);
}

function cloneCatalogItem(item) {
  const appearance = deriveAppearance(item);
  return {
    key: item.key,
    name: item.name,
    category: item.category,
    description: item.description,
    interactionHint: item.interactionHint,
    appearance,
    tileSetUrl: appearance.tileSetUrl || item.tileSetUrl,
    frameConfig: appearance.frameConfig,
    anchorX: appearance.anchorX,
    anchorY: appearance.anchorY,
    occupiedTiles: Array.isArray(item.occupiedTiles) ? item.occupiedTiles.map((v) => ({ ...v })) : [],
    blocksMovement: !!item.blocksMovement,
    enabled: item.enabled !== false,
    version: typeof item.version === 'number' ? item.version : 1,
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    updatedAt: Date.now(),
  };
}

function parseOccupiedTiles(text) {
  if (typeof text !== 'string') {
    return [{ dx: 0, dy: 0 }];
  }

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(',').map((s) => s.trim());
    if (parts.length !== 2) {
      continue;
    }

    const dx = Number(parts[0]);
    const dy = Number(parts[1]);
    if (Number.isFinite(dx) && Number.isFinite(dy)) {
      parsed.push({ dx, dy });
    }
  }

  if (parsed.length === 0) {
    return [{ dx: 0, dy: 0 }];
  }

  return parsed;
}

function occupiedTilesToText(occupiedTiles) {
  if (!Array.isArray(occupiedTiles) || occupiedTiles.length === 0) {
    return '0,0';
  }
  return occupiedTiles.map((item) => `${item.dx},${item.dy}`).join('\n');
}

function parseSuggestedActivities(text) {
  if (typeof text !== 'string') {
    return [];
  }

  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function suggestedActivitiesToText(activities) {
  if (!Array.isArray(activities) || activities.length === 0) {
    return '';
  }
  return activities.join('\n');
}

function normalizeZoneFromModule(rawZone) {
  const zone = rawZone || {};
  const bounds = zone.bounds || {};
  const priority = Number(zone.priority);
  const editedAt = Number(zone.editedAt);

  return {
    zoneId: zone.zoneId,
    name: String(zone.name || '未命名区域'),
    description: String(zone.description || ''),
    priority: Number.isFinite(priority) ? priority : 0,
    editedAt: Number.isFinite(editedAt) ? editedAt : Date.now(),
    bounds: {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Math.max(1, Number(bounds.width) || 1),
      height: Math.max(1, Number(bounds.height) || 1),
    },
    suggestedActivities: Array.isArray(zone.suggestedActivities)
      ? zone.suggestedActivities.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
      : [],
    containedInstanceIds: Array.isArray(zone.containedInstanceIds)
      ? zone.containedInstanceIds.map((item) => String(item || '').trim()).filter((item) => item.length > 0)
      : [],
  };
}

function pointInBounds(x, y, bounds) {
  return x >= bounds.x
    && x < bounds.x + bounds.width
    && y >= bounds.y
    && y < bounds.y + bounds.height;
}

function loadCatalogFromDataFile() {
  if (Array.isArray(seedCatalog) && seedCatalog.length > 0) {
    return seedCatalog.map((item) => cloneCatalogItem(item));
  }
  if (globalThis.mapObjectCatalog && Array.isArray(globalThis.mapObjectCatalog)) {
    return globalThis.mapObjectCatalog.map((item) => cloneCatalogItem(item));
  }
  return [];
}

function writeCatalogBack(catalogItems) {
  const nextItems = catalogItems.map((item) => cloneCatalogItem(item));
  globalThis.mapObjectCatalog = nextItems;

  if (Array.isArray(seedCatalog)) {
    seedCatalog.splice(0, seedCatalog.length, ...nextItems.map((item) => cloneCatalogItem(item)));
  }
}

function normalizeCatalogPayload(raw, oldItem = null) {
  const now = Date.now();

  const appearance = normalizeAppearance({
    renderType: raw.appearanceRenderType,
    sourceType: raw.appearanceSourceType,
    sheet: raw.appearanceSheet,
    animationName: raw.appearanceAnimationName,
    frameConfig: {
      x: raw.appearanceFrameX,
      y: raw.appearanceFrameY,
      width: raw.appearanceFrameWidth,
      height: raw.appearanceFrameHeight,
    },
    tileSetUrl: raw.appearanceSourceType === 'tileset' ? raw.appearanceSheet : '',
    anchorX: raw.appearanceAnchorX,
    anchorY: raw.appearanceAnchorY,
    previewScale: raw.appearancePreviewScale,
  });

  return {
    key: raw.key.trim(),
    name: raw.name.trim(),
    category: raw.category.trim() || 'default',
    description: raw.description.trim(),
    interactionHint: raw.interactionHint.trim() || undefined,
    appearance,
    tileSetUrl: appearance.tileSetUrl,
    frameConfig: appearance.frameConfig,
    anchorX: appearance.anchorX,
    anchorY: appearance.anchorY,
    occupiedTiles: parseOccupiedTiles(raw.occupiedTiles),
    blocksMovement: !!raw.blocksMovement,
    enabled: oldItem?.enabled !== false,
    version: typeof oldItem?.version === 'number' ? oldItem.version + 1 : 1,
    createdAt: typeof oldItem?.createdAt === 'number' ? oldItem.createdAt : now,
    updatedAt: now,
  };
}

function findByKey(catalog, key) {
  return catalog.find((item) => item.key === key) || null;
}

export async function initSemanticUI(g_ctx, options = {}) {
  const form = document.getElementById('semantic-object-form');
  const listEl = document.getElementById('semantic-object-list');
  const panelBody = document.getElementById('semantic-panel-body');
  const togglePanelBtn = document.getElementById('semantic-toggle-panel');
  const normalBtn = document.getElementById('semantic-normal-toggle');
  const placementBtn = document.getElementById('semantic-placement-toggle');
  const zoneToggleBtn = document.getElementById('semantic-zone-toggle');
  const placementStatus = document.getElementById('semantic-placement-status');
  const newBtn = document.getElementById('semantic-new-object');
  const deleteBtn = document.getElementById('semantic-delete-object');
  const resetBtn = document.getElementById('semantic-reset-form');

  const zoneForm = document.getElementById('semantic-zone-form');
  const zoneListEl = document.getElementById('semantic-zone-list');
  const zoneNewBtn = document.getElementById('semantic-new-zone');
  const zoneDeleteBtn = document.getElementById('semantic-delete-zone');
  const zoneResetBtn = document.getElementById('semantic-reset-zone-form');
  const zonePrimaryEl = document.getElementById('semantic-zone-primary');

  const fields = {
    key: document.getElementById('semantic-key'),
    name: document.getElementById('semantic-name'),
    category: document.getElementById('semantic-category'),
    description: document.getElementById('semantic-description'),
    interactionHint: document.getElementById('semantic-interaction-hint'),
    occupiedTiles: document.getElementById('semantic-occupied-tiles'),
    blocksMovement: document.getElementById('semantic-blocks-movement'),
    appearanceRenderType: document.getElementById('semantic-appearance-render-type'),
    appearanceSourceType: document.getElementById('semantic-appearance-source-type'),
    appearanceSheet: document.getElementById('semantic-appearance-sheet'),
    appearanceAnimationName: document.getElementById('semantic-appearance-animation'),
    appearanceFrameX: document.getElementById('semantic-appearance-frame-x'),
    appearanceFrameY: document.getElementById('semantic-appearance-frame-y'),
    appearanceFrameWidth: document.getElementById('semantic-appearance-frame-width'),
    appearanceFrameHeight: document.getElementById('semantic-appearance-frame-height'),
    appearanceAnchorX: document.getElementById('semantic-appearance-anchor-x'),
    appearanceAnchorY: document.getElementById('semantic-appearance-anchor-y'),
    appearancePreviewScale: document.getElementById('semantic-appearance-preview-scale'),
    appearancePreviewCanvas: document.getElementById('semantic-appearance-canvas'),
    appearanceFrameWrap: document.getElementById('semantic-appearance-frame-wrap'),
    appearanceAnimationWrap: document.getElementById('semantic-appearance-animation-wrap'),
  };

  const zoneFields = {
    name: document.getElementById('semantic-zone-name'),
    description: document.getElementById('semantic-zone-description'),
    priority: document.getElementById('semantic-zone-priority'),
    activities: document.getElementById('semantic-zone-activities'),
  };

  const state = {
    catalog: loadCatalogFromDataFile(),
    selectedCatalogKey: null,
    mode: 'terrain',
    panelCollapsed: false,
    worldSemantic: {
      objectInstances: [],
      zones: [],
    },
  };

  if (Array.isArray(options.initialCatalog) && options.initialCatalog.length > 0) {
    state.catalog = options.initialCatalog.map((item) => cloneCatalogItem(item));
  }

  const resourceStatusEl = document.getElementById('semantic-resource-status');
  const resourceListEl = document.getElementById('semantic-resource-list');

  function getResourceRegistrySnapshot() {
    if (typeof g_ctx.getResourceRegistry === 'function') {
      return g_ctx.getResourceRegistry();
    }
    return {
      tilesets: [{ key: g_ctx.tilesetpath || '', label: g_ctx.tilesetpath || '' }].filter((item) => item.key),
      spritesheets: [],
    };
  }

  const placer = createSemanticPlacer(g_ctx, {
    catalog: state.catalog,
    initialObjectInstances: state.worldSemantic.objectInstances,
    initialZones: state.worldSemantic.zones,
    onInstancesChanged(instances) {
      state.worldSemantic.objectInstances = instances.slice();
      syncZoneContainedInstanceIds(instances);
      refreshPrimaryZoneText();
    },
  });

  const zoner = createSemanticZoner(g_ctx, {
    initialZones: state.worldSemantic.zones,
    getDraftZoneData() {
      return readZoneForm();
    },
    onZonesChanged(zones) {
      state.worldSemantic.zones = zones.slice();
      syncZoneContainedInstanceIds(state.worldSemantic.objectInstances);
      renderZoneList();
      refreshPrimaryZoneText();
    },
    onSelectZone(zoneId, zone) {
      if (zoneId && zone) {
        fillZoneFormFromZone(zone);
      }
      renderZoneList();
      refreshPrimaryZoneText();
    },
  });

  function syncModeButtonState(button, active) {
    if (!button) {
      return;
    }
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function semanticModeToEditorMode(mode) {
    if (mode === 'object') {
      return 'object';
    }
    if (mode === 'zone') {
      return 'zone';
    }
    return 'terrain';
  }

  function semanticModeToSidebarPanel(mode) {
    if (mode === 'object') {
      return 'sem-objects';
    }
    if (mode === 'zone') {
      return 'sem-zones';
    }
    return 'terrain';
  }

  function editorModeToSemanticMode(mode) {
    if (mode === 'object') {
      return 'object';
    }
    if (mode === 'zone') {
      return 'zone';
    }
    return 'terrain';
  }

  function syncTopToolbarMode(editorMode) {
    const modeButtons = document.querySelectorAll('.mode-btn');
    modeButtons.forEach((button) => {
      const active = button.dataset.mode === editorMode;
      button.classList.toggle('active', active);
      button.classList.toggle('is-active', active);
    });
  }

  function syncStatusMode(editorMode) {
    const statusModeEl = document.getElementById('status-mode');
    if (!statusModeEl) {
      return;
    }

    const labels = {
      terrain: '地形绘制',
      object: '语义物体',
      zone: '语义区域',
    };
    statusModeEl.textContent = `模式：${labels[editorMode] || editorMode}`;
  }

  function setMode(mode) {
    state.mode = mode;
    const terrainMode = mode === 'terrain';
    const objectMode = mode === 'object';
    const zoneMode = mode === 'zone';

    const editorMode = semanticModeToEditorMode(mode);
    g_ctx.editorMode = editorMode;
    g_ctx.semanticMode = objectMode || zoneMode;

    placer.setPlacementEnabled(objectMode);
    zoner.setDrawingEnabled(zoneMode);

    syncModeButtonState(normalBtn, terrainMode);
    syncModeButtonState(placementBtn, objectMode);
    syncModeButtonState(zoneToggleBtn, zoneMode);
    syncTopToolbarMode(editorMode);
    syncStatusMode(editorMode);

    const nextSidebarPanel = semanticModeToSidebarPanel(mode);
    if (
      typeof options.onSwitchSidebarTab === 'function'
      && g_ctx.activeSidebarPanel !== nextSidebarPanel
    ) {
      options.onSwitchSidebarTab(nextSidebarPanel);
    }

    if (placementStatus) {
      if (objectMode) {
        placementStatus.textContent = '当前：物体放置模式';
      } else if (zoneMode) {
        placementStatus.textContent = '当前：区域绘制模式';
      } else {
        placementStatus.textContent = '当前：普通绘制模式';
      }
    }
  }

  function setEditorMode(mode) {
    setMode(editorModeToSemanticMode(mode));
  }

  function syncZoneContainedInstanceIds(instances) {
    const currentZones = zoner.getZones();
    const mapByZone = {};

    for (let i = 0; i < currentZones.length; i++) {
      mapByZone[currentZones[i].zoneId] = [];
    }

    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i];
      for (let z = 0; z < currentZones.length; z++) {
        const zone = currentZones[z];
        if (pointInBounds(instance.x, instance.y, zone.bounds)) {
          mapByZone[zone.zoneId].push(instance.instanceId);
        }
      }
    }

    zoner.setContainedInstanceIds(mapByZone);
    state.worldSemantic.zones = zoner.getZones();
    placer.setZones(state.worldSemantic.zones);
  }

  function fillZoneForm(formData) {
    const activities = typeof formData.activities === 'string'
      ? formData.activities
      : suggestedActivitiesToText(formData.suggestedActivities);

    zoneFields.name.value = formData.name || '';
    zoneFields.description.value = formData.description || '';
    zoneFields.priority.value = String(Number.isFinite(Number(formData.priority)) ? Number(formData.priority) : 0);
    zoneFields.activities.value = activities || '';
  }

  function resetZoneForm() {
    fillZoneForm(DEFAULT_ZONE_FORM);
  }

  function readZoneForm() {
    return {
      name: zoneFields.name.value,
      description: zoneFields.description.value,
      priority: zoneFields.priority.value,
      suggestedActivities: parseSuggestedActivities(zoneFields.activities.value),
    };
  }

  function fillZoneFormFromZone(zone) {
    if (!zone) {
      resetZoneForm();
      return;
    }

    fillZoneForm({
      name: zone.name || '',
      description: zone.description || '',
      priority: Number.isFinite(Number(zone.priority)) ? String(zone.priority) : '0',
      activities: suggestedActivitiesToText(zone.suggestedActivities),
    });
  }

  function renderZoneList() {
    zoneListEl.innerHTML = '';
    const zones = zoner.getZones();
    const selected = zoner.getSelectedZone();
    const selectedZoneId = selected?.zoneId || null;

    if (zones.length === 0) {
      const li = document.createElement('li');
      li.className = 'semantic-empty-card';

      const title = document.createElement('strong');
      title.textContent = '暂无区域';
      const hint = document.createElement('span');
      hint.textContent = '切换到“区域绘制”后，在地图上拖拽即可创建区域。';

      li.appendChild(title);
      li.appendChild(hint);
      zoneListEl.appendChild(li);
      return;
    }

    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      const b = zone.bounds;
      const li = document.createElement('li');
      li.className = 'semantic-list-item';
      if (selectedZoneId === zone.zoneId) {
        li.classList.add('is-selected');
      }
      li.textContent = `${zone.name} | P${zone.priority} | [${b.x},${b.y},${b.width},${b.height}]`;
      li.dataset.zoneId = zone.zoneId;
      li.addEventListener('click', () => {
        setMode('zone');
        zoner.selectZone(zone.zoneId);
        fillZoneFormFromZone(zone);
      });
      zoneListEl.appendChild(li);
    }
  }

  function refreshPrimaryZoneText() {
    const statusZoneEl = document.getElementById('status-zone');
    const selected = zoner.getSelectedZone();
    if (!selected) {
      if (zonePrimaryEl) {
        zonePrimaryEl.textContent = '该格子主区域：无';
      }
      if (statusZoneEl) {
        statusZoneEl.textContent = '主区域：-';
      }
      return;
    }

    const primary = zoner.getPrimaryZoneForZoneCenter(selected.zoneId);
    if (!primary) {
      if (zonePrimaryEl) {
        zonePrimaryEl.textContent = '该格子主区域：无';
      }
      if (statusZoneEl) {
        statusZoneEl.textContent = '主区域：-';
      }
      return;
    }

    if (zonePrimaryEl) {
      zonePrimaryEl.textContent = `该格子主区域：${primary.name} (P${primary.priority})`;
    }
    if (statusZoneEl) {
      statusZoneEl.textContent = `主区域：${primary.name} (P${primary.priority})`;
    }
  }

  function syncCatalogToGlobal() {
    writeCatalogBack(state.catalog);
  }

  function appearanceLabel(item) {
    const appearance = deriveAppearance(item);
    if (appearance.renderType === 'animated') {
      return '动画';
    }
    if (appearance.renderType === 'static') {
      return '静态';
    }
    return '未配置';
  }

  function populateSelect(selectEl, options, selectedValue = '') {
    if (!selectEl) {
      return;
    }
    selectEl.innerHTML = '';
    if (!Array.isArray(options) || options.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '暂无可选项';
      selectEl.appendChild(option);
      selectEl.value = '';
      return;
    }

    options.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      selectEl.appendChild(option);
    });

    if (selectedValue && options.some((item) => item.value === selectedValue)) {
      selectEl.value = selectedValue;
    } else {
      selectEl.value = options[0].value;
    }
  }

  function renderResourceStatus() {
    const registry = getResourceRegistrySnapshot();
    if (!resourceStatusEl || !resourceListEl) {
      return;
    }

    const spriteCount = Array.isArray(registry.spritesheets) ? registry.spritesheets.length : 0;
    const tileCount = Array.isArray(registry.tilesets) ? registry.tilesets.length : 0;
    resourceStatusEl.textContent = `已加载 tileset ${tileCount} 个，spritesheet ${spriteCount} 个`;

    resourceListEl.innerHTML = '';
    if (spriteCount === 0) {
      const li = document.createElement('li');
      li.className = 'semantic-empty-card';
      li.textContent = '暂无已加载 Spritesheet';
      resourceListEl.appendChild(li);
      return;
    }

    registry.spritesheets.forEach((sheet) => {
      const li = document.createElement('li');
      li.className = 'semantic-list-item';
      const animations = Array.isArray(sheet.animations) ? sheet.animations.join(', ') : '';
      li.textContent = `${sheet.name} (${animations || '无动画'})`;
      resourceListEl.appendChild(li);
    });
  }

  function updateAppearanceOptions() {
    appearancePreviewState.textureCache.animationFramesByKey.clear();

    const registry = getResourceRegistrySnapshot();
    const sourceType = fields.appearanceSourceType?.value || 'tileset';

    const tileOptions = (registry.tilesets || [])
      .filter((item) => item && item.key)
      .map((item) => ({ value: item.key, label: item.label || item.key }));

    const spriteOptions = (registry.spritesheets || [])
      .filter((item) => item && item.name)
      .map((item) => ({ value: item.name, label: item.name }));

    const currentSheet = fields.appearanceSheet?.value || '';
    if (sourceType === 'spritesheet') {
      populateSelect(fields.appearanceSheet, spriteOptions, currentSheet);
    } else {
      populateSelect(fields.appearanceSheet, tileOptions, currentSheet);
    }

    const selectedSheetName = fields.appearanceSheet?.value || '';
    const selectedSheet = (registry.spritesheets || []).find((item) => item.name === selectedSheetName);
    const animationOptions = (selectedSheet?.animations || []).map((name) => ({ value: name, label: name }));
    populateSelect(fields.appearanceAnimationName, animationOptions, fields.appearanceAnimationName?.value || '');

    renderResourceStatus();
  }

  function syncAppearanceFieldVisibility() {
    const renderType = fields.appearanceRenderType?.value || 'none';
    const sourceType = fields.appearanceSourceType?.value || 'tileset';

    if (fields.appearanceFrameWrap) {
      fields.appearanceFrameWrap.style.display = renderType === 'static' ? '' : 'none';
    }
    if (fields.appearanceAnimationWrap) {
      fields.appearanceAnimationWrap.style.display = renderType === 'animated' ? '' : 'none';
    }
    if (fields.appearanceSourceType?.parentElement) {
      fields.appearanceSourceType.parentElement.style.display = renderType === 'none' ? 'none' : '';
    }
    if (fields.appearanceSheet?.parentElement) {
      fields.appearanceSheet.parentElement.style.display = renderType === 'none' ? 'none' : '';
    }

    if (renderType === 'animated') {
      fields.appearanceSourceType.value = 'spritesheet';
    }
    if (renderType === 'static' && sourceType !== 'tileset' && sourceType !== 'spritesheet') {
      fields.appearanceSourceType.value = 'tileset';
    }

    updateAppearanceOptions();
    renderAppearancePreview();
  }

  const appearancePreviewState = {
    app: null,
    initialized: false,
    root: null,
    currentDisplayObject: null,
    textureCache: {
      baseTextureByUrl: new Map(),
      staticTextureByKey: new Map(),
      animationFramesByKey: new Map(),
    },
  };

  function ensurePreviewApp() {
    if (appearancePreviewState.initialized) {
      return appearancePreviewState.app;
    }

    const canvas = fields.appearancePreviewCanvas;
    if (!canvas) {
      return null;
    }

    const app = new PIXI.Application({
      view: canvas,
      width: canvas.width,
      height: canvas.height,
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: false,
    });

    const root = new PIXI.Container();
    root.sortableChildren = true;
    app.stage.addChild(root);

    appearancePreviewState.app = app;
    appearancePreviewState.root = root;
    appearancePreviewState.initialized = true;
    return app;
  }

  function clearPreviewDisplayObject() {
    const root = appearancePreviewState.root;
    const current = appearancePreviewState.currentDisplayObject;
    if (!root || !current) {
      appearancePreviewState.currentDisplayObject = null;
      return;
    }

    if (current instanceof PIXI.AnimatedSprite) {
      current.stop();
    }

    root.removeChild(current);
    current.destroy({
      children: true,
      texture: false,
      textureSource: false,
    });
    appearancePreviewState.currentDisplayObject = null;
  }

  function clearPreviewStage() {
    clearPreviewDisplayObject();
    const root = appearancePreviewState.root;
    if (!root) {
      return;
    }
    root.removeChildren();
  }

  function createPreviewEmptyState(message) {
    const app = appearancePreviewState.app;
    const root = appearancePreviewState.root;
    if (!app || !root) {
      return;
    }

    const text = new PIXI.Text(message, {
      fontFamily: 'Consolas, monospace',
      fontSize: 12,
      fill: 0x94a3b8,
      align: 'center',
      wordWrap: true,
      wordWrapWidth: Math.max(80, app.view.width - 12),
    });
    text.anchor.set(0.5, 0.5);
    text.x = app.view.width / 2;
    text.y = app.view.height / 2;
    root.addChild(text);
    appearancePreviewState.currentDisplayObject = text;
  }

  function resolvePreviewBaseTexture(sourceType, sheet) {
    const normalizedSheet = String(sheet || '').trim();
    if (!normalizedSheet) {
      return null;
    }

    const cache = appearancePreviewState.textureCache;

    if (sourceType === 'tileset') {
      let baseTexture = cache.baseTextureByUrl.get(normalizedSheet);
      if (!baseTexture) {
        baseTexture = PIXI.BaseTexture.from(normalizedSheet, {
          scaleMode: PIXI.SCALE_MODES.NEAREST,
        });
        cache.baseTextureByUrl.set(normalizedSheet, baseTexture);
      }
      return {
        cacheKeyPrefix: normalizedSheet,
        baseTexture,
      };
    }

    const registry = getResourceRegistrySnapshot();
    const sheetInfo = (registry.spritesheets || []).find((item) => item.name === normalizedSheet) || null;
    const loadedSheet = sheetInfo?.sheet || null;
    if (!loadedSheet) {
      return null;
    }

    let sampleTexture = null;
    if (loadedSheet.textures && typeof loadedSheet.textures === 'object') {
      const names = Object.keys(loadedSheet.textures);
      if (names.length > 0) {
        sampleTexture = loadedSheet.textures[names[0]];
      }
    }

    if (!sampleTexture && loadedSheet.animations && typeof loadedSheet.animations === 'object') {
      const animationNames = Object.keys(loadedSheet.animations);
      for (let i = 0; i < animationNames.length; i++) {
        const frames = loadedSheet.animations[animationNames[i]];
        if (Array.isArray(frames) && frames.length > 0) {
          sampleTexture = frames[0];
          break;
        }
      }
    }

    const baseTexture = sampleTexture?.baseTexture || null;
    if (!baseTexture) {
      return null;
    }

    return {
      cacheKeyPrefix: `spritesheet:${normalizedSheet}`,
      baseTexture,
    };
  }

  function getPreviewStaticTexture(sourceType, sheet, frameConfig) {
    const frame = normalizeFrameConfig(frameConfig);
    const resolved = resolvePreviewBaseTexture(sourceType, sheet);
    if (!resolved) {
      return null;
    }

    const cache = appearancePreviewState.textureCache;
    const cacheKey = `${resolved.cacheKeyPrefix}|${frame.x},${frame.y},${frame.width},${frame.height}`;
    if (cache.staticTextureByKey.has(cacheKey)) {
      return cache.staticTextureByKey.get(cacheKey);
    }

    if (cache.staticTextureByKey.size >= 128) {
      cache.staticTextureByKey.forEach((oldTexture) => {
        oldTexture.destroy(false);
      });
      cache.staticTextureByKey.clear();
    }

    const texture = new PIXI.Texture(
      resolved.baseTexture,
      new PIXI.Rectangle(frame.x, frame.y, frame.width, frame.height),
    );
    cache.staticTextureByKey.set(cacheKey, texture);
    return texture;
  }

  function getPreviewAnimationFrames(sheetName, animationName) {
    if (!sheetName || !animationName) {
      return null;
    }

    const cacheKey = `${sheetName}::${animationName}`;
    const cache = appearancePreviewState.textureCache;
    if (cache.animationFramesByKey.has(cacheKey)) {
      return cache.animationFramesByKey.get(cacheKey);
    }

    const registry = getResourceRegistrySnapshot();
    const sheetInfo = (registry.spritesheets || []).find((item) => item.name === sheetName) || null;
    const frames = sheetInfo?.sheet?.animations?.[animationName] || null;
    cache.animationFramesByKey.set(cacheKey, frames);
    return frames;
  }

  function centerPreviewDisplayObject(displayObject, anchorX, anchorY, previewScale) {
    const app = appearancePreviewState.app;
    if (!app || !displayObject) {
      return;
    }

    if (typeof displayObject.anchor?.set === 'function') {
      displayObject.anchor.set(anchorX, anchorY);
    }
    if (typeof displayObject.scale?.set === 'function') {
      displayObject.scale.set(previewScale, previewScale);
    }

    displayObject.x = app.view.width / 2;
    displayObject.y = app.view.height / 2;
  }

  function renderAppearancePreview() {
    const app = ensurePreviewApp();
    if (!app) {
      return;
    }

    clearPreviewStage();

    const renderType = fields.appearanceRenderType?.value || 'none';
    const sourceType = fields.appearanceSourceType?.value || 'tileset';
    const sheet = fields.appearanceSheet?.value || '';
    const animationName = fields.appearanceAnimationName?.value || '';
    const frameConfig = {
      x: fields.appearanceFrameX?.value,
      y: fields.appearanceFrameY?.value,
      width: fields.appearanceFrameWidth?.value,
      height: fields.appearanceFrameHeight?.value,
    };
    const anchorX = parseFiniteNumber(fields.appearanceAnchorX?.value, DEFAULT_APPEARANCE.anchorX);
    const anchorY = parseFiniteNumber(fields.appearanceAnchorY?.value, DEFAULT_APPEARANCE.anchorY);
    const previewScale = Math.max(0.1, parseFiniteNumber(fields.appearancePreviewScale?.value, DEFAULT_APPEARANCE.previewScale));

    if (renderType === 'none') {
      createPreviewEmptyState('未配置外观');
      return;
    }

    if (!sheet) {
      createPreviewEmptyState('未选择资源');
      return;
    }

    if (renderType === 'animated') {
      const frames = getPreviewAnimationFrames(sheet, animationName);
      if (!Array.isArray(frames) || frames.length === 0) {
        createPreviewEmptyState('动画不可用');
        return;
      }

      const animatedSprite = new PIXI.AnimatedSprite(frames);
      animatedSprite.animationSpeed = 0.1;
      animatedSprite.loop = true;
      centerPreviewDisplayObject(animatedSprite, anchorX, anchorY, previewScale);
      animatedSprite.play();
      appearancePreviewState.root.addChild(animatedSprite);
      appearancePreviewState.currentDisplayObject = animatedSprite;
      return;
    }

    const texture = getPreviewStaticTexture(sourceType, sheet, frameConfig);
    if (!texture) {
      createPreviewEmptyState('贴图不可用');
      return;
    }

    const sprite = new PIXI.Sprite(texture);
    centerPreviewDisplayObject(sprite, anchorX, anchorY, previewScale);
    appearancePreviewState.root.addChild(sprite);
    appearancePreviewState.currentDisplayObject = sprite;
  }

  function disposeAppearancePreview() {
    clearPreviewStage();

    appearancePreviewState.textureCache.staticTextureByKey.forEach((texture) => {
      texture.destroy(false);
    });
    appearancePreviewState.textureCache.staticTextureByKey.clear();

    appearancePreviewState.textureCache.baseTextureByUrl.clear();
    appearancePreviewState.textureCache.animationFramesByKey.clear();

    if (appearancePreviewState.app) {
      appearancePreviewState.app.destroy(false, {
        children: true,
        texture: false,
        textureSource: false,
      });
    }

    appearancePreviewState.app = null;
    appearancePreviewState.root = null;
    appearancePreviewState.currentDisplayObject = null;
    appearancePreviewState.initialized = false;
  }

  function renderList() {
    listEl.innerHTML = '';

    if (state.catalog.length === 0) {
      const li = document.createElement('li');
      li.className = 'semantic-empty-card';

      const title = document.createElement('strong');
      title.textContent = '暂无物体';
      const hint = document.createElement('span');
      hint.textContent = '点击“新建物体”创建后，可切换到“物体放置”模式进行摆放。';

      li.appendChild(title);
      li.appendChild(hint);
      listEl.appendChild(li);
      return;
    }

    for (let i = 0; i < state.catalog.length; i++) {
      const item = state.catalog[i];
      const li = document.createElement('li');
      li.className = 'semantic-list-item';
      if (state.selectedCatalogKey === item.key) {
        li.classList.add('is-selected');
      }
      li.textContent = `${item.name} (${item.key}) [${appearanceLabel(item)}]`;
      li.dataset.key = item.key;
      li.addEventListener('click', () => {
        state.selectedCatalogKey = item.key;
        setMode('object');
        placer.setSelectedCatalogKey(item.key);
        fillFormFromCatalog(item);
        renderList();
      });
      listEl.appendChild(li);
    }
  }

  function fillForm(formData) {
    fields.key.value = formData.key || '';
    fields.name.value = formData.name || '';
    fields.category.value = formData.category || 'default';
    fields.description.value = formData.description || '';
    fields.interactionHint.value = formData.interactionHint || '';
    fields.occupiedTiles.value = formData.occupiedTiles || '0,0';
    fields.blocksMovement.checked = !!formData.blocksMovement;

    fields.appearanceRenderType.value = formData.appearanceRenderType || DEFAULT_FORM.appearanceRenderType;
    fields.appearanceSourceType.value = formData.appearanceSourceType || DEFAULT_FORM.appearanceSourceType;

    updateAppearanceOptions();

    fields.appearanceSheet.value = formData.appearanceSheet || fields.appearanceSheet.value || '';
    updateAppearanceOptions();

    fields.appearanceAnimationName.value = formData.appearanceAnimationName || fields.appearanceAnimationName.value || '';
    fields.appearanceFrameX.value = formData.appearanceFrameX || DEFAULT_FORM.appearanceFrameX;
    fields.appearanceFrameY.value = formData.appearanceFrameY || DEFAULT_FORM.appearanceFrameY;
    fields.appearanceFrameWidth.value = formData.appearanceFrameWidth || DEFAULT_FORM.appearanceFrameWidth;
    fields.appearanceFrameHeight.value = formData.appearanceFrameHeight || DEFAULT_FORM.appearanceFrameHeight;
    fields.appearanceAnchorX.value = formData.appearanceAnchorX || DEFAULT_FORM.appearanceAnchorX;
    fields.appearanceAnchorY.value = formData.appearanceAnchorY || DEFAULT_FORM.appearanceAnchorY;
    fields.appearancePreviewScale.value = formData.appearancePreviewScale || DEFAULT_FORM.appearancePreviewScale;

    syncAppearanceFieldVisibility();
  }

  function fillFormFromCatalog(item) {
    const appearance = deriveAppearance(item);
    fillForm({
      key: item.key,
      name: item.name,
      category: item.category,
      description: item.description,
      interactionHint: item.interactionHint || '',
      occupiedTiles: occupiedTilesToText(item.occupiedTiles),
      blocksMovement: item.blocksMovement,
      appearanceRenderType: appearance.renderType,
      appearanceSourceType: appearance.sourceType,
      appearanceSheet: appearance.sheet || appearance.tileSetUrl,
      appearanceAnimationName: appearance.animationName,
      appearanceFrameX: String(appearance.frameConfig.x),
      appearanceFrameY: String(appearance.frameConfig.y),
      appearanceFrameWidth: String(appearance.frameConfig.width),
      appearanceFrameHeight: String(appearance.frameConfig.height),
      appearanceAnchorX: String(appearance.anchorX),
      appearanceAnchorY: String(appearance.anchorY),
      appearancePreviewScale: String(appearance.previewScale),
    });
  }

  function resetForm() {
    fillForm(DEFAULT_FORM);
  }

  function readForm() {
    return {
      key: fields.key.value,
      name: fields.name.value,
      category: fields.category.value,
      description: fields.description.value,
      interactionHint: fields.interactionHint.value,
      occupiedTiles: fields.occupiedTiles.value,
      blocksMovement: fields.blocksMovement.checked,
      appearanceRenderType: fields.appearanceRenderType.value,
      appearanceSourceType: fields.appearanceSourceType.value,
      appearanceSheet: fields.appearanceSheet.value,
      appearanceAnimationName: fields.appearanceAnimationName.value,
      appearanceFrameX: fields.appearanceFrameX.value,
      appearanceFrameY: fields.appearanceFrameY.value,
      appearanceFrameWidth: fields.appearanceFrameWidth.value,
      appearanceFrameHeight: fields.appearanceFrameHeight.value,
      appearanceAnchorX: fields.appearanceAnchorX.value,
      appearanceAnchorY: fields.appearanceAnchorY.value,
      appearancePreviewScale: fields.appearancePreviewScale.value,
    };
  }

  function validateAppearance(raw) {
    const renderType = raw.appearanceRenderType;
    const sourceType = raw.appearanceSourceType;

    if (renderType === 'none') {
      return true;
    }

    if (renderType === 'animated') {
      if (sourceType !== 'spritesheet') {
        alert('动画渲染必须使用 spritesheet 资源');
        return false;
      }
      if (!raw.appearanceSheet || raw.appearanceSheet.trim().length === 0) {
        alert('动画渲染必须选择 spritesheet');
        return false;
      }
      if (!raw.appearanceAnimationName || raw.appearanceAnimationName.trim().length === 0) {
        alert('动画渲染必须选择动画名称');
        return false;
      }
    }

    if (renderType === 'static') {
      if (!raw.appearanceSheet || raw.appearanceSheet.trim().length === 0) {
        alert('静态渲染必须选择贴图资源');
        return false;
      }
      const width = Number(raw.appearanceFrameWidth);
      const height = Number(raw.appearanceFrameHeight);
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        alert('静态渲染帧尺寸必须为正数');
        return false;
      }
    }

    return true;
  }

  function validateForm(raw) {
    if (!raw.key || raw.key.trim().length === 0) {
      alert('物体 key 不能为空');
      return false;
    }
    if (!raw.name || raw.name.trim().length === 0) {
      alert('物体名称不能为空');
      return false;
    }
    if (!validateAppearance(raw)) {
      return false;
    }
    return true;
  }

  function upsertCatalogItem(raw) {
    const nextKey = raw.key.trim();
    const selectedIndex = state.selectedCatalogKey
      ? state.catalog.findIndex((item) => item.key === state.selectedCatalogKey)
      : -1;

    if (selectedIndex >= 0) {
      const oldKey = state.catalog[selectedIndex].key;
      const conflict = state.catalog.find(
        (item, index) => item.key === nextKey && index !== selectedIndex,
      );
      if (conflict) {
        alert('key 已存在，请修改 key');
        return;
      }

      const normalized = normalizeCatalogPayload(raw, state.catalog[selectedIndex]);
      state.catalog[selectedIndex] = normalized;
      state.selectedCatalogKey = normalized.key;

      if (oldKey !== normalized.key) {
        state.worldSemantic.objectInstances = state.worldSemantic.objectInstances.map((instance) => {
          if (instance.catalogKey !== oldKey) {
            return instance;
          }
          return {
            ...instance,
            catalogKey: normalized.key,
          };
        });
        placer.setObjectInstances(state.worldSemantic.objectInstances);
      }
    } else {
      const existing = findByKey(state.catalog, nextKey);
      if (existing) {
        alert('key 已存在，请修改 key');
        return;
      }

      const normalized = normalizeCatalogPayload(raw, null);
      state.catalog.push(normalized);
      state.selectedCatalogKey = normalized.key;
    }

    syncCatalogToGlobal();
    placer.refreshCatalog(state.catalog);
    placer.setSelectedCatalogKey(state.selectedCatalogKey);
    updateAppearanceOptions();
    syncAppearanceFieldVisibility();
    renderList();
  }

  function deleteSelectedCatalog() {
    if (!state.selectedCatalogKey) {
      return;
    }

    const idx = state.catalog.findIndex((item) => item.key === state.selectedCatalogKey);
    if (idx < 0) {
      return;
    }

    const deletingKey = state.catalog[idx].key;
    state.catalog.splice(idx, 1);

    const remained = placer
      .getObjectInstances()
      .filter((instance) => instance.catalogKey !== deletingKey);
    state.worldSemantic.objectInstances = remained;
    placer.setObjectInstances(remained);
    syncZoneContainedInstanceIds(remained);

    state.selectedCatalogKey = null;
    syncCatalogToGlobal();
    placer.refreshCatalog(state.catalog);
    resetForm();
    updateAppearanceOptions();
    syncAppearanceFieldVisibility();
    renderList();
  }

  function togglePanel() {
    if (!panelBody || !togglePanelBtn) {
      return;
    }

    state.panelCollapsed = !state.panelCollapsed;
    panelBody.style.display = state.panelCollapsed ? 'none' : 'block';

    togglePanelBtn.classList.toggle('is-collapsed', state.panelCollapsed);
    togglePanelBtn.setAttribute('aria-expanded', state.panelCollapsed ? 'false' : 'true');

    const textEl = togglePanelBtn.querySelector('.semantic-collapse-text');
    if (textEl) {
      textEl.textContent = state.panelCollapsed ? '展开面板' : '收起面板';
    }
  }

  function togglePlacement() {
    if (state.mode === 'object') {
      setMode('terrain');
      return;
    }
    setMode('object');
  }

  function toggleZoneMode() {
    if (state.mode === 'zone') {
      setMode('terrain');
      return;
    }
    setMode('zone');
  }

  function setSemanticModeEnabled(enabled) {
    if (enabled) {
      if (state.mode === 'zone') {
        setEditorMode('zone');
      } else {
        setEditorMode('object');
      }
      return;
    }
    setEditorMode('terrain');
  }

  function saveZoneMeta() {
    const selected = zoner.getSelectedZone();
    const payload = readZoneForm();

    if (!selected) {
      zoner.createZone(payload);
      renderZoneList();
      refreshPrimaryZoneText();
      return;
    }

    zoner.updateSelectedZoneMeta(payload);
    renderZoneList();
    refreshPrimaryZoneText();
  }

  function deleteSelectedZone() {
    zoner.deleteSelectedZone();
    renderZoneList();
    refreshPrimaryZoneText();
  }

  function loadFromMapModule(mod) {
    const objectInstances = Array.isArray(mod?.objectInstances) ? mod.objectInstances : [];
    const zones = Array.isArray(mod?.zones) ? mod.zones : [];

    state.worldSemantic.objectInstances = objectInstances.map((item) => ({
      instanceId: item.instanceId,
      catalogKey: item.catalogKey,
      x: Number(item.x) || 0,
      y: Number(item.y) || 0,
      note: item.note || '',
    }));
    state.worldSemantic.zones = zones.map((zone) => normalizeZoneFromModule(zone));

    placer.setObjectInstances(state.worldSemantic.objectInstances);
    placer.setZones(state.worldSemantic.zones);
    zoner.setZones(state.worldSemantic.zones);
    syncZoneContainedInstanceIds(state.worldSemantic.objectInstances);
    renderZoneList();
    refreshPrimaryZoneText();
  }

  function getSemanticSnapshot() {
    return {
      objectInstances: placer.getObjectInstances(),
      zones: zoner.getZones(),
    };
  }

  if (togglePanelBtn) {
    togglePanelBtn.addEventListener('click', togglePanel);
  }
  if (normalBtn) {
    normalBtn.addEventListener('click', () => setMode('terrain'));
  }
  if (placementBtn) {
    placementBtn.addEventListener('click', togglePlacement);
  }
  if (zoneToggleBtn) {
    zoneToggleBtn.addEventListener('click', toggleZoneMode);
  }

  if (newBtn) {
    newBtn.addEventListener('click', () => {
      state.selectedCatalogKey = null;
      resetForm();
      renderList();
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', deleteSelectedCatalog);
  }
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      resetForm();
      updateAppearanceOptions();
      syncAppearanceFieldVisibility();
    });
  }

  if (fields.appearanceRenderType) {
    fields.appearanceRenderType.addEventListener('change', syncAppearanceFieldVisibility);
  }
  if (fields.appearanceSourceType) {
    fields.appearanceSourceType.addEventListener('change', () => {
      updateAppearanceOptions();
      syncAppearanceFieldVisibility();
    });
  }
  if (fields.appearanceSheet) {
    fields.appearanceSheet.addEventListener('change', () => {
      updateAppearanceOptions();
      renderAppearancePreview();
    });
  }
  if (fields.appearanceAnimationName) {
    fields.appearanceAnimationName.addEventListener('change', renderAppearancePreview);
  }
  [
    fields.appearanceFrameX,
    fields.appearanceFrameY,
    fields.appearanceFrameWidth,
    fields.appearanceFrameHeight,
    fields.appearanceAnchorX,
    fields.appearanceAnchorY,
    fields.appearancePreviewScale,
  ].forEach((input) => {
    if (!input) {
      return;
    }
    input.addEventListener('input', renderAppearancePreview);
  });

  if (zoneNewBtn) {
    zoneNewBtn.addEventListener('click', () => {
      setMode('zone');
      zoner.selectZone(null);
      resetZoneForm();
      renderZoneList();
      refreshPrimaryZoneText();
    });
  }

  if (zoneDeleteBtn) {
    zoneDeleteBtn.addEventListener('click', deleteSelectedZone);
  }
  if (zoneResetBtn) {
    zoneResetBtn.addEventListener('click', resetZoneForm);
  }

  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const payload = readForm();
      if (!validateForm(payload)) {
        return;
      }
      upsertCatalogItem(payload);
    });
  }

  if (zoneForm) {
    zoneForm.addEventListener('submit', (event) => {
      event.preventDefault();
      saveZoneMeta();
    });
  }

  updateAppearanceOptions();
  resetForm();
  syncAppearanceFieldVisibility();
  resetZoneForm();
  renderList();
  renderZoneList();
  setMode('terrain');

  placer.init();
  zoner.init();
  syncZoneContainedInstanceIds(placer.getObjectInstances());
  refreshPrimaryZoneText();

  return {
    placer,
    zoner,
    setSemanticModeEnabled,
    setEditorMode,
    loadFromMapModule,
    getSemanticSnapshot,
    refreshCatalog() {
      placer.refreshCatalog(state.catalog);
      updateAppearanceOptions();
      syncAppearanceFieldVisibility();
    },
    destroyPreview: disposeAppearancePreview,
  };
}
