import { mutation, query } from '../_generated/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { v } from 'convex/values';
import { validateSession } from '../auth';
import type { AssetStatus } from './_shared';
import { requireAuthenticatedUser } from './_shared';

type AssetReadAuthCtx = Pick<QueryCtx, 'db'>;

type AssetTableName =
  | 'tilesetAssets'
  | 'characterSheetAssets'
  | 'sceneAnimationAssets';

type AssetId = Id<'tilesetAssets'> | Id<'characterSheetAssets'> | Id<'sceneAnimationAssets'>;

type AssetDoc =
  | Doc<'tilesetAssets'>
  | Doc<'characterSheetAssets'>
  | Doc<'sceneAnimationAssets'>;

type AssetKindArg = 'tileset' | 'characterSheet' | 'sceneAnimation';

type AssetMetadata<T extends AssetDoc> = Omit<T, 'imageStorageId' | 'coverImageStorageId'>;

const publicAssetStatus: AssetStatus = 'published';
const assetStatusValidator = v.union(
  v.literal('draft'),
  v.literal('submitted'),
  v.literal('approved'),
  v.literal('published'),
);

async function getOptionalCurrentUserId(
  ctx: Pick<QueryCtx, 'db'>,
  sessionToken: string | undefined,
): Promise<Id<'users'> | null> {
  if (!sessionToken) {
    return null;
  }

  const token = sessionToken.trim();
  if (!token) {
    return null;
  }

  const user = await validateSession(ctx, token);
  return user?.userId ?? null;
}

function ensureCanReadAsset(asset: AssetDoc, currentUserId: Id<'users'> | null) {
  if (asset.deletedAt !== undefined) {
    throw new Error('资源不存在或已删除');
  }

  if (asset.status === publicAssetStatus) {
    return;
  }

  if (!currentUserId || asset.ownerUserId !== currentUserId) {
    throw new Error('无权查看该资源');
  }
}

function toAssetMetadata<T extends AssetDoc>(asset: T): AssetMetadata<T> {
  const { imageStorageId: _imageStorageId, coverImageStorageId: _coverImageStorageId, ...metadata } = asset;
  return metadata;
}

async function listAssets(
  ctx: QueryCtx,
  options: {
    tableName: AssetTableName;
    status: AssetStatus | undefined;
    sessionToken: string | undefined;
  },
): Promise<Array<AssetMetadata<AssetDoc>>> {
  const { tableName, status, sessionToken } = options;

  if (status === undefined || status === publicAssetStatus) {
    const assets = await ctx.db
      .query(tableName)
      .withIndex('by_status', (q) => q.eq('status', publicAssetStatus))
      .order('desc')
      .collect();

    return assets
      .filter((asset: AssetDoc) => asset.deletedAt === undefined)
      .map((asset: AssetDoc) => toAssetMetadata(asset));
  }

  const currentUser = await requireAuthenticatedUser(
    ctx as unknown as Parameters<typeof requireAuthenticatedUser>[0],
    sessionToken ?? '',
  );
  const assets = await ctx.db
    .query(tableName)
    .withIndex('by_ownerUserId_status', (q) => q.eq('ownerUserId', currentUser.userId).eq('status', status))
    .order('desc')
    .collect();

  return assets
    .filter((asset: AssetDoc) => asset.deletedAt === undefined)
    .map((asset: AssetDoc) => toAssetMetadata(asset));
}

async function getAssetDetail<T extends AssetDoc>(
  ctx: QueryCtx,
  options: {
    id: AssetId;
    sessionToken: string | undefined;
  },
): Promise<T> {
  const asset = (await ctx.db.get(options.id)) as T | null;
  if (!asset) {
    throw new Error('资源不存在');
  }

  const currentUserId = await getOptionalCurrentUserId(ctx, options.sessionToken);
  ensureCanReadAsset(asset, currentUserId);
  return asset;
}

async function findAssetByStorageId(
  ctx: QueryCtx,
  assetKind: AssetKindArg,
  storageId: string,
): Promise<AssetDoc | null> {
  if (assetKind === 'tileset') {
    return (await ctx.db
      .query('tilesetAssets')
      .filter((q) => q.eq(q.field('imageStorageId'), storageId))
      .first()) as Doc<'tilesetAssets'> | null;
  }

  if (assetKind === 'characterSheet') {
    return (await ctx.db
      .query('characterSheetAssets')
      .filter((q) => q.eq(q.field('imageStorageId'), storageId))
      .first()) as Doc<'characterSheetAssets'> | null;
  }

  return (await ctx.db
    .query('sceneAnimationAssets')
    .filter((q) => q.eq(q.field('imageStorageId'), storageId))
    .first()) as Doc<'sceneAnimationAssets'> | null;
}

async function softDeleteAsset(
  ctx: MutationCtx,
  options: {
    id: AssetId;
    sessionToken: string;
  },
) {
  const currentUser = await requireAuthenticatedUser(ctx, options.sessionToken);
  const asset = await ctx.db.get(options.id);

  if (!asset || asset.deletedAt !== undefined) {
    throw new Error('资源不存在或已删除');
  }

  if (asset.ownerUserId !== currentUser.userId) {
    throw new Error('无权删除该资源');
  }

  const now = Date.now();
  await ctx.db.patch(options.id, {
    deletedAt: now,
    updatedAt: now,
  });

  return { success: true };
}

export const listTilesets = query({
  args: {
    status: v.optional(assetStatusValidator),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await listAssets(ctx, {
      tableName: 'tilesetAssets',
      status: args.status,
      sessionToken: args.sessionToken,
    });
  },
});

export const listCharacterSheets = query({
  args: {
    status: v.optional(assetStatusValidator),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await listAssets(ctx, {
      tableName: 'characterSheetAssets',
      status: args.status,
      sessionToken: args.sessionToken,
    });
  },
});

export const listSceneAnimations = query({
  args: {
    status: v.optional(assetStatusValidator),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await listAssets(ctx, {
      tableName: 'sceneAnimationAssets',
      status: args.status,
      sessionToken: args.sessionToken,
    });
  },
});

export const getTilesetDetail = query({
  args: {
    id: v.id('tilesetAssets'),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await getAssetDetail<Doc<'tilesetAssets'>>(ctx, {
      id: args.id,
      sessionToken: args.sessionToken,
    });
  },
});

export const getCharacterSheetDetail = query({
  args: {
    id: v.id('characterSheetAssets'),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await getAssetDetail<Doc<'characterSheetAssets'>>(ctx, {
      id: args.id,
      sessionToken: args.sessionToken,
    });
  },
});

export const getSceneAnimationDetail = query({
  args: {
    id: v.id('sceneAnimationAssets'),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await getAssetDetail<Doc<'sceneAnimationAssets'>>(ctx, {
      id: args.id,
      sessionToken: args.sessionToken,
    });
  },
});

export const getAssetFileUrl = query({
  args: {
    assetKind: v.union(v.literal('tileset'), v.literal('characterSheet'), v.literal('sceneAnimation')),
    storageId: v.string(),
    sessionToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const asset = await findAssetByStorageId(ctx, args.assetKind, args.storageId);
    if (!asset) {
      throw new Error('资源不存在');
    }

    const currentUserId = await getOptionalCurrentUserId(ctx, args.sessionToken);
    ensureCanReadAsset(asset, currentUserId);

    return {
      url: await ctx.storage.getUrl(args.storageId),
    };
  },
});

export const deleteTileset = mutation({
  args: {
    id: v.id('tilesetAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await softDeleteAsset(ctx, args);
  },
});

export const deleteCharacterSheet = mutation({
  args: {
    id: v.id('characterSheetAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await softDeleteAsset(ctx, args);
  },
});

export const deleteSceneAnimation = mutation({
  args: {
    id: v.id('sceneAnimationAssets'),
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    return await softDeleteAsset(ctx, args);
  },
});
