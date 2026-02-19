import { FormEvent, useMemo, useState } from 'react';
import ReactModal from 'react-modal';
import { useAuth } from '../hooks/useAuth.tsx';

type AuthModalProps = {
  isOpen: boolean;
  onRequestClose: () => void;
  modalStyle: ReactModal.Styles;
};

type AuthTab = 'login' | 'register';

export default function AuthModal({ isOpen, onRequestClose, modalStyle }: AuthModalProps) {
  const { login, register } = useAuth();

  const [tab, setTab] = useState<AuthTab>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = useMemo(() => (tab === 'login' ? '登录 AstrTown' : '注册 AstrTown'), [tab]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setError('用户名不能为空');
      return;
    }
    if (!password) {
      setError('密码不能为空');
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      if (tab === 'login') {
        await login(trimmedUsername, password);
      } else {
        await register(trimmedUsername, password);
      }
      setPassword('');
      onRequestClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : '认证失败，请稍后重试';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const switchTab = (nextTab: AuthTab) => {
    if (nextTab === tab || isSubmitting) return;
    setTab(nextTab);
    setError(null);
  };

  return (
    <ReactModal
      isOpen={isOpen}
      onRequestClose={onRequestClose}
      style={modalStyle}
      contentLabel="Auth modal"
      ariaHideApp={false}
    >
      <div className="font-body min-w-[320px] w-[min(92vw,520px)]">
        <h2 className="text-center text-4xl sm:text-5xl font-bold font-display game-title mb-4">{title}</h2>

        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            className={`px-4 py-2 text-sm sm:text-base border-2 ${
              tab === 'login' ? 'border-white bg-clay-700 text-white' : 'border-slate-500 text-slate-300'
            }`}
            onClick={() => switchTab('login')}
            disabled={isSubmitting}
          >
            登录
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm sm:text-base border-2 ${
              tab === 'register' ? 'border-white bg-clay-700 text-white' : 'border-slate-500 text-slate-300'
            }`}
            onClick={() => switchTab('register')}
            disabled={isSubmitting}
          >
            注册
          </button>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="block text-sm mb-1">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isSubmitting}
              autoComplete="username"
              className="w-full px-3 py-2 bg-slate-900 border border-slate-500 text-white outline-none focus:border-white"
            />
          </div>

          <div>
            <label className="block text-sm mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
              autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-500 text-white outline-none focus:border-white"
            />
          </div>

          {error ? <p className="text-red-400 text-sm">{error}</p> : null}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onRequestClose}
              disabled={isSubmitting}
              className="px-4 py-2 border border-slate-500 text-slate-300 disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 border border-white bg-clay-700 text-white disabled:opacity-60"
            >
              {isSubmitting ? '提交中...' : tab === 'login' ? '登录' : '注册'}
            </button>
          </div>
        </form>
      </div>
    </ReactModal>
  );
}

