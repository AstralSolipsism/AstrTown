import { useEffect, useMemo, useState } from 'react';
import { useQuery as useConvexQuery } from 'convex/react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import ConversationTree from './ConversationTree';
import { ConversationGroup } from './ConversationGroupItem';

type NpcHistoryDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  worldId: Id<'worlds'>;
  npcPlayerId: string;
  referenceTime?: number;
};

type NpcConversationHistory = {
  npcPlayerId: string;
  npcName: string | null;
  groups: ConversationGroup[];
};

const npcHistoryApi = (api as any).npcHistory;

export default function NpcHistoryDrawer({
  isOpen,
  onClose,
  worldId,
  npcPlayerId,
  referenceTime,
}: NpcHistoryDrawerProps) {
  const { t } = useTranslation();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const timezoneOffsetMinutes = useMemo(() => new Date().getTimezoneOffset(), []);

  useEffect(() => {
    if (!isOpen) {
      setSelectedConversationId(null);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedConversationId(null);
  }, [npcPlayerId]);

  const history = useConvexQuery(
    npcHistoryApi.getNpcConversationHistory,
    isOpen
      ? {
          worldId,
          npcPlayerId,
          timezoneOffsetMinutes,
          referenceTime,
        }
      : 'skip',
  ) as NpcConversationHistory | null | undefined;

  const npcDisplayName = history?.npcName ?? npcPlayerId;

  const toggleSelectedConversation = (conversationId: string) => {
    setSelectedConversationId((current) => (current === conversationId ? null : conversationId));
  };

  const drawer = (
    <div className="fixed inset-y-0 right-0 z-[60] pointer-events-none">
      <aside
        className={`h-full w-[min(92vw,420px)] min-w-0 border-l-8 border-brown-900 bg-brown-800/95 text-brown-100 shadow-2xl transition-transform duration-300 ease-out flex flex-col ${
          isOpen ? 'translate-x-0 pointer-events-auto' : 'translate-x-full pointer-events-none'
        }`}
      >
        <div className="px-4 sm:px-5 py-4 border-b-4 border-brown-900 bg-brown-700/90">
          <div className="flex items-start justify-between gap-3 min-w-0">
            <h2 className="font-display game-title text-2xl sm:text-3xl leading-none min-w-0 break-words [overflow-wrap:anywhere]">
              {npcDisplayName} · {t('npcHistory.drawerTitle')}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 border border-slate-400 text-slate-100 hover:bg-slate-700/50 transition-colors shrink-0"
            >
              {t('npcHistory.close')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 min-w-0">
          {history === undefined ? (
            <div className="p-3 border border-slate-700 bg-slate-900/50 text-slate-300 break-words [overflow-wrap:anywhere]">
              {t('npcHistory.loading')}
            </div>
          ) : history === null ? (
            <div className="p-3 border border-slate-700 bg-slate-900/50 text-slate-300 break-words [overflow-wrap:anywhere]">
              {t('npcHistory.emptyAvailable')}
            </div>
          ) : (
            <ConversationTree
              groups={history.groups}
              worldId={worldId}
              npcPlayerId={npcPlayerId}
              selectedConversationId={selectedConversationId}
              onSelectConversation={toggleSelectedConversation}
            />
          )}
        </div>
      </aside>
    </div>
  );

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(drawer, document.body);
}
