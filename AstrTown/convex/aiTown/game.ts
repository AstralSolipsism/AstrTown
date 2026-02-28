import { Infer, v } from 'convex/values';
import { Doc, Id } from '../_generated/dataModel';
import {
  ActionCtx,
  DatabaseReader,
  MutationCtx,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { World, serializedWorld } from './world';
import { WorldMap, serializedWorldMap } from './worldMap';
import { PlayerDescription, serializedPlayerDescription } from './playerDescription';
import { Location, locationFields, playerLocation } from './location';
import { runAgentOperation } from './agent';
import { GameId, IdTypes, allocGameId } from './ids';
import { InputArgs, InputNames, inputs } from './inputs';
import {
  AbstractGame,
  EngineUpdate,
  applyEngineUpdate,
  engineUpdate,
  loadEngine,
} from '../engine/abstractGame';
import { internal } from '../_generated/api';
import { HistoricalObject } from '../engine/historicalObject';
import { parseMap, serializeMap } from '../util/object';

const gameState = v.object({
  world: v.object(serializedWorld),
  playerDescriptions: v.array(v.object(serializedPlayerDescription)),
  worldMap: v.object(serializedWorldMap),
});
type GameState = Infer<typeof gameState>;

const gameStateDiff = v.object({
  world: v.object(serializedWorld),
  playerDescriptions: v.optional(v.array(v.object(serializedPlayerDescription))),
  worldMap: v.optional(v.object(serializedWorldMap)),
  agentOperations: v.array(v.object({ name: v.string(), args: v.any() })),
});
type GameStateDiff = Infer<typeof gameStateDiff>;

export class Game extends AbstractGame {
  tickDuration = 16;
  stepDuration = 1000;
  maxTicksPerStep = 600;
  maxInputsPerStep = 32;

  world: World;

  historicalLocations: Map<GameId<'players'>, HistoricalObject<Location>>;

  descriptionsModified: boolean;
  worldMap: WorldMap;
  playerDescriptions: Map<GameId<'players'>, PlayerDescription>;

  pendingOperations: Array<{ name: string; args: any }> = [];

  numPathfinds: number;

  constructor(
    engine: Doc<'engines'>,
    public worldId: Id<'worlds'>,
    state: GameState,
  ) {
    super(engine);

    this.world = new World(state.world);
    delete this.world.historicalLocations;

    this.descriptionsModified = false;
    this.worldMap = new WorldMap(state.worldMap);
    this.playerDescriptions = parseMap(
      state.playerDescriptions,
      PlayerDescription,
      (p) => p.playerId,
    );

    this.historicalLocations = new Map();

    this.numPathfinds = 0;
  }

  static async load(
    db: DatabaseReader,
    worldId: Id<'worlds'>,
    generationNumber: number,
  ): Promise<{ engine: Doc<'engines'>; gameState: GameState }> {
    const worldDoc = await db.get(worldId);
    if (!worldDoc) {
      throw new Error(`No world found with id ${worldId}`);
    }
    const worldStatus = await db
      .query('worldStatus')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .unique();
    if (!worldStatus) {
      throw new Error(`No engine found for world ${worldId}`);
    }
    const engine = await loadEngine(db, worldStatus.engineId, generationNumber);
    const playerDescriptionsDocs = await db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .collect();
    const worldMapDoc = await db
      .query('maps')
      .withIndex('worldId', (q) => q.eq('worldId', worldId))
      .unique();
    if (!worldMapDoc) {
      throw new Error(`No map found for world ${worldId}`);
    }
    const { _id, _creationTime, historicalLocations: _, ...world } = worldDoc;
    const playerDescriptions = playerDescriptionsDocs
      .filter((d) => !!world.players.find((p) => p.id === d.playerId))
      .map(({ _id, _creationTime, worldId: _, ...doc }) => doc);
    const {
      _id: _mapId,
      _creationTime: _mapCreationTime,
      worldId: _mapWorldId,
      ...worldMap
    } = worldMapDoc;
    return {
      engine,
      gameState: {
        world,
        playerDescriptions,
        worldMap,
      },
    };
  }

  allocId<T extends IdTypes>(idType: T): GameId<T> {
    const id = allocGameId(idType, this.world.nextId);
    this.world.nextId += 1;
    return id;
  }

  scheduleOperation(name: string, args: unknown) {
    this.pendingOperations.push({ name, args });
  }

  handleInput<Name extends InputNames>(now: number, name: Name, args: InputArgs<Name>) {
    const handler = inputs[name]?.handler;
    if (!handler) {
      throw new Error(`Invalid input: ${name}`);
    }
    return handler(this, now, args as any);
  }

  beginStep(_now: number) {
    this.historicalLocations.clear();
    for (const player of this.world.players.values()) {
      this.historicalLocations.set(
        player.id,
        new HistoricalObject(locationFields, playerLocation(player)),
      );
    }
    this.numPathfinds = 0;
  }

  tick(now: number) {
    for (const player of this.world.players.values()) {
      player.tick(this, now);
    }
    for (const player of this.world.players.values()) {
      player.tickPathfinding(this, now);
    }
    for (const player of this.world.players.values()) {
      player.tickPosition(this, now);
    }
    for (const conversation of this.world.conversations.values()) {
      conversation.tick(this, now);
    }
    for (const agent of this.world.agents.values()) {
      agent.tick(this, now);
    }

    for (const player of this.world.players.values()) {
      let historicalObject = this.historicalLocations.get(player.id);
      if (!historicalObject) {
        historicalObject = new HistoricalObject(locationFields, playerLocation(player));
        this.historicalLocations.set(player.id, historicalObject);
      }
      historicalObject.update(now, playerLocation(player));
    }
  }

  async saveStep(ctx: ActionCtx, engineUpdate: EngineUpdate): Promise<void> {
    const diff = this.takeDiff();
    await ctx.runMutation(internal.aiTown.game.saveWorld, {
      engineId: this.engine._id,
      engineUpdate,
      worldId: this.worldId,
      worldDiff: diff,
    });
  }

  takeDiff(): GameStateDiff {
    const historicalLocations = [];
    let bufferSize = 0;
    for (const [id, historicalObject] of this.historicalLocations.entries()) {
      const buffer = historicalObject.pack();
      if (!buffer) {
        continue;
      }
      historicalLocations.push({ playerId: id, location: buffer });
      bufferSize += buffer.byteLength;
    }
    if (bufferSize > 0) {
      console.debug(
        `Packed ${Object.entries(historicalLocations).length} history buffers in ${(
          bufferSize / 1024
        ).toFixed(2)}KiB.`,
      );
    }
    this.historicalLocations.clear();

    const result: GameStateDiff = {
      world: { ...this.world.serialize(), historicalLocations },
      agentOperations: this.pendingOperations,
    };
    this.pendingOperations = [];
    if (this.descriptionsModified) {
      result.playerDescriptions = serializeMap(this.playerDescriptions);
      result.worldMap = this.worldMap.serialize();
      this.descriptionsModified = false;
    }
    return result;
  }

  static async saveDiff(ctx: MutationCtx, worldId: Id<'worlds'>, diff: GameStateDiff) {
    const existingWorld = await ctx.db.get(worldId);
    if (!existingWorld) {
      throw new Error(`No world found with id ${worldId}`);
    }
    const newWorld = diff.world;
    for (const player of existingWorld.players) {
      if (!newWorld.players.some((p) => p.id === player.id)) {
        await ctx.db.insert('archivedPlayers', { worldId, ...player });
      }
    }
    for (const conversation of existingWorld.conversations) {
      if (!newWorld.conversations.some((c) => c.id === conversation.id)) {
        const participants = conversation.participants.map((p) => p.playerId);
        const archivedConversation = {
          worldId,
          id: conversation.id,
          created: conversation.created,
          creator: conversation.creator,
          ended: Date.now(),
          lastMessage: conversation.lastMessage,
          numMessages: conversation.numMessages,
          participants,
        };
        await ctx.db.insert('archivedConversations', archivedConversation);
        for (let i = 0; i < participants.length; i++) {
          for (let j = 0; j < participants.length; j++) {
            if (i == j) {
              continue;
            }
            const player1 = participants[i];
            const player2 = participants[j];
            await ctx.db.insert('participatedTogether', {
              worldId,
              conversationId: conversation.id,
              player1,
              player2,
              ended: Date.now(),
            });
          }
        }
      }
    }
    for (const conversation of existingWorld.agents) {
      if (!newWorld.agents.some((a) => a.id === conversation.id)) {
        await ctx.db.insert('archivedAgents', { worldId, ...conversation });
      }
    }

    const queueRefillRequests: Array<{
      agentId: string;
      playerId: string;
      requestId: string;
      remaining: number;
      lastDequeuedAt?: number;
      nearbyPlayers: Array<{ id: string; name: string; position: unknown }>;
    }> = [];
    for (const agent of newWorld.agents) {
      const prefetch = agent.externalQueueState?.prefetch;
      if (!prefetch || prefetch.waiting !== true || typeof prefetch.requestedAt !== 'number') {
        continue;
      }
      if (prefetch.dispatched === true || typeof prefetch.requestId !== 'string') {
        continue;
      }

      const remaining =
        (agent.externalEventQueue?.length ?? 0) + (agent.externalPriorityQueue?.length ?? 0);
      const player = newWorld.players.find((p) => p.id === agent.playerId);
      const nearbyPlayers = player
        ? newWorld.players
            .filter((p) => p.id !== player.id)
            .map((p) => ({
              id: p.id,
              name: (p as any).name,
              position: p.position,
            }))
        : [];
      queueRefillRequests.push({
        agentId: agent.id,
        playerId: agent.playerId,
        requestId: prefetch.requestId,
        remaining,
        lastDequeuedAt: agent.externalQueueState?.lastDequeuedAt,
        nearbyPlayers,
      });
      // 标记为已分发，避免每个 step 重复推送同一个 prefetch 请求。
      prefetch.dispatched = true;
    }

    await ctx.db.replace(worldId, newWorld);

    const { playerDescriptions, worldMap } = diff;
    if (playerDescriptions) {
      for (const description of playerDescriptions) {
        const existing = await ctx.db
          .query('playerDescriptions')
          .withIndex('worldId', (q) =>
            q.eq('worldId', worldId).eq('playerId', description.playerId),
          )
          .unique();
        if (existing) {
          await ctx.db.replace(existing._id, { worldId, ...description });
        } else {
          await ctx.db.insert('playerDescriptions', { worldId, ...description });
        }
      }
    }
    if (worldMap) {
      const existing = await ctx.db
        .query('maps')
        .withIndex('worldId', (q) => q.eq('worldId', worldId))
        .unique();
      if (existing) {
        await ctx.db.replace(existing._id, { worldId, ...worldMap });
      } else {
        await ctx.db.insert('maps', { worldId, ...worldMap });
      }
    }

    const AGENT_ASYNC_OPERATIONS = new Set(['agentRememberConversation']);

    for (const operation of diff.agentOperations) {
      if (AGENT_ASYNC_OPERATIONS.has(operation.name)) {
        await runAgentOperation(ctx, operation.name, operation.args);
      }
    }

    // Dispatch gateway events collected during this step.
    for (const operation of diff.agentOperations) {
      switch (operation.name) {
        case 'conversationStarted':
          await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.scheduleConversationStarted, {
            worldId,
            agentId: operation.args.agentId,
            conversationId: operation.args.conversationId,
            otherParticipantIds: operation.args.otherParticipantIds,
            priority: 0,
          });
          break;
        case 'conversation.invited':
          await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.scheduleConversationInvited, {
            worldId,
            agentId: operation.args.agentId,
            conversationId: operation.args.conversationId,
            inviterId: operation.args.inviterId,
            inviterName: operation.args.inviterName,
            priority: 0,
          });
          break;
        case 'conversation.message':
           await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.scheduleConversationMessage, {
             worldId,
             agentId: operation.args.agentId,
             conversationId: operation.args.conversationId,
             messageContent: operation.args.messageContent,
             speakerId: operation.args.speakerId,
             priority: 0,
           });
           break;
        case 'conversation.ended':
          await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.scheduleConversationEnded, {
            worldId,
            agentId: operation.args.agentId,
            conversationId: operation.args.conversationId,
            otherParticipantId: operation.args.otherParticipantId,
            otherParticipantName: operation.args.otherParticipantName,
            priority: 0,
          });
          break;
        case 'conversation.timeout':
          await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.scheduleConversationTimeout, {
            worldId,
            agentId: operation.args.agentId,
            conversationId: operation.args.conversationId,
            reason: operation.args.reason,
            priority: 0,
          });
          break;
        case 'action.finished':
          await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.scheduleActionFinished, {
            worldId,
            agentId: operation.args.agentId,
            actionType: operation.args.actionType,
            success: operation.args.success,
            resultData: operation.args.resultData,
            priority: 0,
          });
          break;
        case 'agentStateChangedIdle':
        case 'agentStateChangedInConversation': {
          const agent = newWorld.agents.find((a) => a.id === operation.args.agentId);
          const player = agent && newWorld.players.find((p) => p.id === agent.playerId);
          if (!player) {
            break;
          }

          const position = player.position;
          const nearbyPlayers = newWorld.players
            .filter((p) => p.id !== player.id)
            .map((p) => ({
              id: p.id,
              name: (p as any).name,
              position: p.position,
            }));

          await ctx.scheduler.runAfter(0, internal.aiTown.worldEventDispatcher.scheduleAgentStateChanged, {
            worldId,
            agentId: operation.args.agentId,
            state: operation.name === 'agentStateChangedIdle' ? 'idle' : 'in_conversation',
            position,
            nearbyPlayers,
            priority: 1,
          });
          break;
        }
        default:
          break;
      }
    }

    for (const request of queueRefillRequests) {
      await ctx.scheduler.runAfter(
        0,
        internal.aiTown.worldEventDispatcher.scheduleAgentQueueRefillRequested,
        {
          worldId,
          agentId: request.agentId,
          playerId: request.playerId,
          requestId: request.requestId,
          remaining: request.remaining,
          lastDequeuedAt: request.lastDequeuedAt,
          nearbyPlayers: request.nearbyPlayers,
          priority: 0,
        },
      );
    }
  }
}

export const loadWorld = internalQuery({
  args: {
    worldId: v.id('worlds'),
    generationNumber: v.number(),
  },
  handler: async (ctx, args) => {
    return await Game.load(ctx.db, args.worldId, args.generationNumber);
  },
});

export const saveWorld = internalMutation({
  args: {
    engineId: v.id('engines'),
    engineUpdate,
    worldId: v.id('worlds'),
    worldDiff: gameStateDiff,
  },
  handler: async (ctx, args) => {
    await applyEngineUpdate(ctx, args.engineId, args.engineUpdate);
    await Game.saveDiff(ctx, args.worldId, args.worldDiff);
  },
});
