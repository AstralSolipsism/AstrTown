import type { EventPriority, MoveToCommand } from './types.js';
import type { PostCommandBatchEvent } from './astrtownClient.js';
import { createUuid } from './uuid.js';

export type CommandType =
  | 'move_to'
  | 'say'
  | 'set_activity'
  | 'accept_invite'
  | 'reject_invite'
  | 'invite'
  | 'start_conversation'
  | 'leave_conversation'
  | 'continue_doing'
  | 'do_something'
  | 'propose_relationship'
  | 'respond_relationship';

export type AstrTownCommandRequest = {
  agentId: string;
  commandType: CommandType;
  args: unknown;
};

export type ExternalEventItem = PostCommandBatchEvent;

export type CommandMapping = {
  commandType: CommandType;
  defaultPriority?: EventPriority;
  buildRequest: (payload: unknown) => AstrTownCommandRequest;
};

export class CommandMapper {
  private readonly mappings = new Map<CommandType, CommandMapping>();

  register(mapping: CommandMapping): void {
    this.mappings.set(mapping.commandType, mapping);
  }

  get(commandType: CommandType): CommandMapping | undefined {
    return this.mappings.get(commandType);
  }

  mapToExternalEvent(commandType: CommandType, payload: unknown): ExternalEventItem {
    const mapping = this.get(commandType);
    if (!mapping) {
      throw new Error(`Unknown commandType: ${commandType}`);
    }

    const request = mapping.buildRequest(payload);
    return {
      eventId: createUuid(),
      kind: request.commandType,
      args: request.args as Record<string, any>,
      priority: mapping.defaultPriority,
    };
  }

  mapBatchToExternalEvents(items: Array<{ commandType: CommandType; payload: unknown }>): ExternalEventItem[] {
    return items.map((item) => this.mapToExternalEvent(item.commandType, item.payload));
  }
}

export function createDefaultCommandMapper(): CommandMapper {
  const mapper = new CommandMapper();

  mapper.register({
    commandType: 'move_to',
    buildRequest: (payload) => {
      const moveToPayload = payload as MoveToCommand['payload'] & { agentId?: string };
      return {
        agentId: moveToPayload.agentId as string,
        commandType: 'move_to' as CommandType,
        args: { targetPlayerId: moveToPayload.targetPlayerId },
      };
    },
  });

  mapper.register({
    commandType: 'say',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'say',
      args: {
        conversationId: (payload as any)?.conversationId,
        text: (payload as any)?.text,
        leaveAfter: !!(payload as any)?.leaveAfter,
      },
    }),
  });

  mapper.register({
    commandType: 'set_activity',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'continue_doing',
      args: {
        activity: {
          description: (payload as any)?.description,
          emoji: (payload as any)?.emoji,
          started: Date.now(),
          until: Date.now() + Number((payload as any)?.duration ?? 0),
        },
      },
    }),
  });

  mapper.register({
    commandType: 'accept_invite',
    // 邀请响应必须进入优先队列，否则 NPC 在 invited 状态下不会消费普通队列中的 accept/reject。
    defaultPriority: 1,
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'accept_invite',
      args: {
        conversationId: (payload as any)?.conversationId,
      },
    }),
  });

  mapper.register({
    commandType: 'reject_invite',
    // 与 accept_invite 保持一致，确保 invited 分支可及时消费。
    defaultPriority: 1,
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'reject_invite',
      args: {
        conversationId: (payload as any)?.conversationId,
      },
    }),
  });

  mapper.register({
    commandType: 'do_something',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'do_something',
      args: {
        ...((payload as any)?.args as Record<string, unknown>),
        actionType: (payload as any)?.actionType,
      },
    }),
  });

  mapper.register({
    commandType: 'invite',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'start_conversation',
      args: {
        invitee: (payload as any)?.targetPlayerId,
      },
    }),
  });

  mapper.register({
    commandType: 'start_conversation',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'start_conversation',
      args: {
        invitee: (payload as any)?.targetPlayerId ?? (payload as any)?.invitee,
      },
    }),
  });

  mapper.register({
    commandType: 'continue_doing',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'continue_doing',
      args: {
        activity: (payload as any)?.activity,
      },
    }),
  });

  mapper.register({
    commandType: 'leave_conversation',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'leave_conversation',
      args: {
        conversationId: (payload as any)?.conversationId,
      },
    }),
  });

  mapper.register({
    commandType: 'propose_relationship',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      // 特殊命令：在 gateway 路由层本地处理，不应转发到 Convex command API。
      commandType: 'propose_relationship',
      args: {
        targetPlayerId: (payload as any)?.targetPlayerId,
        status: (payload as any)?.status,
      },
    }),
  });

  mapper.register({
    commandType: 'respond_relationship',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      // 特殊命令：在 gateway 路由层本地处理，不应转发到 Convex command API。
      commandType: 'respond_relationship',
      args: {
        proposerId: (payload as any)?.proposerId,
        accept: (payload as any)?.accept,
      },
    }),
  });

  return mapper;
}
