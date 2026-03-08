import { mutation } from '../_generated/server';
import { v } from 'convex/values';
import { requireAuthenticatedUser } from './_shared';

export const generateUploadUrl = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, args) => {
    await requireAuthenticatedUser(ctx, args.sessionToken);

    const uploadUrl = await ctx.storage.generateUploadUrl();

    // 当前阶段先返回占位 storageId，前端在实际上传完成后仍应使用真实 storageId 回填 metadata。
    return {
      uploadUrl,
      storageId: '',
    };
  },
});

export const saveTilesetMetadata = mutation({
  args: {
    sessionToken: v.string(),
    storageId: v.string(),
    name: v.string(),
    tileWidth: v.number(),
    tileHeight: v.number(),
    columns: v.number(),
    rows: v.number(),
    config: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireAuthenticatedUser(ctx, args.sessionToken);
    const now = Date.now();

    // schema 当前未定义 name 字段，因此这里只接收参数但不落库，避免擅自修改表结构。
    void args.name;

    return await ctx.db.insert('tilesetAssets', {
      kind: 'tileset',
      ownerUserId: currentUser.userId,
      imageStorageId: args.storageId,
      status: 'draft',
      reviewDecision: 'pending',
      version: 1,
      createdAt: now,
      updatedAt: now,
      tileWidth: args.tileWidth,
      tileHeight: args.tileHeight,
      columns: args.columns,
      rows: args.rows,
      ...(args.config === undefined ? {} : { config: args.config }),
    });
  },
});

export const saveCharacterSheetMetadata = mutation({
  args: {
    sessionToken: v.string(),
    storageId: v.string(),
    characterName: v.string(),
    animations: v.any(),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireAuthenticatedUser(ctx, args.sessionToken);
    const now = Date.now();

    return await ctx.db.insert('characterSheetAssets', {
      kind: 'character_sheet',
      ownerUserId: currentUser.userId,
      imageStorageId: args.storageId,
      status: 'draft',
      reviewDecision: 'pending',
      version: 1,
      createdAt: now,
      updatedAt: now,
      characterName: args.characterName,
      animations: args.animations,
    });
  },
});

export const saveSceneAnimationMetadata = mutation({
  args: {
    sessionToken: v.string(),
    storageId: v.string(),
    animationName: v.string(),
    frameCount: v.number(),
    frameDuration: v.number(),
    loop: v.boolean(),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireAuthenticatedUser(ctx, args.sessionToken);
    const now = Date.now();

    return await ctx.db.insert('sceneAnimationAssets', {
      kind: 'scene_animation',
      ownerUserId: currentUser.userId,
      imageStorageId: args.storageId,
      status: 'draft',
      reviewDecision: 'pending',
      version: 1,
      createdAt: now,
      updatedAt: now,
      animationName: args.animationName,
      frameCount: args.frameCount,
      frameDuration: args.frameDuration,
      loop: args.loop,
    });
  },
});
