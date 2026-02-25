import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import closeImg from '../../assets/close.svg';
import { SelectElement } from './Player';
import { Messages } from './Messages';
import { toastOnError } from '../toasts';
import { useSendInput } from '../hooks/sendInput';
import { GameId } from '../../convex/aiTown/ids';
import { ServerGame } from '../hooks/serverGame';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import NpcHistoryDrawer from './NpcHistoryDrawer';
import AgentEventQueueDebug from './AgentEventQueueDebug';

export default function PlayerDetails({
  worldId,
  engineId,
  game,
  playerId,
  setSelectedElement,
  scrollViewRef,
}: {
  worldId: Id<'worlds'>;
  engineId: Id<'engines'>;
  game: ServerGame;
  playerId?: GameId<'players'>;
  setSelectedElement: SelectElement;
  scrollViewRef: React.RefObject<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const humanTokenIdentifier = useQuery(api.world.userStatus, { worldId });

  const players = [...game.world.players.values()];
  const humanPlayer = players.find((p) => p.human === humanTokenIdentifier);
  const humanConversation = humanPlayer ? game.world.playerConversation(humanPlayer) : undefined;
  // Always select the other player if we're in a conversation with them.
  if (humanPlayer && humanConversation) {
    const otherPlayerIds = [...humanConversation.participants.keys()].filter(
      (p) => p !== humanPlayer.id,
    );
    playerId = otherPlayerIds[0];
  }

  const player = playerId && game.world.players.get(playerId);
  const playerConversation = player && game.world.playerConversation(player);
  const playerAgent = player && [...game.world.agents.values()].find((a) => a.playerId === player.id);
  const isExternalControlledNpc = !!playerAgent;

  const previousConversation = useQuery(
    api.world.previousConversation,
    playerId ? { worldId, playerId } : 'skip',
  );

  const playerDescription = playerId && game.playerDescriptions.get(playerId);
  const [npcHistoryOpen, setNpcHistoryOpen] = useState(false);

  const socialState = useQuery(
    api.social.getPublicSocialState,
    humanPlayer && playerId
      ? {
          worldId: worldId as string,
          ownerId: playerId as string,
          targetId: humanPlayer.id as string,
        }
      : 'skip',
  );

  const relationshipBadge = useMemo(() => {
    const status = socialState?.relationship?.status;
    if (!status) {
      return '⏳ 尚未建立关系';
    }
    const normalized = status.trim().toLowerCase();
    if (normalized === 'friend' || normalized === '朋友') {
      return '🤝 朋友';
    }
    if (normalized === 'lover' || normalized === 'romantic' || normalized === '恋人') {
      return '💕 恋人';
    }
    if (normalized === 'rival' || normalized === 'enemy' || normalized === '宿敌') {
      return '⚔️ 宿敌';
    }
    return `🔖 ${status}`;
  }, [socialState?.relationship?.status]);

  const affinityScore = socialState?.affinity?.score;
  const affinityLabel = socialState?.affinity?.label;
  const normalizedAffinity =
    affinityScore === undefined || affinityScore === null
      ? null
      : Math.max(-100, Math.min(100, affinityScore));
  const affinityBarLeft =
    normalizedAffinity === null
      ? 50
      : normalizedAffinity >= 0
        ? 50
        : 50 + normalizedAffinity / 2;
  const affinityBarWidth = normalizedAffinity === null ? 0 : Math.abs(normalizedAffinity) / 2;
  const affinityBarColor =
    normalizedAffinity === null ? '#8B9BB4' : normalizedAffinity >= 0 ? '#22c55e' : '#ef4444';

  const startConversation = useSendInput(engineId, 'startConversation');
  const acceptInvite = useSendInput(engineId, 'acceptInvite');
  const rejectInvite = useSendInput(engineId, 'rejectInvite');
  const leaveConversation = useSendInput(engineId, 'leaveConversation');

  if (!playerId) {
    return (
      <div className="h-full text-xl flex text-center items-center p-4">
        {t('playerDetails.clickAgentHint')}
      </div>
    );
  }
  if (!player) {
    return null;
  }
  const isMe = humanPlayer && player.id === humanPlayer.id;
  const canInvite = !isMe && !playerConversation && humanPlayer && !humanConversation;
  const sameConversation =
    !isMe &&
    humanPlayer &&
    humanConversation &&
    playerConversation &&
    humanConversation.id === playerConversation.id;

  const humanStatus =
    humanPlayer && humanConversation && humanConversation.participants.get(humanPlayer.id)?.status;
  const playerStatus = playerConversation && playerConversation.participants.get(playerId)?.status;

  const haveInvite = sameConversation && humanStatus?.kind === 'invited' && !isExternalControlledNpc;
  const waitingForAccept =
    sameConversation && playerConversation.participants.get(playerId)?.status.kind === 'invited';
  const waitingForNearby =
    sameConversation && playerStatus?.kind === 'walkingOver' && humanStatus?.kind === 'walkingOver';

  const inConversationWithMe =
    sameConversation &&
    playerStatus?.kind === 'participating' &&
    humanStatus?.kind === 'participating';

  const onStartConversation = async () => {
    if (!humanPlayer || !playerId) {
      return;
    }
    console.log(`Starting conversation`);
    await toastOnError(startConversation({ playerId: humanPlayer.id, invitee: playerId }));
  };
  const onAcceptInvite = async () => {
    if (!humanPlayer || !humanConversation || !playerId) {
      return;
    }
    await toastOnError(
      acceptInvite({
        playerId: humanPlayer.id,
        conversationId: humanConversation.id,
      }),
    );
  };
  const onRejectInvite = async () => {
    if (!humanPlayer || !humanConversation) {
      return;
    }
    await toastOnError(
      rejectInvite({
        playerId: humanPlayer.id,
        conversationId: humanConversation.id,
      }),
    );
  };
  const onLeaveConversation = async () => {
    if (!humanPlayer || !inConversationWithMe || !humanConversation) {
      return;
    }
    await toastOnError(
      leaveConversation({
        playerId: humanPlayer.id,
        conversationId: humanConversation.id,
      }),
    );
  };

  const openNpcHistory = () => setNpcHistoryOpen(true);
  const closeNpcHistory = () => setNpcHistoryOpen(false);
  // const pendingSuffix = (inputName: string) =>
  //   [...inflightInputs.values()].find((i) => i.name === inputName) ? ' opacity-50' : '';

  const activityDescriptionI18nKeyByValue: Record<string, string> = {
    'reading a book': 'playerDetails.activity.readingBook',
    daydreaming: 'playerDetails.activity.daydreaming',
    gardening: 'playerDetails.activity.gardening',
    walking: 'playerDetails.activity.walking',
    idle: 'playerDetails.activity.idle',
  };

  const translateActivityDescription = (activityDescription: string) => {
    const normalizedDescription = activityDescription.trim().toLowerCase();
    const i18nKey = activityDescriptionI18nKeyByValue[normalizedDescription];
    return i18nKey ? t(i18nKey) : activityDescription;
  };

  const pendingSuffix = (s: string) => '';
  return (
    <>
      <div className="flex gap-4">
        <div className="box w-3/4 sm:w-full mr-auto">
          <h2 className="bg-brown-700 p-2 font-display text-2xl sm:text-4xl tracking-wider shadow-solid text-center">
            {playerDescription?.name}
          </h2>
        </div>
        <a
          className="button text-white shadow-solid text-2xl cursor-pointer pointer-events-auto"
          onClick={() => setSelectedElement(undefined)}
        >
          <h2 className="h-full bg-clay-700">
            <img className="w-4 h-4 sm:w-5 sm:h-5" src={closeImg} />
          </h2>
        </a>
      </div>
      {canInvite && (
        <a
          className={
            'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
            pendingSuffix('startConversation')
          }
          onClick={onStartConversation}
        >
          <div className="h-full bg-clay-700 text-center">
            <span>{t('playerDetails.startConversation')}</span>
          </div>
        </a>
      )}
      {waitingForAccept && (
        <a className="mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto opacity-50">
          <div className="h-full bg-clay-700 text-center">
            <span>{t('playerDetails.waitingForAccept')}</span>
          </div>
        </a>
      )}
      {waitingForNearby && (
        <a className="mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto opacity-50">
          <div className="h-full bg-clay-700 text-center">
            <span>{t('playerDetails.walkingOver')}</span>
          </div>
        </a>
      )}
      {inConversationWithMe && (
        <a
          className={
            'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
            pendingSuffix('leaveConversation')
          }
          onClick={onLeaveConversation}
        >
          <div className="h-full bg-clay-700 text-center">
            <span>{t('playerDetails.leaveConversation')}</span>
          </div>
        </a>
      )}
      {isExternalControlledNpc && (
        <a
          className="mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto"
          onClick={openNpcHistory}
        >
          <div className="h-full bg-clay-700 text-center">
            <span>{t('npcHistory.viewHistory')}</span>
          </div>
        </a>
      )}
      {isExternalControlledNpc && playerAgent && (
        <AgentEventQueueDebug
          externalEventQueue={playerAgent.externalEventQueue}
          externalPriorityQueue={playerAgent.externalPriorityQueue}
          externalQueueState={playerAgent.externalQueueState}
        />
      )}
      {!isMe && (
        <div className="box mt-6">
          <div className="bg-brown-700 p-3 sm:p-4 text-white">
            <p className="font-display text-lg sm:text-xl tracking-wide">Social Status</p>
            <div className="mt-2 inline-flex items-center rounded border border-clay-300/40 bg-clay-700 px-2 py-1 text-sm sm:text-base">
              <span>{relationshipBadge}</span>
            </div>

            <div className="mt-4">
              {normalizedAffinity === null ? (
                <p className="text-sm sm:text-base">暂无情感数据</p>
              ) : (
                <>
                  <p className="text-sm sm:text-base">[潜意识: {affinityLabel ?? '未知'}]</p>
                  <div className="mt-2 h-4 w-full rounded border border-clay-300/40 bg-clay-700 relative overflow-hidden">
                    <div className="absolute left-1/2 top-0 h-full w-px bg-clay-100/70" />
                    <div
                      className="absolute top-0 h-full"
                      style={{
                        marginLeft: `${affinityBarLeft}%`,
                        width: `${affinityBarWidth}%`,
                        backgroundColor: affinityBarColor,
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {haveInvite && (
        <>
          <a
            className={
              'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
              pendingSuffix('acceptInvite')
            }
            onClick={onAcceptInvite}
          >
            <div className="h-full bg-clay-700 text-center">
              <span>{t('playerDetails.accept')}</span>
            </div>
          </a>
          <a
            className={
              'mt-6 button text-white shadow-solid text-xl cursor-pointer pointer-events-auto' +
              pendingSuffix('rejectInvite')
            }
            onClick={onRejectInvite}
          >
            <div className="h-full bg-clay-700 text-center">
              <span>{t('playerDetails.reject')}</span>
            </div>
          </a>
        </>
      )}
      {!playerConversation && player.activity && player.activity.until > Date.now() && (
        <div className="box flex-grow mt-6">
          <h2 className="bg-brown-700 text-base sm:text-lg text-center">
            {translateActivityDescription(player.activity.description)}
          </h2>
        </div>
      )}
      <div className="desc my-6">
        <p className="leading-tight -m-4 bg-brown-700 text-base sm:text-sm">
          {!isMe && playerDescription?.description}
          {isMe && <i>{t('playerDetails.thisIsYou')}</i>}
          {!isMe && inConversationWithMe && (
            <>
              <br />
              <br />(<i>{t('playerDetails.conversingWithYou')}</i>)
            </>
          )}
        </p>
      </div>
      {!isMe && playerConversation && playerStatus?.kind === 'participating' && (
        <Messages
          worldId={worldId}
          engineId={engineId}
          inConversationWithMe={inConversationWithMe ?? false}
          conversation={{ kind: 'active', doc: playerConversation }}
          humanPlayer={humanPlayer}
          scrollViewRef={scrollViewRef}
        />
      )}
      {!playerConversation && previousConversation && (
        <>
          <div className="box flex-grow">
            <h2 className="bg-brown-700 text-lg text-center">{t('playerDetails.previousConversation')}</h2>
          </div>
          <Messages
            worldId={worldId}
            engineId={engineId}
            inConversationWithMe={false}
            conversation={{ kind: 'archived', doc: previousConversation }}
            humanPlayer={humanPlayer}
            scrollViewRef={scrollViewRef}
          />
        </>
      )}
      {isExternalControlledNpc && player && (
        <NpcHistoryDrawer
          isOpen={npcHistoryOpen}
          onClose={closeNpcHistory}
          worldId={worldId}
          npcPlayerId={player.id}
        />
      )}
    </>
  );
}
