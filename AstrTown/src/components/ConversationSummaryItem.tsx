import { useTranslation } from 'react-i18next';

type TimeLabel = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

export type ConversationSummary = {
  conversationId: string;
  created: number;
  ended: number;
  numMessages: number;
  participants: string[];
  timeLabel: TimeLabel;
};

type ConversationSummaryItemProps = {
  summary: ConversationSummary;
  participantPreview: string;
  onClick: (conversationId: string) => void;
};

const timeLabelClass: Record<TimeLabel, string> = {
  today: 'bg-green-800/40 text-green-200 border-green-400/30',
  yesterday: 'bg-sky-800/40 text-sky-200 border-sky-400/30',
  thisWeek: 'bg-amber-800/40 text-amber-200 border-amber-400/30',
  earlier: 'bg-slate-800/60 text-slate-200 border-slate-500/40',
};

const timeLabelI18nKeyByValue: Record<TimeLabel, string> = {
  today: 'npcHistory.timeLabel.today',
  yesterday: 'npcHistory.timeLabel.yesterday',
  thisWeek: 'npcHistory.timeLabel.thisWeek',
  earlier: 'npcHistory.timeLabel.earlier',
};

export default function ConversationSummaryItem({
  summary,
  participantPreview,
  onClick,
}: ConversationSummaryItemProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={() => onClick(summary.conversationId)}
      className="w-full min-w-0 text-left p-3 border border-slate-700 bg-slate-900/50 hover:bg-slate-800/70 transition-colors"
    >
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span
          className={`inline-flex items-center px-2 py-0.5 text-xs border ${timeLabelClass[summary.timeLabel]}`}
        >
          {t(timeLabelI18nKeyByValue[summary.timeLabel])}
        </span>
        <time className="text-xs text-slate-300 break-all" dateTime={summary.ended.toString()}>
          {new Date(summary.ended).toLocaleString()}
        </time>
      </div>

      <div className="text-xs text-slate-400 break-words [overflow-wrap:anywhere]">{participantPreview}</div>

      <div className="mt-2 text-xs text-slate-400">{t('npcHistory.messageCount', { count: summary.numMessages })}</div>
    </button>
  );
}

