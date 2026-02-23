import { useMutation, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import Button from './buttons/Button';
import starImg from '../../assets/star.svg';
import { useTranslation } from 'react-i18next';

export default function FreezeButton() {
  const { t } = useTranslation();
  const stopAllowed = useQuery(api.testing.stopAllowed) ?? false;
  const defaultWorld = useQuery(api.world.defaultWorldStatus);

  const frozen = defaultWorld?.status === 'stoppedByDeveloper';

  const unfreeze = useMutation(api.testing.resume);
  const freeze = useMutation(api.testing.stop);

  const flipSwitch = async () => {
    if (frozen) {
      console.log('Unfreezing');
      await unfreeze();
    } else {
      console.log('Freezing');
      await freeze();
    }
  };

  return !stopAllowed ? null : (
    <>
      <Button
        onClick={flipSwitch}
        className="hidden lg:block"
        title={t('freeze.title')}
        imgUrl={starImg}
      >
        {frozen ? t('freeze.unfreeze') : t('freeze.button')}
      </Button>
    </>
  );
}
