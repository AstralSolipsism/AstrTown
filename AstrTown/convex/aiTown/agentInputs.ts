import { v } from 'convex/values';
import { agentId, conversationId, parseGameId } from './ids';
import { Player, activity } from './player';
import { Conversation, conversationInputs } from './conversation';
import { movePlayer } from './movement';
import { inputHandler } from './inputHandler';
import { point } from '../util/types';
import { Descriptions } from '../../data/characters';
import { Agent, createDefaultExternalQueueState, externalEventItemValidator } from './agent';
import { EXTERNAL_QUEUE_MAX_SIZE } from '../constants';

function resetExternalQueueRuntimeState(agent: Agent) {
  agent.externalQueueState = createDefaultExternalQueueState();
}

export const agentInputs = {
  enqueueExternalEvents: inputHandler({
    args: {
      agentId,
      events: v.array(externalEventItemValidator),
    },
    handler: (game, _now, args) => {
      const parsedAgentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(parsedAgentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${parsedAgentId}`);
      }

      for (const event of args.events) {
        if (event.priority < 2) {
          agent.externalPriorityQueue.push(event);
        } else {
          agent.externalEventQueue.push(event);
        }
      }

      const overflow =
        agent.externalPriorityQueue.length + agent.externalEventQueue.length - EXTERNAL_QUEUE_MAX_SIZE;
      if (overflow > 0) {
        if (agent.externalEventQueue.length >= overflow) {
          agent.externalEventQueue.splice(0, overflow);
        } else {
          const remaining = overflow - agent.externalEventQueue.length;
          agent.externalEventQueue = [];
          if (remaining > 0) {
            agent.externalPriorityQueue.splice(0, remaining);
          }
        }
      }

      agent.externalQueueState.idle.mode = 'active';
      delete agent.externalQueueState.idle.sleepingSince;
      delete agent.externalQueueState.idle.roamingStartedAt;
      delete agent.externalQueueState.idle.roamingUntilAt;
      delete agent.externalQueueState.idle.lastRoamMoveAt;
      agent.externalQueueState.idle.consecutivePrefetchMisses = 0;
      agent.externalQueueState.prefetch.waiting = false;
      agent.externalQueueState.prefetch.dispatched = false;
      agent.externalQueueState.prefetch.retries = 0;
      delete agent.externalQueueState.prefetch.requestId;
      delete agent.externalQueueState.prefetch.requestedAt;
      return null;
    },
  }),
  clearExternalQueue: inputHandler({
    args: {
      agentId,
    },
    handler: (game, _now, args) => {
      const parsedAgentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(parsedAgentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${parsedAgentId}`);
      }
      agent.externalEventQueue = [];
      agent.externalPriorityQueue = [];
      resetExternalQueueRuntimeState(agent);
      return null;
    },
  }),
  finishRememberConversation: inputHandler({
    args: {
      operationId: v.string(),
      agentId,
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }
      if (
        !agent.inProgressOperation ||
        agent.inProgressOperation.operationId !== args.operationId
      ) {
        console.debug(`Agent ${agentId} isn't remembering ${args.operationId}`);
      } else {
        delete agent.inProgressOperation;
        delete agent.toRemember;
      }
      return null;
    },
  }),
  finishDoSomething: inputHandler({
    args: {
      operationId: v.string(),
      agentId: v.id('agents'),
      destination: v.optional(point),
      invitee: v.optional(v.id('players')),
      activity: v.optional(activity),
    },
    handler: (game, now, args) => {
      const agentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(agentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${agentId}`);
      }

      const operationMismatch =
        !agent.inProgressOperation || agent.inProgressOperation.operationId !== args.operationId;
      if (operationMismatch) {
        console.debug(`Agent ${agentId} didn't have ${args.operationId} in progress`);
        return null;
      }
      delete agent.inProgressOperation;

      const player = game.world.players.get(agent.playerId)!;
      if (args.invitee) {
        const inviteeId = parseGameId('players', args.invitee);
        const invitee = game.world.players.get(inviteeId);
        if (!invitee) {
          throw new Error(`Couldn't find player: ${inviteeId}`);
        }
        Conversation.start(game, now, player, invitee);
        agent.lastInviteAttempt = now;
      }
      if (args.destination) {
        movePlayer(game, now, player, args.destination);
      }
      if (args.activity) {
        player.activity = {
          ...args.activity,
          started: Date.now(),
          actionId: args.operationId,
        };
      }
      return null;
    },
  }),
  externalBotSendMessage: inputHandler({
    args: {
      agentId,
      conversationId,
      text: v.optional(v.string()),
      timestamp: v.number(),
      leaveConversation: v.boolean(),
    },
    handler: (game, now, args) => {
      const parsedAgentId = parseGameId('agents', args.agentId);
      const agent = game.world.agents.get(parsedAgentId);
      if (!agent) {
        throw new Error(`Couldn't find agent: ${parsedAgentId}`);
      }
      const player = game.world.players.get(agent.playerId);
      if (!player) {
        throw new Error(`Couldn't find player: ${agent.playerId}`);
      }
      const parsedConversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(parsedConversationId);
      if (!conversation) {
        throw new Error(`Couldn't find conversation: ${parsedConversationId}`);
      }
      conversationInputs.finishSendingMessage.handler(game, now, {
        playerId: agent.playerId,
        conversationId: args.conversationId,
        text: args.text,
        timestamp: args.timestamp,
      });
      if (args.leaveConversation) {
        conversation.leave(game, now, player);
      }
      return null;
    },
  }),
  createAgent: inputHandler({
    args: {
      descriptionIndex: v.number(),
    },
    handler: (game, now, args) => {
      const description = Descriptions[args.descriptionIndex];
      const playerId = Player.join(
        game,
        now,
        description.name,
        description.character,
        description.identity,
      );
      const agentId = game.allocId('agents');
      game.world.agents.set(
        agentId,
        new Agent({
          id: agentId,
          playerId: playerId,
          inProgressOperation: undefined,
          lastConversation: undefined,
          lastInviteAttempt: undefined,
          toRemember: undefined,
          externalEventQueue: [],
          externalPriorityQueue: [],
          externalQueueState: createDefaultExternalQueueState(),
        }),
      );
      return { agentId };
    },
  }),
};
