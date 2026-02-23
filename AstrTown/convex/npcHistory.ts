import { v } from 'convex/values';
import { query } from './_generated/server';
import { conversationId, playerId } from './aiTown/ids';

type TimeLabel = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

function getTimeLabel(timestamp: number, now: number, timezoneOffsetMinutes: number): TimeLabel {
  // 与 Date#getTimezoneOffset 语义一致：UTC - local（分钟）。
  // 例如 UTC+8 => -480。
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  const shiftedNow = new Date(now - offsetMs);
  const todayStart =
    Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate()) +
    offsetMs;
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 7 * 24 * 60 * 60 * 1000;

  if (timestamp >= todayStart) {
    return 'today';
  }
  if (timestamp >= yesterdayStart) {
    return 'yesterday';
  }
  if (timestamp >= weekStart) {
    return 'thisWeek';
  }
  return 'earlier';
}

type ConversationSummary = {
  conversationId: string;
  created: number;
  ended: number;
  numMessages: number;
  participants: string[];
  timeLabel: TimeLabel;
};

type ConversationGroup = {
  otherPlayerId: string;
  otherPlayerName: string | null;
  isNpc: boolean;
  byTime: Record<TimeLabel, ConversationSummary[]>;
};

type MessageWithAuthor = {
  _id: string;
  _creationTime: number;
  conversationId: string;
  author: string;
  authorName: string | null;
  text: string;
  messageUuid: string;
};

export const getNpcConversationHistory = query({
  args: {
    worldId: v.id('worlds'),
    npcPlayerId: playerId,
    // 建议前端传入：new Date().getTimezoneOffset()
    timezoneOffsetMinutes: v.optional(v.number()),
    // 建议前端传入 useHistoricalTime().historicalTime，以保证时间轴一致。
    referenceTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.referenceTime ?? Date.now();
    const timezoneOffsetMinutes = args.timezoneOffsetMinutes ?? 0;

    // 使用 worlds 内 agents 快照建立 NPC playerId 集合。
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`Invalid world ID: ${args.worldId}`);
    }
    const npcPlayerIds = new Set<string>(world.agents.map((a) => a.playerId));

    // 补充历史 agent，兼容 NPC 已离开世界的场景。
    const archivedAgents = await ctx.db
      .query('archivedAgents')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    for (const a of archivedAgents) {
      npcPlayerIds.add(a.playerId);
    }

    // 使用 playerHistory 索引按 ended 倒序，避免全表扫描。
    const memberEdges = await ctx.db
      .query('participatedTogether')
      .withIndex('playerHistory', (q) => q.eq('worldId', args.worldId).eq('player1', args.npcPlayerId))
      .order('desc')
      .collect();

    // 去重 conversationId，避免同一对话被重复读取。
    const seenConversationIds = new Set<string>();
    const grouped = new Map<string, ConversationGroup>();

    // name cache，减少重复查询。
    const playerNameCache = new Map<string, string | null>();

    const npcDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.npcPlayerId))
      .unique();

    for (const edge of memberEdges) {
      if (seenConversationIds.has(edge.conversationId)) {
        continue;
      }
      seenConversationIds.add(edge.conversationId);

      const conv = await ctx.db
        .query('archivedConversations')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('id', edge.conversationId))
        .unique();

      if (!conv || conv.numMessages <= 0) {
        continue;
      }

      const summary: ConversationSummary = {
        conversationId: conv.id,
        created: conv.created,
        ended: conv.ended,
        numMessages: conv.numMessages,
        participants: conv.participants,
        timeLabel: getTimeLabel(conv.ended, now, timezoneOffsetMinutes),
      };

      for (const otherPlayerId of conv.participants) {
        if (otherPlayerId === args.npcPlayerId) {
          continue;
        }

        if (!playerNameCache.has(otherPlayerId)) {
          const pd = await ctx.db
            .query('playerDescriptions')
            .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', otherPlayerId))
            .unique();
          playerNameCache.set(otherPlayerId, pd?.name ?? null);
        }

        let group = grouped.get(otherPlayerId);
        if (!group) {
          group = {
            otherPlayerId,
            otherPlayerName: playerNameCache.get(otherPlayerId) ?? null,
            isNpc: npcPlayerIds.has(otherPlayerId),
            byTime: { today: [], yesterday: [], thisWeek: [], earlier: [] },
          };
          grouped.set(otherPlayerId, group);
        }

        group.byTime[summary.timeLabel].push(summary);
      }
    }

    // 保持每个分组内时间降序。
    for (const group of grouped.values()) {
      (Object.keys(group.byTime) as TimeLabel[]).forEach((label) => {
        group.byTime[label].sort((a, b) => b.ended - a.ended);
      });
    }

    return {
      npcPlayerId: args.npcPlayerId,
      npcName: npcDescription?.name ?? null,
      groups: [...grouped.values()],
    };
  },
});

export const getConversationDetail = query({
  args: {
    worldId: v.id('worlds'),
    conversationId,
    npcPlayerId: playerId,
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('id', args.conversationId))
      .unique();

    if (!conversation) {
      return null;
    }

    if (!conversation.participants.includes(args.npcPlayerId)) {
      return [];
    }

    const rawMessages = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) => q.eq('worldId', args.worldId).eq('conversationId', args.conversationId))
      .collect();

    const playerNameCache = new Map<string, string | null>();
    const messages: MessageWithAuthor[] = [];

    for (const m of rawMessages) {
      if (!playerNameCache.has(m.author)) {
        const pd = await ctx.db
          .query('playerDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', m.author))
          .unique();
        playerNameCache.set(m.author, pd?.name ?? null);
      }

      messages.push({
        _id: String(m._id),
        _creationTime: m._creationTime,
        conversationId: m.conversationId,
        author: m.author,
        authorName: playerNameCache.get(m.author) ?? null,
        text: m.text,
        messageUuid: m.messageUuid,
      });
    }

    messages.sort((a, b) => a._creationTime - b._creationTime);

    return {
      conversationId: conversation.id,
      created: conversation.created,
      ended: conversation.ended,
      numMessages: conversation.numMessages,
      participants: conversation.participants,
      messages,
    };
  },
});

