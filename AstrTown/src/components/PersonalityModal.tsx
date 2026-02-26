import ReactModal from 'react-modal';
import { useTranslation } from 'react-i18next';

export type PersonalityModalProps = {
  isOpen: boolean;
  onRequestClose: () => void;
  modalStyle: ReactModal.Styles;
  playerName?: string;
  personalityDescription?: string;
};

export default function PersonalityModal({
  isOpen,
  onRequestClose,
  modalStyle,
  playerName,
  personalityDescription,
}: PersonalityModalProps) {
  const { t } = useTranslation();
  const displayName = playerName?.trim();
  const description = personalityDescription?.trim();

  return (
    <ReactModal
      isOpen={isOpen}
      onRequestClose={onRequestClose}
      style={modalStyle}
      contentLabel={t('playerDetails.personalityModal.modalLabel')}
      ariaHideApp={false}
    >
      <div className="min-w-[min(90vw,640px)] max-w-[820px]">
        <div className="mb-4 flex items-start justify-between gap-3 border-b-4 border-brown-900 pb-3">
          <h2 className="font-display game-title text-3xl sm:text-4xl">
            {t('playerDetails.personalityModal.title')}
          </h2>
          <button
            type="button"
            onClick={onRequestClose}
            className="px-3 py-1 border border-slate-400 text-slate-100 hover:bg-slate-700/50 transition-colors"
          >
            {t('playerDetails.personalityModal.close')}
          </button>
        </div>

        <div className="space-y-3 text-base sm:text-lg">
          {displayName && <p className="text-clay-100/90">{displayName}</p>}
          <div className="border border-clay-300/40 bg-black/20 p-3 break-words [overflow-wrap:anywhere] leading-relaxed">
            {description ? (
              <p className="text-clay-100">{description}</p>
            ) : (
              <p className="text-slate-300">{t('playerDetails.personalityModal.empty')}</p>
            )}
          </div>
        </div>
      </div>
    </ReactModal>
  );
}
