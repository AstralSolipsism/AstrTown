import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId, agentId } from './aiTown/ids';
import { engineTables } from './engine/schema';

const assetStatus = v.union(
  v.literal('draft'),
  v.literal('submitted'),
  v.literal('approved'),
  v.literal('rejected'),
  v.literal('published'),
);

const assetReviewDecision = v.union(
  v.literal('pending'),
  v.literal('approved'),
  v.literal('rejected'),
);

const assetCommonFields = {
  // 资源类型标识，便于后续三表聚合查询与统一渲染
  kind: v.string(),
  // 归属用户，关联 users 表
  ownerUserId: v.id('users'),
  // 主图片在 Convex Storage 中的存储 ID
  imageStorageId: v.string(),
  // 封面图在 Convex Storage 中的存储 ID，可选
  coverImageStorageId: v.optional(v.string()),
  // 资源状态
  status: assetStatus,
  // 审核决定
  reviewDecision: assetReviewDecision,
  // 提交审核的用户
  submittedBy: v.optional(v.id('users')),
  // 提交审核时间
  submittedAt: v.optional(v.number()),
  // 审核人
  reviewedBy: v.optional(v.id('users')),
  // 审核时间
  reviewedAt: v.optional(v.number()),
  // 审核备注
  reviewComment: v.optional(v.string()),
  // 发布时间
  publishedAt: v.optional(v.number()),
  // 资源版本号
  version: v.number(),
  // 创建时间
  createdAt: v.number(),
  // 更新时间
  updatedAt: v.number(),
  // 软删除时间
  deletedAt: v.optional(v.number()),
};

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  users: defineTable({
    username: v.string(),
    passwordHash: v.string(),
    salt: v.string(),
    role: v.union(v.literal('admin'), v.literal('user')),
    createdAt: v.number(),
  }).index('by_username', ['username']),

  sessions: defineTable({
    userId: v.id('users'),
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_token', ['token'])
    .index('by_userId', ['userId']),

  oauthAccounts: defineTable({
    userId: v.id('users'),
    provider: v.string(),
    providerUserId: v.string(),
    createdAt: v.number(),
  }).index('by_provider_user', ['provider', 'providerUserId']),

  botTokens: defineTable({
    token: v.string(),
    agentId,
    playerId,
    userId: v.optional(v.id('users')),
    worldId: v.id('worlds'),
    createdAt: v.number(),
    expiresAt: v.number(),
    isActive: v.boolean(),
    lastUsedAt: v.optional(v.number()),
    lastIdempotencyKey: v.optional(v.string()),
    lastIdempotencyResult: v.optional(v.any()),
    description: v.optional(v.string()),
  })
    .index('token', ['token'])
    .index('agentId', ['worldId', 'agentId'])
    .index('worldId', ['worldId'])
    .index('by_userId', ['userId']),

  tilesetAssets: defineTable({
    ...assetCommonFields,
    kind: v.literal('tileset'),
    tileWidth: v.number(),
    tileHeight: v.number(),
    columns: v.number(),
    rows: v.number(),
    // 可选切片配置 JSON，后续由 mutation 做严格校验
    config: v.optional(v.any()),
  })
    .index('by_ownerUserId', ['ownerUserId'])
    .index('by_status', ['status'])
    .index('by_ownerUserId_status', ['ownerUserId', 'status']),

  characterSheetAssets: defineTable({
    ...assetCommonFields,
    kind: v.literal('character_sheet'),
    characterName: v.string(),
    // 动画配置 JSON，结构后续在写入时做运行时校验
    animations: v.any(),
  })
    .index('by_ownerUserId', ['ownerUserId'])
    .index('by_status', ['status'])
    .index('by_ownerUserId_status', ['ownerUserId', 'status']),

  sceneAnimationAssets: defineTable({
    ...assetCommonFields,
    kind: v.literal('scene_animation'),
    animationName: v.string(),
    frameCount: v.number(),
    frameDuration: v.number(),
    loop: v.boolean(),
  })
    .index('by_ownerUserId', ['ownerUserId'])
    .index('by_status', ['status'])
    .index('by_ownerUserId_status', ['ownerUserId', 'status']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
