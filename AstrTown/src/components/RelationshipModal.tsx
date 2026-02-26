import ReactModal from 'react-modal';
import { useTranslation } from 'react-i18next';

export type RelationshipModalProps = {
  isOpen: boolean;
  onRequestClose: () => void;
  modalStyle: ReactModal.Styles;
  relationshipBadge: string;
  affinityLabel?: string;
  normalizedAffinity: number | null;
  affinityBarLeft: number;
  affinityBarWidth: number;
  affinityBarColor: string;
};

export default function RelationshipModal({
  isOpen,
  onRequestClose,
  modalStyle,
  relationshipBadge,
  affinityLabel,
  normalizedAffinity,
  affinityBarLeft,
  affinityBarWidth,
  affinityBarColor,
}: RelationshipModalProps) {
  const { t } = useTranslation();

  return (
    <ReactModal
      isOpen={isOpen}
      onRequestClose={onRequestClose}
      style={modalStyle}
      contentLabel={t('playerDetails.relationshipModal.modalLabel')}
      ariaHideApp={false}
    >
      <div className="min-w-[min(90vw,640px)] max-w-[820px]">
        <div className="mb-4 flex items-start justify-between gap-3 border-b-4 border-brown-900 pb-3">
          <h2 className="font-display game-title text-3xl sm:text-4xl">
            {t('playerDetails.relationshipModal.title')}
          </h2>
          <button
            type="button"
            onClick={onRequestClose}
            className="px-3 py-1 border border-slate-400 text-slate-100 hover:bg-slate-700/50 transition-colors"
          >
            {t('playerDetails.relationshipModal.close')}
          </button>
        </div>

        <div className="box overflow-hidden">
          <div className="bg-brown-700 p-3 sm:p-4 text-white">
            <p className="font-display text-lg sm:text-xl tracking-wide">
              {t('playerDetails.relationshipModal.statusTitle')}
            </p>
            <div className="mt-2 inline-flex items-center rounded border border-clay-300/40 bg-clay-700 px-2 py-1 text-sm sm:text-base">
              <span>{relationshipBadge}</span>
            </div>

            <div className="mt-4">
              {normalizedAffinity === null ? (
                <p className="text-sm sm:text-base">{t('playerDetails.relationshipModal.noAffinityData')}</p>
              ) : (
                <>
                  <p className="text-sm sm:text-base">
                    [{t('playerDetails.relationshipModal.affinityLabelPrefix')}: {' '}
                    {affinityLabel ?? t('playerDetails.relationshipModal.affinityUnknown')}]
                  </p>
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
      </div>
    </ReactModal>
  );
}
