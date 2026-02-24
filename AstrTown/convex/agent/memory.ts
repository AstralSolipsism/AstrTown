import { v } from 'convex/values';
import { ActionCtx, DatabaseReader, internalAction, internalMutation, query } from '../_generated/server';
import { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { fetchEmbedding } from '../util/llm';
import { asyncMap } from '../util/asyncMap';
import { GameId, agentId, playerId } from '../aiTown/ids';
import { memoryFields } from './schema';

// How long to wait before updating a memory's last access time.
export const MEMORY_ACCESS_THROTTLE = 300_000; // In ms
// We fetch 10x the number of memories by relevance, to have more candidates
// for sorting by relevance + recency + importance.
const MEMORY_OVERFETCH = 10;
const selfInternal = internal.agent.memory;

export type Memory = Doc<'memories'>;
export type MemoryType = Memory['data']['type'];
export type MemoryOfType<T extends MemoryType> = Omit<Memory, 'data'> & {
  data: Extract<Memory['data'], { type: T }>;
};

function buildExternalMemoryData(
  memoryType: string | undefined,
  worldId: Id<'worlds'>,
  agentId: GameId<'agents'>,
  playerId: GameId<'players'>,
  now: number,
): Memory['data'] {
  const type = memoryType ?? 'conversation';
  if (type === 'relationship') {
    return {
      type,
      playerId,
    };
  }
  if (type === 'reflection') {
    return {
      type,
      relatedMemoryIds: [],
    };
  }
  if (type !== 'conversation') {
    throw new Error(`Unsupported memoryType: ${type}`);
  }
  return {
    type,
    conversationId: `c:${now}:${worldId}:${agentId}` as GameId<'conversations'>,
    playerIds: [],
  };
}

async function insertExternalMemoryImpl(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  agentId: GameId<'agents'>,
  playerId: GameId<'players'>,
  summary: string,
  importance: number,
  memoryType: string | undefined,
) {
  const { embedding } = await fetchEmbedding(summary);
  const now = Date.now();
  await ctx.runMutation(selfInternal.insertMemory, {
    agentId,
    playerId,
    description: summary,
    importance,
    lastAccess: now,
    data: buildExternalMemoryData(memoryType, worldId, agentId, playerId, now),
    embedding,
  });

  return summary;
}

export const insertExternalMemory = internalAction({
  args: {
    worldId: v.id('worlds'),
    agentId,
    playerId,
    summary: v.string(),
    importance: v.number(),
    memoryType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await insertExternalMemoryImpl(
      ctx,
      args.worldId,
      args.agentId as GameId<'agents'>,
      args.playerId as GameId<'players'>,
      args.summary,
      args.importance,
      args.memoryType,
    );
  },
});

export const getRecentMemories = query({
  args: {
    worldId: v.string(),
    playerId: v.string(),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.count) || args.count <= 0) {
      throw new Error('count must be a positive integer');
    }

    const recentMemories = await ctx.db
      .query('memories')
      .withIndex('playerId', (q) => q.eq('playerId', args.playerId as GameId<'players'>))
      .order('desc')
      .take(args.count);

    return recentMemories.map((memory: Memory) => ({
      _id: memory._id,
      _creationTime: memory._creationTime,
      playerId: memory.playerId,
      description: memory.description,
      importance: memory.importance,
      lastAccess: memory.lastAccess,
      data: memory.data,
    }));
  },
});


export async function searchMemories(
  ctx: ActionCtx,
  playerId: GameId<'players'>,
  searchEmbedding: number[],
  n: number = 3,
) {
  const candidates = await ctx.vectorSearch('memoryEmbeddings', 'embedding', {
    vector: searchEmbedding,
    filter: (q) => q.eq('playerId', playerId),
    limit: n * MEMORY_OVERFETCH,
  });
  const rankedMemories = await ctx.runMutation(selfInternal.rankAndTouchMemories, {
    candidates,
    n,
  });
  return rankedMemories.map(({ memory }) => memory);
}

function makeRange(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return [min, max] as const;
}

function normalize(value: number, range: readonly [number, number]) {
  const [min, max] = range;
  return (value - min) / (max - min);
}

export const rankAndTouchMemories = internalMutation({
  args: {
    candidates: v.array(v.object({ _id: v.id('memoryEmbeddings'), _score: v.number() })),
    n: v.number(),
  },
  handler: async (ctx, args) => {
    const ts = Date.now();
    const relatedMemories = await asyncMap(args.candidates, async ({ _id }) => {
      const memory = await ctx.db
        .query('memories')
        .withIndex('embeddingId', (q) => q.eq('embeddingId', _id))
        .first();
      if (!memory) throw new Error(`Memory for embedding ${_id} not found`);
      return memory;
    });

    // TODO: fetch <count> recent memories and <count> important memories
    // so we don't miss them in case they were a little less relevant.
    const recencyScore = relatedMemories.map((memory) => {
      const hoursSinceAccess = (ts - memory.lastAccess) / 1000 / 60 / 60;
      return 0.99 ** Math.floor(hoursSinceAccess);
    });
    const relevanceRange = makeRange(args.candidates.map((c) => c._score));
    const importanceRange = makeRange(relatedMemories.map((m) => m.importance));
    const recencyRange = makeRange(recencyScore);
    const memoryScores = relatedMemories.map((memory, idx) => ({
      memory,
      overallScore:
        normalize(args.candidates[idx]._score, relevanceRange) +
        normalize(memory.importance, importanceRange) +
        normalize(recencyScore[idx], recencyRange),
    }));
    memoryScores.sort((a, b) => b.overallScore - a.overallScore);
    const accessed = memoryScores.slice(0, args.n);
    await asyncMap(accessed, async ({ memory }) => {
      if (memory.lastAccess < ts - MEMORY_ACCESS_THROTTLE) {
        await ctx.db.patch(memory._id, { lastAccess: ts });
      }
    });
    return accessed;
  },
});


const { embeddingId: _embeddingId, ...memoryFieldsWithoutEmbeddingId } = memoryFields;

export const insertMemory = internalMutation({
  args: {
    agentId,
    embedding: v.array(v.float64()),
    ...memoryFieldsWithoutEmbeddingId,
  },
  handler: async (ctx, { agentId: _, embedding, ...memory }): Promise<void> => {
    const embeddingId = await ctx.db.insert('memoryEmbeddings', {
      playerId: memory.playerId,
      embedding,
    });
    await ctx.db.insert('memories', {
      ...memory,
      embeddingId,
    });
  },
});


export async function latestMemoryOfType<T extends MemoryType>(
  db: DatabaseReader,
  playerId: GameId<'players'>,
  type: T,
) {
  const entry = await db
    .query('memories')
    .withIndex('playerId_type', (q) => q.eq('playerId', playerId).eq('data.type', type))
    .order('desc')
    .first();
  if (!entry) return null;
  return entry as MemoryOfType<T>;
}
