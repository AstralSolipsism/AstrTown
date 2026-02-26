import ReactModal from 'react-modal';
import { useTranslation } from 'react-i18next';
import type { ExternalEventItem, ExternalQueueState } from '../../convex/aiTown/agent';
import AgentEventQueueDebug from './AgentEventQueueDebug';

export type ActionQueueModalProps = {
  isOpen: boolean;
  onRequestClose: () => void;
  modalStyle: ReactModal.Styles;
  externalEventQueue: ExternalEventItem[];
  externalPriorityQueue: ExternalEventItem[];
  externalQueueState: ExternalQueueState | undefined;
};

export default function ActionQueueModal({
  isOpen,
  onRequestClose,
  modalStyle,
  externalEventQueue,
  externalPriorityQueue,
  externalQueueState,
}: ActionQueueModalProps) {
  const { t } = useTranslation();

  return (
    <ReactModal
      isOpen={isOpen}
      onRequestClose={onRequestClose}
      style={modalStyle}
      contentLabel={t('playerDetails.actionQueueModal.modalLabel')}
      ariaHideApp={false}
    >
      <div className="min-w-[min(90vw,720px)] max-w-[960px]">
        <div className="mb-4 flex items-start justify-between gap-3 border-b-4 border-brown-900 pb-3">
          <h2 className="font-display game-title text-3xl sm:text-4xl">
            {t('playerDetails.actionQueueModal.title')}
          </h2>
          <button
            type="button"
            onClick={onRequestClose}
            className="px-3 py-1 border border-slate-400 text-slate-100 hover:bg-slate-700/50 transition-colors"
          >
            {t('playerDetails.actionQueueModal.close')}
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto pr-1">
          <AgentEventQueueDebug
            externalEventQueue={externalEventQueue}
            externalPriorityQueue={externalPriorityQueue}
            externalQueueState={externalQueueState}
          />
        </div>
      </div>
    </ReactModal>
  );
}
