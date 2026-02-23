import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Id } from '../../convex/_generated/dataModel';
import ConversationSummaryItem, { ConversationSummary } from './ConversationSummaryItem';
import ConversationDetailModal from './ConversationDetailModal';

type TimeLabel = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

export type ConversationGroup = {
  otherPlayerId: string;
  otherPlayerName: string | null;
  isNpc: boolean;
  byTime: Record<TimeLabel, ConversationSummary[]>;
};

type ConversationGroupItemProps = {
  group: ConversationGroup;
  worldId: Id<'worlds'>;
  npcPlayerId: string;
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
};

const timeOrder: TimeLabel[] = ['today', 'yesterday', 'thisWeek', 'earlier'];

const timeLabelI18nKeyByValue: Record<TimeLabel, string> = {
  today: 'npcHistory.timeLabel.today',
  yesterday: 'npcHistory.timeLabel.yesterday',
  thisWeek: 'npcHistory.timeLabel.thisWeek',
  earlier: 'npcHistory.timeLabel.earlier',
};

export default function ConversationGroupItem({
  group,
  worldId,
  npcPlayerId,
  selectedConversationId,
  onSelectConversation,
}: ConversationGroupItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const count = useMemo(
    () => timeOrder.reduce((acc, label) => acc + group.byTime[label].length, 0),
    [group.byTime],
  );

  return (
    <div className="border border-slate-600 bg-slate-900/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full p-3 flex items-center justify-between gap-3 text-left hover:bg-slate-800/60 transition-colors"
      >
        <div className="min-w-0">
          <div className="text-base text-white break-words [overflow-wrap:anywhere]">
            {group.otherPlayerName ?? group.otherPlayerId}
            {group.isNpc && <span className="ml-2 text-xs text-clay-100/90">{t('npcHistory.npcTag')}</span>}
          </div>
          <div className="text-xs text-slate-300">{t('npcHistory.conversationCount', { count })}</div>
        </div>
        <span className="text-slate-200 text-sm shrink-0">
          {expanded ? t('npcHistory.collapse') : t('npcHistory.expand')}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 min-w-0">
          {timeOrder.map((label) => {
            const items = group.byTime[label];
            if (items.length === 0) {
              return null;
            }
            return (
              <div key={label}>
                <div className="text-xs text-slate-300 mb-2">{t(timeLabelI18nKeyByValue[label])}</div>
                <div className="space-y-2">
                  {items.map((summary) => (
                    <div key={`${summary.conversationId}-${summary.ended}`} className="space-y-2">
                      <ConversationSummaryItem
                        summary={summary}
                        participantPreview={t('npcHistory.participantPrefix', {
                          names: summary.participants
                            .map((p) => (p === npcPlayerId ? t('npcHistory.currentNpc') : p))
                            .join('、'),
                        })}
                        onClick={onSelectConversation}
                      />
                      {selectedConversationId === summary.conversationId && (
                        <ConversationDetailModal
                          worldId={worldId}
                          npcPlayerId={npcPlayerId}
                          conversationId={selectedConversationId}
                          highlightAuthorId={npcPlayerId}
                          onClose={() => onSelectConversation(summary.conversationId)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

