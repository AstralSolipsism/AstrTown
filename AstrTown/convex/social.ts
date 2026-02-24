import { internalMutation, internalQuery, query } from './_generated/server';
import { v } from 'convex/values';

function sortPlayerIds(playerAId: string, playerBId: string) {
  if (playerAId <= playerBId) {
    return [playerAId, playerBId] as const;
  }
  return [playerBId, playerAId] as const;
}

export const updateAffinity = internalMutation({
  args: {
    worldId: v.string(),
    ownerId: v.string(),
    targetId: v.string(),
    scoreDelta: v.number(),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.scoreDelta)) {
      throw new Error('scoreDelta must be a finite number');
    }

    const existing = await ctx.db
      .query('affinities')
      .withIndex('by_owner_target', (q) =>
        q.eq('worldId', args.worldId).eq('ownerId', args.ownerId).eq('targetId', args.targetId),
      )
      .unique();

    const currentScore = existing?.score ?? 0;
    const nextScore = Math.max(-100, Math.min(100, currentScore + args.scoreDelta));

    if (existing) {
      await ctx.db.patch(existing._id, {
        score: nextScore,
        label: args.label,
      });
      return existing._id;
    }

    return await ctx.db.insert('affinities', {
      worldId: args.worldId,
      ownerId: args.ownerId,
      targetId: args.targetId,
      score: nextScore,
      label: args.label,
    });
  },
});

export const upsertRelationship = internalMutation({
  args: {
    worldId: v.string(),
    playerAId: v.string(),
    playerBId: v.string(),
    status: v.string(),
    establishedAt: v.number(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.establishedAt)) {
      throw new Error('establishedAt must be a finite number');
    }

    const [player1Id, player2Id] = sortPlayerIds(args.playerAId, args.playerBId);

    const existing = await ctx.db
      .query('relationships')
      .withIndex('by_players', (q) =>
        q.eq('worldId', args.worldId).eq('player1Id', player1Id).eq('player2Id', player2Id),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        status: args.status,
        establishedAt: args.establishedAt,
      });
      return existing._id;
    }

    return await ctx.db.insert('relationships', {
      worldId: args.worldId,
      player1Id,
      player2Id,
      status: args.status,
      establishedAt: args.establishedAt,
    });
  },
});

export const getSocialState = internalQuery({
  args: {
    worldId: v.string(),
    ownerId: v.string(),
    targetId: v.string(),
  },
  handler: async (ctx, args) => {
    const affinity = await ctx.db
      .query('affinities')
      .withIndex('by_owner_target', (q) =>
        q.eq('worldId', args.worldId).eq('ownerId', args.ownerId).eq('targetId', args.targetId),
      )
      .unique();

    const [player1Id, player2Id] = sortPlayerIds(args.ownerId, args.targetId);
    const relationship = await ctx.db
      .query('relationships')
      .withIndex('by_players', (q) =>
        q.eq('worldId', args.worldId).eq('player1Id', player1Id).eq('player2Id', player2Id),
      )
      .unique();

    return {
      affinity: affinity
        ? {
            score: affinity.score,
            label: affinity.label,
          }
        : null,
      relationship: relationship
        ? {
            status: relationship.status,
            establishedAt: relationship.establishedAt,
          }
        : null,
    };
  },
});

export const getPublicSocialState = query({
  args: {
    worldId: v.string(),
    ownerId: v.string(),
    targetId: v.string(),
  },
  handler: async (ctx, args) => {
    const affinity = await ctx.db
      .query('affinities')
      .withIndex('by_owner_target', (q) =>
        q.eq('worldId', args.worldId).eq('ownerId', args.ownerId).eq('targetId', args.targetId),
      )
      .unique();

    const [player1Id, player2Id] = sortPlayerIds(args.ownerId, args.targetId);
    const relationship = await ctx.db
      .query('relationships')
      .withIndex('by_players', (q) =>
        q.eq('worldId', args.worldId).eq('player1Id', player1Id).eq('player2Id', player2Id),
      )
      .unique();

    return {
      affinity: affinity
        ? {
            score: affinity.score,
            label: affinity.label,
          }
        : null,
      relationship: relationship
        ? {
            status: relationship.status,
            establishedAt: relationship.establishedAt,
          }
        : null,
    };
  },
});
