import { createSemanticPlacer } from './semanticplacer.js';
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
  const placementBtn = document.getElementById('semantic-placement-toggle');
  const placementStatus = document.getElementById('semantic-placement-status');
  const newBtn = document.getElementById('semantic-new-object');
  const deleteBtn = document.getElementById('semantic-delete-object');
  const resetBtn = document.getElementById('semantic-reset-form');

  const fields = {
    key: document.getElementById('semantic-key'),
    name: document.getElementById('semantic-name'),
    category: document.getElementById('semantic-category'),
    description: document.getElementById('semantic-description'),
    interactionHint: document.getElementById('semantic-interaction-hint'),
    occupiedTiles: document.getElementById('semantic-occupied-tiles'),
    blocksMovement: document.getElementById('semantic-blocks-movement'),
  };

  const state = {
    catalog: loadCatalogFromDataFile(),
    selectedCatalogKey: null,
    placementEnabled: false,
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
    },
  });

  function setPlacementStatus() {
    if (state.placementEnabled) {
      placementBtn.textContent = '关闭放置模式';
      placementStatus.textContent = '当前：物体放置模式';
    } else {
      placementBtn.textContent = '开启放置模式';
      placementStatus.textContent = '当前：普通绘制模式';
    }
  }

  function syncCatalogToGlobal() {
    writeCatalogBack(state.catalog);
  }

  function renderList() {
    listEl.innerHTML = '';

    if (state.catalog.length === 0) {
      const li = document.createElement('li');
      li.textContent = '暂无物体，请先新建';
      listEl.appendChild(li);
      return;
    }

    for (let i = 0; i < state.catalog.length; i++) {
      const item = state.catalog[i];
      const li = document.createElement('li');
      li.style.cursor = 'pointer';
      li.style.padding = '4px 6px';
      li.style.margin = '2px 0';
      li.style.border = '1px solid #555';
      li.style.background = state.selectedCatalogKey === item.key ? '#d0ebff' : '#fff';
      li.textContent = `${item.name} (${item.key})`;
      li.dataset.key = item.key;
      li.addEventListener('click', () => {
        state.selectedCatalogKey = item.key;
        state.placementEnabled = true;
        g_ctx.semanticMode = true;
        placer.setSelectedCatalogKey(item.key);
        placer.setPlacementEnabled(true);
        fillFormFromCatalog(item);
        renderList();
        setPlacementStatus();
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

    state.selectedCatalogKey = null;
    syncCatalogToGlobal();
    placer.refreshCatalog(state.catalog);
    resetForm();
    renderList();
  }

  function togglePanel() {
    state.panelCollapsed = !state.panelCollapsed;
    panelBody.style.display = state.panelCollapsed ? 'none' : 'block';
    togglePanelBtn.textContent = state.panelCollapsed ? '展开面板' : '收起面板';
  }

  function togglePlacement() {
    state.placementEnabled = !state.placementEnabled;
    g_ctx.semanticMode = state.placementEnabled;
    placer.setPlacementEnabled(state.placementEnabled);
    setPlacementStatus();
  }

  function setSemanticModeEnabled(enabled) {
    state.placementEnabled = !!enabled;
    g_ctx.semanticMode = state.placementEnabled;
    placer.setPlacementEnabled(state.placementEnabled);
    setPlacementStatus();
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
    state.worldSemantic.zones = zones.map((zone) => ({ ...zone }));

    placer.setObjectInstances(state.worldSemantic.objectInstances);
    placer.setZones(state.worldSemantic.zones);
  }

  function getSemanticSnapshot() {
    return {
      objectInstances: placer.getObjectInstances(),
      zones: placer.getZones(),
    };
  }

  togglePanelBtn.addEventListener('click', togglePanel);
  placementBtn.addEventListener('click', togglePlacement);

  newBtn.addEventListener('click', () => {
    state.selectedCatalogKey = null;
    resetForm();
    renderList();
  });

  deleteBtn.addEventListener('click', deleteSelectedCatalog);
  resetBtn.addEventListener('click', resetForm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = readForm();
    if (!validateForm(payload)) {
      return;
    }
    upsertCatalogItem(payload);
  });

  resetForm();
  renderList();
  setPlacementStatus();

  placer.init();

  return {
    placer,
    setSemanticModeEnabled,
    loadFromMapModule,
    getSemanticSnapshot,
    refreshCatalog() {
      placer.refreshCatalog(state.catalog);
    },
  };
}
