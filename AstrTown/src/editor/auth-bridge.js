// 编辑器认证桥接模块

const SESSION_STORAGE_KEY = 'astrtown_session_token';

// 获取存储在 localStorage 的 sessionToken
export function getSessionToken() {
    try {
        const value = localStorage.getItem(SESSION_STORAGE_KEY);
        const trimmed = typeof value === 'string' ? value.trim() : '';
        return trimmed || null;
    } catch {
        return null;
    }
}

// 检查是否已登录
export function isAuthenticated() {
    return !!getSessionToken();
}

// 获取当前用户信息（通过 /api/auth/me 接口）
export async function getCurrentUser() {
    const token = getSessionToken();
    if (!token) {
        return null;
    }

    try {
        const response = await fetch('/api/auth/me', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
            },
        });

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        if (!data || typeof data !== 'object') {
            return null;
        }

        const candidate = data;
        if (
            typeof candidate.userId === 'string'
            && typeof candidate.username === 'string'
            && (candidate.role === 'admin' || candidate.role === 'user')
        ) {
            return {
                userId: candidate.userId,
                username: candidate.username,
                role: candidate.role,
            };
        }

        return null;
    } catch (error) {
        console.error('获取用户信息失败:', error);
        return null;
    }
}

// 带认证的 fetch 封装
export async function authenticatedFetch(url, options = {}) {
    const token = getSessionToken();
    if (!token) {
        throw new Error('未登录');
    }

    return fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`,
        },
    });
}

// 初始化编辑器认证状态（页面加载时调用）
export async function initEditorAuth() {
    const user = await getCurrentUser();
    if (window.g_ctx) {
        window.g_ctx.currentUser = user;
        window.g_ctx.isAuthenticated = !!user;
    }
    return user;
}
