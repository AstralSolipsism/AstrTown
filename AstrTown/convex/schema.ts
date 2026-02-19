import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId, agentId } from './aiTown/ids';
import { engineTables } from './engine/schema';

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

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
