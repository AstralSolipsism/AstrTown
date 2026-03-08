// 编辑器资源选择器桥接模块

import * as PIXI from 'pixi.js';
import {
    authenticatedFetch,
    getCurrentUser,
    getSessionToken,
    isAuthenticated,
} from './auth-bridge.js';

// Convex HTTP API 基础路径
const CONVEX_API_BASE = '/api/convex';

function getAssetTitle(asset, assetKind) {
    if (assetKind === 'sceneAnimation') {
        return asset?.animationName || asset?.name || '未命名动画';
    }
    return asset?.name || '未命名瓦片集';
}

function getAssetSubtitle(asset, assetKind) {
    if (assetKind === 'sceneAnimation') {
        const frameCount = Number(asset?.frameCount) || 0;
        const frameDuration = Number(asset?.frameDuration) || 0;
        return `帧数：${frameCount} · 帧时长：${frameDuration}`;
    }

    const tileWidth = Number(asset?.tileWidth) || 0;
    const tileHeight = Number(asset?.tileHeight) || 0;
    const columns = Number(asset?.columns) || 0;
    const rows = Number(asset?.rows) || 0;
    return `切片：${tileWidth}×${tileHeight} · 网格：${columns}×${rows}`;
}

function normalizeAssetKind(assetKind) {
    return assetKind === 'sceneAnimation' ? 'sceneAnimation' : 'tileset';
}

function getSessionTokenArg() {
    const token = getSessionToken();
    return typeof token === 'string' && token.trim() ? token.trim() : undefined;
}

// 通过 HTTP 调用 Convex query
async function callConvexQuery(queryName, args = {}, options = {}) {
    const { requireAuth = false } = options;
    const url = new URL(CONVEX_API_BASE, window.location.origin);
    const nextArgs = { ...(args || {}) };
    const sessionToken = getSessionTokenArg();

    if (requireAuth) {
        if (!sessionToken) {
            throw new Error('未登录，无法访问个人资源');
        }
        nextArgs.sessionToken = sessionToken;
    } else if (sessionToken && typeof nextArgs.sessionToken === 'undefined') {
        nextArgs.sessionToken = sessionToken;
    }

    url.searchParams.set('function', queryName);
    url.searchParams.set('args', JSON.stringify(nextArgs));

    const response = requireAuth
        ? await authenticatedFetch(url.toString())
        : await fetch(url.toString());

    if (!response.ok) {
        throw new Error(`查询失败：${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (payload && typeof payload === 'object' && 'value' in payload) {
        return payload.value;
    }
    return payload;
}

// 获取已发布的瓦片集列表
export async function listPublishedTilesets() {
    return await callConvexQuery('assets:listTilesets', { status: 'published' });
}

// 获取已发布的场景动画列表
export async function listPublishedSceneAnimations() {
    return await callConvexQuery('assets:listSceneAnimations', { status: 'published' });
}

// 获取当前用户的瓦片集列表（未发布资源也允许查看）
export async function listMyTilesets() {
    if (!isAuthenticated()) {
        return [];
    }

    const statusList = ['draft', 'submitted', 'approved', 'published'];
    const resultList = await Promise.all(
        statusList.map((status) => callConvexQuery('assets:listTilesets', { status }, { requireAuth: true })),
    );

    return mergeAssetList(resultList.flat());
}

// 获取当前用户的场景动画列表（未发布资源也允许查看）
export async function listMySceneAnimations() {
    if (!isAuthenticated()) {
        return [];
    }

    const statusList = ['draft', 'submitted', 'approved', 'published'];
    const resultList = await Promise.all(
        statusList.map((status) => callConvexQuery('assets:listSceneAnimations', { status }, { requireAuth: true })),
    );

    return mergeAssetList(resultList.flat());
}

function mergeAssetList(assets = []) {
    const map = new Map();
    for (const asset of Array.isArray(assets) ? assets : []) {
        if (!asset || typeof asset !== 'object' || !asset._id) {
            continue;
        }
        map.set(asset._id, asset);
    }
    return Array.from(map.values());
}

// 获取资源详情
export async function getTilesetDetail(assetId) {
    return await callConvexQuery('assets:getTilesetDetail', { id: assetId });
}

export async function getSceneAnimationDetail(assetId) {
    return await callConvexQuery('assets:getSceneAnimationDetail', { id: assetId });
}

// 获取资源文件 URL
export async function getAssetFileUrl(assetKind, storageId) {
    const result = await callConvexQuery('assets:getAssetFileUrl', {
        assetKind,
        storageId,
    });
    return result?.url || '';
}

async function createSceneAnimationSpritesheet(detail, fileUrl) {
    if (!detail || !detail.animationName || !fileUrl) {
        throw new Error('场景动画详情不完整，无法加载资源');
    }

    const baseTexture = PIXI.BaseTexture.from(fileUrl, {
        scaleMode: PIXI.SCALE_MODES.NEAREST,
    });

    await new Promise((resolve, reject) => {
        if (baseTexture.valid) {
            resolve();
            return;
        }

        const onLoaded = () => {
            cleanup();
            resolve();
        };
        const onError = (error) => {
            cleanup();
            reject(error || new Error('动画贴图加载失败'));
        };
        const cleanup = () => {
            baseTexture.off('loaded', onLoaded);
            baseTexture.off('error', onError);
        };

        baseTexture.on('loaded', onLoaded);
        baseTexture.on('error', onError);
    });

    const frameWidth = Number(detail.frameWidth) || Number(detail.tileWidth) || 0;
    const frameHeight = Number(detail.frameHeight) || Number(detail.tileHeight) || 0;
    const frameCount = Math.max(1, Number(detail.frameCount) || 1);

    if (!frameWidth || !frameHeight) {
        throw new Error('场景动画帧尺寸无效，无法注册到编辑器');
    }

    const animations = {};
    const frames = [];
    for (let index = 0; index < frameCount; index += 1) {
        const x = index * frameWidth;
        const texture = new PIXI.Texture(baseTexture, new PIXI.Rectangle(x, 0, frameWidth, frameHeight));
        frames.push(texture);
    }

    animations[detail.animationName] = frames;
    return {
        animations,
        data: {
            meta: {
                scale: '1',
            },
        },
        baseTexture,
    };
}

// 资源选择器状态管理
let currentPickerState = null;
let pickerModalElement = null;

function buildPickerState(options = {}) {
    const assetKind = normalizeAssetKind(options.assetKind);
    return {
        assetKind,
        onSelect: typeof options.onSelect === 'function' ? options.onSelect : null,
        onCancel: typeof options.onCancel === 'function' ? options.onCancel : null,
    };
}

// 打开资源选择器
export function openAssetPicker(options = {}) {
    closeAssetPicker({ skipCancel: true });

    const pickerState = buildPickerState(options);
    const modal = createPickerModal(pickerState.assetKind);

    pickerModalElement = modal;
    currentPickerState = pickerState;
    document.body.appendChild(modal);

    loadAssetsIntoPicker(pickerState.assetKind);
}

// 关闭资源选择器
export function closeAssetPicker(options = {}) {
    const { skipCancel = false } = options;
    const state = currentPickerState;

    if (pickerModalElement) {
        pickerModalElement.remove();
        pickerModalElement = null;
    }

    currentPickerState = null;

    if (!skipCancel && state && typeof state.onCancel === 'function') {
        state.onCancel();
    }
}

function createPickerModal(assetKind) {
    const title = assetKind === 'sceneAnimation' ? '选择场景动画' : '选择瓦片集';

    const modal = document.createElement('div');
    modal.id = 'asset-picker-modal';
    modal.className = 'asset-picker-modal';
    modal.innerHTML = `
        <div class="asset-picker-overlay"></div>
        <div class="asset-picker-content" role="dialog" aria-modal="true" aria-label="${title}">
            <div class="asset-picker-header">
                <div>
                    <h3>${title}</h3>
                    <p class="asset-picker-subtitle">支持公共资源与当前账号可访问的个人资源</p>
                </div>
                <button type="button" class="asset-picker-close" aria-label="关闭">×</button>
            </div>
            <div class="asset-picker-body">
                <div class="asset-picker-auth-tip"></div>
                <div class="asset-picker-list">加载中...</div>
            </div>
            <div class="asset-picker-footer">
                <button type="button" class="asset-picker-cancel">取消</button>
            </div>
        </div>
    `;

    const closeBtn = modal.querySelector('.asset-picker-close');
    const cancelBtn = modal.querySelector('.asset-picker-cancel');
    const overlay = modal.querySelector('.asset-picker-overlay');

    if (closeBtn) {
        closeBtn.addEventListener('click', () => closeAssetPicker());
    }
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => closeAssetPicker());
    }
    if (overlay) {
        overlay.addEventListener('click', () => closeAssetPicker());
    }

    return modal;
}

async function loadAssetsIntoPicker(assetKind) {
    const listContainer = pickerModalElement?.querySelector('.asset-picker-list');
    const authTip = pickerModalElement?.querySelector('.asset-picker-auth-tip');
    if (!listContainer) {
        return;
    }

    listContainer.innerHTML = '<div class="asset-picker-loading">正在加载资源列表…</div>';

    try {
        const [publishedAssets, myAssets, user] = await Promise.all([
            assetKind === 'sceneAnimation'
                ? listPublishedSceneAnimations()
                : listPublishedTilesets(),
            assetKind === 'sceneAnimation'
                ? listMySceneAnimations()
                : listMyTilesets(),
            isAuthenticated() ? getCurrentUser() : Promise.resolve(null),
        ]);

        const mergedAssets = mergePickerAssets(publishedAssets, myAssets);
        renderPickerAuthTip(authTip, user, myAssets.length);

        if (mergedAssets.length === 0) {
            listContainer.innerHTML = '<p class="asset-picker-empty">暂无可用资源</p>';
            return;
        }

        listContainer.innerHTML = mergedAssets.map((entry) => {
            const ownerLabel = entry.isOwned ? '我的资源' : '公共资源';
            const statusLabel = entry.asset?.status ? ` · 状态：${entry.asset.status}` : '';
            return `
                <button
                    type="button"
                    class="asset-picker-item"
                    data-id="${entry.asset._id}"
                    data-kind="${assetKind}"
                >
                    <div class="asset-picker-item-header">
                        <strong>${getAssetTitle(entry.asset, assetKind)}</strong>
                        <span class="asset-picker-badge ${entry.isOwned ? 'is-owned' : 'is-public'}">${ownerLabel}</span>
                    </div>
                    <div class="asset-picker-item-meta">${getAssetSubtitle(entry.asset, assetKind)}</div>
                    <div class="asset-picker-item-extra">版本：${entry.asset.version || 1}${statusLabel}</div>
                </button>
            `;
        }).join('');

        listContainer.querySelectorAll('.asset-picker-item').forEach((item) => {
            item.addEventListener('click', () => {
                selectAsset(item.dataset.id, item.dataset.kind);
            });
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        listContainer.innerHTML = `<p class="asset-picker-error">加载失败：${message}</p>`;
        renderPickerAuthTip(authTip, null, 0);
    }
}

function renderPickerAuthTip(container, user, myAssetCount) {
    if (!container) {
        return;
    }

    if (user && user.username) {
        container.textContent = `当前登录：${user.username}，已合并可访问的个人资源 ${myAssetCount} 项。`;
        return;
    }

    container.textContent = '当前未登录，仅展示已发布的公共资源。';
}

function mergePickerAssets(publishedAssets = [], myAssets = []) {
    const merged = new Map();

    for (const asset of Array.isArray(publishedAssets) ? publishedAssets : []) {
        if (!asset || !asset._id) {
            continue;
        }
        merged.set(asset._id, {
            asset,
            isOwned: false,
        });
    }

    for (const asset of Array.isArray(myAssets) ? myAssets : []) {
        if (!asset || !asset._id) {
            continue;
        }
        merged.set(asset._id, {
            asset,
            isOwned: true,
        });
    }

    return Array.from(merged.values());
}

// 选择资源
async function selectAsset(assetId, assetKind) {
    const pickerState = currentPickerState;
    if (!pickerState || typeof pickerState.onSelect !== 'function') {
        return;
    }

    try {
        const normalizedKind = normalizeAssetKind(assetKind);
        let detail;
        let fileUrl;

        if (normalizedKind === 'sceneAnimation') {
            detail = await getSceneAnimationDetail(assetId);
            fileUrl = await getAssetFileUrl('sceneAnimation', detail.imageStorageId);
        } else {
            detail = await getTilesetDetail(assetId);
            fileUrl = await getAssetFileUrl('tileset', detail.imageStorageId);
        }

        await pickerState.onSelect({
            assetId,
            assetKind: normalizedKind,
            detail,
            fileUrl,
        });

        closeAssetPicker({ skipCancel: true });
    } catch (error) {
        console.error('选择资源失败：', error);
        const message = error instanceof Error ? error.message : '未知错误';
        window.alert(`选择资源失败：${message}`);
    }
}

// 将用户资源注册到编辑器
export async function registerUserAssetToEditor(assetInfo) {
    const { assetKind, detail, fileUrl } = assetInfo || {};
    if (!window.g_ctx) {
        throw new Error('编辑器未初始化');
    }

    const normalizedKind = normalizeAssetKind(assetKind);
    const entryId = `user_asset_${detail?._id || Date.now()}`;

    if (normalizedKind === 'tileset') {
        const entry = {
            id: entryId,
            key: entryId,
            name: entryId,
            label: detail?.name || '用户瓦片集',
            fileName: detail?.name || '用户瓦片集',
            path: fileUrl,
            sourceKind: 'userAsset',
            assetId: detail?._id,
            version: detail?.version,
            tileWidth: detail?.tileWidth,
            tileHeight: detail?.tileHeight,
            columns: detail?.columns,
            rows: detail?.rows,
            meta: {
                assetId: detail?._id,
                version: detail?.version,
                tileWidth: detail?.tileWidth,
                tileHeight: detail?.tileHeight,
                columns: detail?.columns,
                rows: detail?.rows,
            },
        };

        if (typeof window.__astrtownRegisterTilesetResource === 'function') {
            window.__astrtownRegisterTilesetResource(entry.key, entry.path, {
                type: 'tileset',
                sourceKind: entry.sourceKind,
                fileName: entry.fileName,
                path: entry.path,
                isActive: true,
                meta: entry.meta,
            });
        } else if (typeof window.registerTilesetResource === 'function') {
            window.registerTilesetResource(entry);
        } else {
            throw new Error('编辑器缺少瓦片集注册入口');
        }

        return entry;
    }

    const sheet = await createSceneAnimationSpritesheet(detail, fileUrl);
    const animationName = detail?.animationName || '用户动画';
    const entry = {
        id: entryId,
        key: entryId,
        name: entryId,
        label: animationName,
        fileName: animationName,
        path: fileUrl,
        sourceKind: 'userAsset',
        assetId: detail?._id,
        version: detail?.version,
        frameCount: detail?.frameCount,
        frameDuration: detail?.frameDuration,
        loop: detail?.loop,
        meta: {
            assetId: detail?._id,
            version: detail?.version,
            frameCount: detail?.frameCount,
            frameDuration: detail?.frameDuration,
            loop: detail?.loop,
        },
    };

    if (typeof window.__astrtownRegisterSpritesheetResource === 'function') {
        window.__astrtownRegisterSpritesheetResource(entry.key, sheet, {
            type: 'spritesheet',
            sourceKind: entry.sourceKind,
            fileName: entry.fileName,
            path: entry.path,
            isActive: true,
            meta: entry.meta,
        });
    } else if (typeof window.registerSpritesheetResource === 'function') {
        window.registerSpritesheetResource(entry);
    } else {
        throw new Error('编辑器缺少动画资源注册入口');
    }

    return {
        ...entry,
        sheet,
    };
}
