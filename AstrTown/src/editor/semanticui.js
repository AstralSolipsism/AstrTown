import { createSemanticPlacer } from './semanticplacer.js';
import { createSemanticZoner } from './semanticzoner.js';
import { mapObjectCatalog as seedCatalog } from '../../data/mapObjectCatalog.js';

const DEFAULT_FORM = {
  key: '',
  name: '',
  category: 'default',
  description: '',
  interactionHint: '',
  occupiedTiles: '0,0',
  blocksMovement: true,
};

const DEFAULT_ZONE_FORM = {
  name: '',
  description: '',
  priority: '0',
  activities: '',
};

function cloneCatalogItem(item) {
  return {
    key: item.key,
    name: item.name,
    category: item.category,
    description: item.description,
    interactionHint: item.interactionHint,
    tileSetUrl: item.tileSetUrl,
    frameConfig: item.frameConfig,
    anchorX: item.anchorX,
    anchorY: item.anchorY,
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
  return {
    key: raw.key.trim(),
    name: raw.name.trim(),
    category: raw.category.trim() || 'default',
    description: raw.description.trim(),
    interactionHint: raw.interactionHint.trim() || undefined,
    tileSetUrl: oldItem?.tileSetUrl,
    frameConfig: oldItem?.frameConfig,
    anchorX: oldItem?.anchorX,
    anchorY: oldItem?.anchorY,
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
    mode: 'normal',
    panelCollapsed: false,
    worldSemantic: {
      objectInstances: [],
      zones: [],
    },
  };

  if (Array.isArray(options.initialCatalog) && options.initialCatalog.length > 0) {
    state.catalog = options.initialCatalog.map((item) => cloneCatalogItem(item));
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

  function setMode(mode) {
    state.mode = mode;
    const normalMode = mode === 'normal';
    const objectMode = mode === 'object';
    const zoneMode = mode === 'zone';

    g_ctx.semanticMode = objectMode || zoneMode;

    placer.setPlacementEnabled(objectMode);
    zoner.setDrawingEnabled(zoneMode);

    syncModeButtonState(normalBtn, normalMode);
    syncModeButtonState(placementBtn, objectMode);
    syncModeButtonState(zoneToggleBtn, zoneMode);

    if (objectMode) {
      placementStatus.textContent = '当前：物体放置模式';
    } else if (zoneMode) {
      placementStatus.textContent = '当前：区域绘制模式';
    } else {
      placementStatus.textContent = '当前：普通绘制模式';
    }
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
    const selected = zoner.getSelectedZone();
    if (!selected) {
      zonePrimaryEl.textContent = '该格子主区域：无';
      return;
    }

    const primary = zoner.getPrimaryZoneForZoneCenter(selected.zoneId);
    if (!primary) {
      zonePrimaryEl.textContent = '该格子主区域：无';
      return;
    }

    zonePrimaryEl.textContent = `该格子主区域：${primary.name} (P${primary.priority})`;
  }

  function syncCatalogToGlobal() {
    writeCatalogBack(state.catalog);
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
      li.textContent = `${item.name} (${item.key})`;
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
  }

  function fillFormFromCatalog(item) {
    fillForm({
      key: item.key,
      name: item.name,
      category: item.category,
      description: item.description,
      interactionHint: item.interactionHint || '',
      occupiedTiles: occupiedTilesToText(item.occupiedTiles),
      blocksMovement: item.blocksMovement,
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
    };
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
    renderList();
  }

  function togglePanel() {
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
      setMode('normal');
      return;
    }
    setMode('object');
  }

  function toggleZoneMode() {
    if (state.mode === 'zone') {
      setMode('normal');
      return;
    }
    setMode('zone');
  }

  function setSemanticModeEnabled(enabled) {
    if (enabled) {
      if (state.mode === 'normal') {
        setMode('object');
      } else {
        setMode(state.mode);
      }
      return;
    }
    setMode('normal');
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

  togglePanelBtn.addEventListener('click', togglePanel);
  if (normalBtn) {
    normalBtn.addEventListener('click', () => setMode('normal'));
  }
  placementBtn.addEventListener('click', togglePlacement);
  zoneToggleBtn.addEventListener('click', toggleZoneMode);

  newBtn.addEventListener('click', () => {
    state.selectedCatalogKey = null;
    resetForm();
    renderList();
  });

  deleteBtn.addEventListener('click', deleteSelectedCatalog);
  resetBtn.addEventListener('click', resetForm);

  zoneNewBtn.addEventListener('click', () => {
    setMode('zone');
    zoner.selectZone(null);
    resetZoneForm();
    renderZoneList();
    refreshPrimaryZoneText();
  });

  zoneDeleteBtn.addEventListener('click', deleteSelectedZone);
  zoneResetBtn.addEventListener('click', resetZoneForm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = readForm();
    if (!validateForm(payload)) {
      return;
    }
    upsertCatalogItem(payload);
  });

  zoneForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveZoneMeta();
  });

  resetForm();
  resetZoneForm();
  renderList();
  renderZoneList();
  setMode('normal');

  placer.init();
  zoner.init();
  syncZoneContainedInstanceIds(placer.getObjectInstances());
  refreshPrimaryZoneText();

  return {
    placer,
    zoner,
    setSemanticModeEnabled,
    loadFromMapModule,
    getSemanticSnapshot,
    refreshCatalog() {
      placer.refreshCatalog(state.catalog);
    },
  };
}
