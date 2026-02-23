import ConversationGroupItem, { ConversationGroup } from './ConversationGroupItem';
import { useTranslation } from 'react-i18next';
import { Id } from '../../convex/_generated/dataModel';

type ConversationTreeProps = {
  groups: ConversationGroup[];
  worldId: Id<'worlds'>;
  npcPlayerId: string;
  selectedConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
};

export default function ConversationTree({
  groups,
  worldId,
  npcPlayerId,
  selectedConversationId,
  onSelectConversation,
}: ConversationTreeProps) {
  const { t } = useTranslation();

  if (groups.length === 0) {
    return (
      <div className="p-3 border border-slate-700 bg-slate-900/50 text-slate-300 break-words [overflow-wrap:anywhere]">
        {t('npcHistory.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-3 min-w-0">
      {groups.map((group) => (
        <ConversationGroupItem
          key={group.otherPlayerId}
          group={group}
          worldId={worldId}
          npcPlayerId={npcPlayerId}
          selectedConversationId={selectedConversationId}
          onSelectConversation={onSelectConversation}
        />
      ))}
    </div>
  );
}

