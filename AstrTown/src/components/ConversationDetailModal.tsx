import clsx from 'clsx';
import { useQuery as useConvexQuery } from 'convex/react';
import { useTranslation } from 'react-i18next';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';

type MessageWithAuthor = {
  _id: string;
  _creationTime: number;
  conversationId: string;
  author: string;
  authorName: string | null;
  text: string;
  messageUuid: string;
};

type ConversationDetail = {
  conversationId: string;
  created: number;
  ended: number;
  numMessages: number;
  participants: string[];
  messages: MessageWithAuthor[];
};

type ConversationDetailModalProps = {
  worldId: Id<'worlds'>;
  npcPlayerId: string;
  conversationId: string | null;
  highlightAuthorId?: string;
  onClose: () => void;
};

const npcHistoryApi = (api as any).npcHistory;

export default function ConversationDetailModal({
  worldId,
  npcPlayerId,
  conversationId,
  highlightAuthorId,
  onClose,
}: ConversationDetailModalProps) {
  const { t } = useTranslation();

  const detail = useConvexQuery(
    npcHistoryApi.getConversationDetail,
    conversationId ? { worldId, conversationId, npcPlayerId } : 'skip',
  ) as ConversationDetail | null | undefined;

  if (!conversationId) {
    return null;
  }

  return (
    <div className="border border-slate-600 bg-slate-950/40 p-3 sm:p-4 font-body min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h3 className="font-display game-title text-2xl sm:text-3xl">{t('npcHistory.detailTitle')}</h3>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 border border-slate-400 text-slate-100"
        >
          {t('npcHistory.collapseDetail')}
        </button>
      </div>

      <div className="text-xs text-slate-300 mb-3 break-words [overflow-wrap:anywhere]">
        {detail && (
          <>
            <span>{t('npcHistory.detailStart', { time: new Date(detail.created).toLocaleString() })}</span>
            <span className="mx-2">|</span>
            <span>{t('npcHistory.detailEnd', { time: new Date(detail.ended).toLocaleString() })}</span>
            <span className="mx-2">|</span>
            <span>{t('npcHistory.messageCount', { count: detail.numMessages })}</span>
          </>
        )}
      </div>

      {detail === undefined ? (
        <div className="p-3 border border-slate-700 bg-slate-900/50 text-slate-300 break-words [overflow-wrap:anywhere]">
          {t('npcHistory.detailLoading')}
        </div>
      ) : detail === null || Array.isArray(detail) ? (
        <div className="p-3 border border-slate-700 bg-slate-900/50 text-slate-300 break-words [overflow-wrap:anywhere]">
          {t('npcHistory.detailNotFound')}
        </div>
      ) : (
        <div className="chats text-base sm:text-sm min-w-0">
          <div className="bg-brown-200 text-black p-2">
            {detail.messages.map((m) => (
              <div key={`${m._id}-${m.messageUuid}`} className="leading-tight mb-6">
                <div className="flex flex-wrap gap-2 sm:gap-4">
                  <span className="uppercase flex-grow min-w-0 break-all">{m.authorName ?? m.author}</span>
                  <time className="text-xs sm:text-sm shrink-0" dateTime={m._creationTime.toString()}>
                    {new Date(m._creationTime).toLocaleString()}
                  </time>
                </div>
                <div className={clsx('bubble', m.author === highlightAuthorId && 'bubble-mine')}>
                  <p className="bg-white -mx-3 -my-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {m.text}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

