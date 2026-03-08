import { mutation, query } from '../_generated/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { v } from 'convex/values';
import { validateSession } from '../auth';
import { requireAdminUser, requireAuthenticatedUser } from './_shared';

type ReviewableAssetTableName =
  | 'tilesetAssets'
  | 'characterSheetAssets'
  | 'sceneAnimationAssets';

type ReviewableAssetDoc =
  | Doc<'tilesetAssets'>
  | Doc<'characterSheetAssets'>
  | Doc<'sceneAnimationAssets'>;

type ReviewableAssetId =
  | Id<'tilesetAssets'>
  | Id<'characterSheetAssets'>
  | Id<'sceneAnimationAssets'>;

type PendingReviewKind = 'tileset' | 'characterSheet' | 'sceneAnimation' | 'all';

type PendingReviewItem = {
  kind: 'tileset' | 'characterSheet' | 'sceneAnimation';
  asset: ReviewableAssetDoc;
};

const reviewDecisionValidator = v.union(v.literal('approved'), v.literal('rejected'));
const pendingReviewKindValidator = v.union(
  v.literal('tileset'),
  v.literal('characterSheet'),
  v.literal('sceneAnimation'),
  v.literal('all'),
);

async function getExistingAsset<T extends ReviewableAssetDoc>(ctx: MutationCtx | QueryCtx, id: ReviewableAssetId): Promise<T> {
  const asset = (await ctx.db.get(id)) as T | null;
  if (!asset || asset.deletedAt !== undefined) {
    throw new Error('资源不存在或已删除');
  }
  return asset;
}

async function submitAssetForReview(
  ctx: MutationCtx,
  options: {
    id: ReviewableAssetId;
    sessionToken: string;
  },
) {
  const currentUser = await requireAuthenticatedUser(ctx, options.sessionToken);
  const asset = await getExistingAsset(ctx, options.id);

  if (asset.ownerUserId !== currentUser.userId) {
    throw new Error('只有资源拥有者可提交审核');
  }

  if (asset.status !== 'draft') {
    throw new Error('只有草稿状态资源可提交审核');
  }

  const now = Date.now();
  await ctx.db.patch(options.id, {
    status: 'submitted',
    reviewDecision: 'pending',
    submittedBy: currentUser.userId,
    submittedAt: now,
    reviewedBy: undefined,
    reviewedAt: undefined,
    reviewComment: undefined,
    updatedAt: now,
  });

  return { success: true };
}

async function reviewAsset(
  ctx: MutationCtx,
  options: {
    id: ReviewableAssetId;
    sessionToken: string;
    decision: 'approved' | 'rejected';
    comment?: string;
  },
) {
  const currentUser = await requireAdminUser(ctx, options.sessionToken);
  const asset = await getExistingAsset(ctx, options.id);

  if (asset.status !== 'submitted') {
    throw new Error('只有待审核状态资源可审核');
  }

  const comment = options.comment?.trim();
  if (options.decision === 'rejected' && !comment) {
    throw new Error('拒绝审核时必须填写原因');
  }

  const now = Date.now();
  await ctx.db.patch(options.id, {
    status: options.decision === 'approved' ? 'approved' : 'rejected',
    reviewDecision: options.decision,
    reviewedBy: currentUser.userId,
    reviewedAt: now,
    reviewComment: comment || undefined,
    updatedAt: now,
  });

  return { success: true };
}

async function publishAsset(
  ctx: MutationCtx,
  options: {
    id: ReviewableAssetId;
    sessionToken: string;
  },
) {
  await requireAdminUser(ctx, options.sessionToken);
  const asset = await getExistingAsset(ctx, options.id);

  if (asset.status !== 'approved') {
    throw new Error('只有审核通过状态资源可发布');
  }

  const now = Date.now();
  await ctx.db.patch(options.id, {
    status: 'published',
    publishedAt: now,
    updatedAt: now,
  });

  return { success: true };
}

async function collectPendingReviews(
  ctx: QueryCtx,
  tableName: ReviewableAssetTableName,
  kind: PendingReviewItem['kind'],
): Promise<PendingReviewItem[]> {
  const assets = await ctx.db
    .query(tableName)
    .withIndex('by_status', (q) => q.eq('status', 'submitted'))
    .collect();

  return assets
    .filter((asset) => asset.deletedAt === undefined && asset.reviewDecision === 'pending')
    .map((asset) => ({
      kind,
      asset: asset as ReviewableAssetDoc,
    }));
}

export const submitTilesetForReview = mutation({
  args: {
    id: v.id('tilesetAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await submitAssetForReview(ctx, args);
  },
});

export const submitCharacterSheetForReview = mutation({
  args: {
    id: v.id('characterSheetAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await submitAssetForReview(ctx, args);
  },
});

export const submitSceneAnimationForReview = mutation({
  args: {
    id: v.id('sceneAnimationAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await submitAssetForReview(ctx, args);
  },
});

export const reviewTileset = mutation({
  args: {
    id: v.id('tilesetAssets'),
    sessionToken: v.string(),
    decision: reviewDecisionValidator,
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await reviewAsset(ctx, args);
  },
});

export const reviewCharacterSheet = mutation({
  args: {
    id: v.id('characterSheetAssets'),
    sessionToken: v.string(),
    decision: reviewDecisionValidator,
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await reviewAsset(ctx, args);
  },
});

export const reviewSceneAnimation = mutation({
  args: {
    id: v.id('sceneAnimationAssets'),
    sessionToken: v.string(),
    decision: reviewDecisionValidator,
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await reviewAsset(ctx, args);
  },
});

export const publishTileset = mutation({
  args: {
    id: v.id('tilesetAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await publishAsset(ctx, args);
  },
});

export const publishCharacterSheet = mutation({
  args: {
    id: v.id('characterSheetAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await publishAsset(ctx, args);
  },
});

export const publishSceneAnimation = mutation({
  args: {
    id: v.id('sceneAnimationAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await publishAsset(ctx, args);
  },
});

export const listPendingReviews = query({
  args: {
    assetKind: pendingReviewKindValidator,
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await validateSession(ctx, args.sessionToken);
    if (!currentUser) {
      throw new Error('未登录或登录状态已失效');
    }
    if (currentUser.role !== 'admin') {
      throw new Error('只有管理员可执行该操作');
    }

    if (args.assetKind === 'tileset') {
      return await collectPendingReviews(ctx, 'tilesetAssets', 'tileset');
    }

    if (args.assetKind === 'characterSheet') {
      return await collectPendingReviews(ctx, 'characterSheetAssets', 'characterSheet');
    }

    if (args.assetKind === 'sceneAnimation') {
      return await collectPendingReviews(ctx, 'sceneAnimationAssets', 'sceneAnimation');
    }

    const [tilesets, characterSheets, sceneAnimations] = await Promise.all([
      collectPendingReviews(ctx, 'tilesetAssets', 'tileset'),
      collectPendingReviews(ctx, 'characterSheetAssets', 'characterSheet'),
      collectPendingReviews(ctx, 'sceneAnimationAssets', 'sceneAnimation'),
    ]);

    return [...tilesets, ...characterSheets, ...sceneAnimations].sort(
      (a, b) => b.asset.updatedAt - a.asset.updatedAt,
    );
  },
});
