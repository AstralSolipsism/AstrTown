import type { EventPriority, MoveToCommand } from './types.js';

export type CommandType =
  | 'move_to'
  | 'say'
  | 'set_activity'
  | 'accept_invite'
  | 'invite'
  | 'start_conversation'
  | 'leave_conversation'
  | 'continue_doing'
  | 'do_something';

export type AstrTownCommandRequest = {
  agentId: string;
  commandType: CommandType;
  args: unknown;
};

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
          until: Date.now() + Number((payload as any)?.duration ?? 0),
        },
      },
    }),
  });

  mapper.register({
    commandType: 'accept_invite',
    buildRequest: (payload) => ({
      agentId: (payload as any)?.agentId,
      commandType: 'accept_invite',
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
        actionType: (payload as any)?.actionType,
        args: (payload as any)?.args,
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

  return mapper;
}
