import type { MutationCtx } from '../_generated/server';
import type { UserInfo } from '../auth';
import { validateSession } from '../auth';

// 资源类型定义，供资源上传相关模块复用
export type AssetKind = 'tileset' | 'characterSheet' | 'sceneAnimation';

// 资源状态
export type AssetStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'published';

// 审核决定
export type ReviewDecision = 'pending' | 'approved' | 'rejected';

// 需要携带 db 的可读写上下文
export type AssetMutationCtx = Pick<MutationCtx, 'db'>;

// 获取当前登录用户，未登录时直接抛出错误
export async function requireAuthenticatedUser(
  ctx: AssetMutationCtx,
  sessionToken: string,
): Promise<UserInfo> {
  const token = sessionToken.trim();
  if (!token) {
    throw new Error('未登录，缺少 session token');
  }

  const user = await validateSession(ctx, token);
  if (!user) {
    throw new Error('未登录或登录状态已失效');
  }

  return user;
}

// 获取当前管理员用户，非管理员直接拒绝
export async function requireAdminUser(
  ctx: AssetMutationCtx,
  sessionToken: string,
): Promise<UserInfo> {
  const user = await requireAuthenticatedUser(ctx, sessionToken);
  if (user.role !== 'admin') {
    throw new Error('只有管理员可执行该操作');
  }

  return user;
}
