import { useEffect, useMemo, useState } from 'react';
import ReactModal from 'react-modal';
import { useNpcService } from '../hooks/useNpcService.tsx';

type NpcManageModalProps = {
  isOpen: boolean;
  onRequestClose: () => void;
  modalStyle: ReactModal.Styles;
};

function maskToken(token: string): string {
  if (!token) return 'astr_****...****';
  if (token.length <= 12) {
    return `${token.slice(0, 2)}****${token.slice(-2)}`;
  }
  return `${token.slice(0, 6)}****...****${token.slice(-4)}`;
}

export default function NpcManageModal({ isOpen, onRequestClose, modalStyle }: NpcManageModalProps) {
  const { npcs, isLoading, createNpc, getToken, resetToken, refreshList } = useNpcService();

  const [createName, setCreateName] = useState('');
  const [createCharacter, setCreateCharacter] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [pendingTokenId, setPendingTokenId] = useState<string | null>(null);
  const [displayToken, setDisplayToken] = useState<string | null>(null);
  const [displayTokenId, setDisplayTokenId] = useState<string | null>(null);
  const [showPlainToken, setShowPlainToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDisplayToken(null);
    setDisplayTokenId(null);
    setShowPlainToken(false);
    setCopyMessage(null);

    let canceled = false;
    const load = async () => {
      setError(null);
      try {
        await refreshList();
      } catch (e) {
        if (canceled) return;
        const message = e instanceof Error ? e.message : '加载 NPC 列表失败';
        setError(message);
      }
    };
    void load();

    return () => {
      canceled = true;
    };
  }, [isOpen, refreshList]);

  const selectedNpc = useMemo(() => {
    if (!displayTokenId) return null;
    return npcs.find((item) => item.botTokenId === displayTokenId) ?? null;
  }, [displayTokenId, npcs]);

  const handleRefreshList = async () => {
    if (isLoading || pendingTokenId) return;
    setError(null);
    try {
      await refreshList();
    } catch (e) {
      const message = e instanceof Error ? e.message : '加载 NPC 列表失败';
      setError(message);
    }
  };

  const handleCreateNpc = async () => {
    if (isCreating) return;

    const name = createName.trim();
    if (!name) {
      setError('NPC 名称不能为空');
      return;
    }

    setError(null);
    setCopyMessage(null);
    setIsCreating(true);
    try {
      const result = await createNpc(name, createCharacter.trim() ? createCharacter.trim() : undefined);
      setDisplayToken(result.token);
      setDisplayTokenId(null);
      setShowPlainToken(false);
      setCreateName('');
      setCreateCharacter('');
      await refreshList();
    } catch (e) {
      const message = e instanceof Error ? e.message : '创建 NPC 失败';
      setError(message);
    } finally {
      setIsCreating(false);
    }
  };

  const handleViewToken = async (botTokenId: string) => {
    if (pendingTokenId) return;
    setError(null);
    setCopyMessage(null);
    setPendingTokenId(botTokenId);
    try {
      const token = await getToken(botTokenId);
      setDisplayToken(token);
      setDisplayTokenId(botTokenId);
      setShowPlainToken(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : '获取 Token 失败';
      setError(message);
    } finally {
      setPendingTokenId(null);
    }
  };

  const handleResetToken = async (botTokenId: string) => {
    if (pendingTokenId) return;
    setError(null);
    setCopyMessage(null);
    setPendingTokenId(botTokenId);
    try {
      const token = await resetToken(botTokenId);
      setDisplayToken(token);
      setDisplayTokenId(botTokenId);
      setShowPlainToken(false);
      await refreshList();
    } catch (e) {
      const message = e instanceof Error ? e.message : '重置 Token 失败';
      setError(message);
    } finally {
      setPendingTokenId(null);
    }
  };

  const handleCopyToken = async () => {
    if (!displayToken) return;
    setCopyMessage(null);

    try {
      await navigator.clipboard.writeText(displayToken);
      setCopyMessage('Token 已复制');
    } catch {
      setError('复制失败，请手动复制');
    }
  };

  return (
    <ReactModal
      isOpen={isOpen}
      onRequestClose={onRequestClose}
      style={modalStyle}
      contentLabel="NPC manage modal"
      ariaHideApp={false}
    >
      <div className="font-body w-[min(95vw,900px)] max-h-[80vh] overflow-y-auto">
        <h2 className="text-center text-4xl sm:text-5xl font-bold font-display game-title mb-4">我的 NPC</h2>

        <div className="mb-4 p-3 border border-slate-600 bg-slate-900/60">
          <p className="text-sm mb-2">创建新 NPC</p>
          <div className="grid gap-2 sm:grid-cols-3">
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              disabled={isCreating}
              placeholder="NPC 名称"
              className="px-3 py-2 bg-slate-900 border border-slate-500 text-white outline-none focus:border-white"
            />
            <input
              type="text"
              value={createCharacter}
              onChange={(e) => setCreateCharacter(e.target.value)}
              disabled={isCreating}
              placeholder="character（可选）"
              className="px-3 py-2 bg-slate-900 border border-slate-500 text-white outline-none focus:border-white"
            />
            <button
              type="button"
              onClick={handleCreateNpc}
              disabled={isCreating}
              className="px-3 py-2 border border-white bg-clay-700 text-white disabled:opacity-60"
            >
              {isCreating ? '创建中...' : '创建 NPC'}
            </button>
          </div>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm">NPC 列表</p>
            <button
              type="button"
              onClick={() => void handleRefreshList()}
              disabled={isLoading || !!pendingTokenId}
              className="px-3 py-1 border border-slate-400 text-slate-200 text-sm disabled:opacity-60"
            >
              刷新
            </button>
          </div>

          <div className="border border-slate-700 divide-y divide-slate-700">
            {npcs.length === 0 ? (
              <div className="p-3 text-sm text-slate-300">暂无 NPC</div>
            ) : (
              npcs.map((npc) => (
                <div key={npc.botTokenId} className="p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-base text-white">{npc.name ?? '未命名 NPC'}</p>
                    <p className="text-xs text-slate-300">agentId: {npc.agentId}</p>
                    <p className="text-xs text-slate-300">状态: {npc.tokenStatus}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleViewToken(npc.botTokenId)}
                      disabled={pendingTokenId === npc.botTokenId}
                      className="px-3 py-1 border border-slate-400 text-slate-100 text-sm disabled:opacity-60"
                    >
                      {pendingTokenId === npc.botTokenId ? '读取中...' : '查看 Token'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleResetToken(npc.botTokenId)}
                      disabled={pendingTokenId === npc.botTokenId}
                      className="px-3 py-1 border border-white bg-clay-700 text-white text-sm disabled:opacity-60"
                    >
                      {pendingTokenId === npc.botTokenId ? '重置中...' : '重置 Token'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="p-3 border border-slate-600 bg-slate-900/50">
          <p className="text-sm mb-2">Token 展示</p>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="block px-3 py-2 bg-black/50 border border-slate-700 text-green-300 break-all min-h-[42px] flex-1">
              {displayToken ? (showPlainToken ? displayToken : maskToken(displayToken)) : '尚未选择 Token'}
            </code>
            <button
              type="button"
              onClick={() => setShowPlainToken((v) => !v)}
              disabled={!displayToken}
              className="px-3 py-2 border border-slate-400 text-slate-100 text-sm disabled:opacity-50"
            >
              {showPlainToken ? '隐藏' : '显示'}
            </button>
            <button
              type="button"
              onClick={() => void handleCopyToken()}
              disabled={!displayToken}
              className="px-3 py-2 border border-white bg-clay-700 text-white text-sm disabled:opacity-50"
            >
              复制
            </button>
          </div>
          {selectedNpc ? <p className="text-xs text-slate-400 mt-2">当前 NPC: {selectedNpc.name ?? selectedNpc.agentId}</p> : null}
          {copyMessage ? <p className="text-green-400 text-sm mt-2">{copyMessage}</p> : null}
        </div>

        {error ? <p className="text-red-400 text-sm mt-3">{error}</p> : null}

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onRequestClose}
            className="px-4 py-2 border border-slate-400 text-slate-100"
          >
            关闭
          </button>
        </div>
      </div>
    </ReactModal>
  );
}

