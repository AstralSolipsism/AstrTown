import Game from './components/Game.tsx';

import { ToastContainer } from 'react-toastify';
import a16zImg from '../assets/a16z.png';
import convexImg from '../assets/convex.svg';
import starImg from '../assets/star.svg';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import MusicButton from './components/buttons/MusicButton.tsx';
import Button from './components/buttons/Button.tsx';
import FreezeButton from './components/FreezeButton.tsx';
import PoweredByConvex from './components/PoweredByConvex.tsx';
import { useAuth } from './hooks/useAuth.tsx';
import AuthModal from './components/AuthModal.tsx';
import NpcManageModal from './components/NpcManageModal.tsx';
import { modalStyles } from './components/modalStyles.ts';

export default function Home() {
  const { t } = useTranslation();
  const { user, isLoading, logout } = useAuth();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [npcModalOpen, setNpcModalOpen] = useState(false);

  const onLogout = () => {
    void logout();
  };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-between font-body game-background">
      <PoweredByConvex />

      <AuthModal
        isOpen={authModalOpen}
        onRequestClose={() => setAuthModalOpen(false)}
        modalStyle={modalStyles}
      />

      <NpcManageModal
        isOpen={npcModalOpen}
        onRequestClose={() => setNpcModalOpen(false)}
        modalStyle={modalStyles}
      />

      <div className="p-3 absolute top-0 right-0 z-10 text-sm sm:text-base flex items-center gap-2">
        {isLoading ? (
          <button
            type="button"
            disabled
            className="button text-white shadow-solid pointer-events-auto opacity-60"
          >
            <div className="inline-block bg-clay-700">
              <span>{t('app.loading')}</span>
            </div>
          </button>
        ) : user ? (
          <>
            <span className="text-white shadow-solid pointer-events-none px-2">{user.username}</span>
            <button
              type="button"
              className="button text-white shadow-solid pointer-events-auto"
              onClick={() => setNpcModalOpen(true)}
            >
              <div className="inline-block bg-clay-700">
                <span>{t('app.myNpc')}</span>
              </div>
            </button>
            <button
              type="button"
              className="button text-white shadow-solid pointer-events-auto"
              onClick={onLogout}
            >
              <div className="inline-block bg-clay-700">
                <span>{t('app.logout')}</span>
              </div>
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button text-white shadow-solid pointer-events-auto"
            onClick={() => setAuthModalOpen(true)}
          >
            <div className="inline-block bg-clay-700">
              <span>{t('app.login')}</span>
            </div>
          </button>
        )}
      </div>

      <div className="w-full lg:h-screen min-h-screen relative isolate overflow-hidden lg:p-8 shadow-2xl flex flex-col justify-start">
        <h1 className="mx-auto text-4xl p-3 sm:text-8xl lg:text-9xl font-bold font-display leading-none tracking-wide game-title w-full text-left sm:text-center sm:w-auto">
          {t('app.title')}
        </h1>

        <div className="max-w-xs md:max-w-xl lg:max-w-none mx-auto my-4 text-center text-base sm:text-xl md:text-2xl text-white leading-tight shadow-solid">
          {t('app.subtitle')}
        </div>

        <Game />

        <footer className="justify-end bottom-0 left-0 w-full flex items-center mt-4 gap-3 p-6 flex-wrap pointer-events-none">
          <div className="flex gap-4 flex-grow pointer-events-none">
            <FreezeButton />
            <MusicButton />
            <a
              href="/map-editor/le.html"
              target="_blank"
              rel="noopener noreferrer"
              className="button text-white shadow-solid text-xl pointer-events-auto"
            >
              <div className="inline-block bg-clay-700">
                <span>地图编辑器</span>
              </div>
            </a>
            <Button href="https://github.com/a16z-infra/ai-town" imgUrl={starImg}>
              {t('app.star')}
            </Button>
          </div>
          <a href="https://a16z.com">
            <img className="w-8 h-8 pointer-events-auto" src={a16zImg} alt="a16z" />
          </a>
          <a href="https://convex.dev/c/ai-town">
            <img className="w-20 h-8 pointer-events-auto" src={convexImg} alt="Convex" />
          </a>
        </footer>
        <ToastContainer position="bottom-right" autoClose={2000} closeOnClick theme="dark" />
      </div>
    </main>
  );
}

