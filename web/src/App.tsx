import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchPersonas,
  MODEL_LIST,
  MODELS,
  type Backend,
  type ModelId,
  type Persona,
} from './models';
import type {
  ConversationTurn,
  WorkerRequest,
  WorkerResponse,
} from './inference/protocol';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: number;
  model?: string;
  persona?: string;
  elapsedMs?: number;
  pending?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface ChatStore {
  activeId: string;
  chats: ChatSession[];
}

type Status = 'idle' | 'loading' | 'ready' | 'generating' | 'error';

interface ProgressState {
  file: string;
  loaded: number;
  total: number;
  progress: number;
}

const DEFAULT_PERSONA: Persona = { id: 'anonymous', label: '匿名（おすすめ）', prompt: '<|other|>' };
const HISTORY_KEY = 'evex-chat-history-v1';
const LEGACY_SESSION_KEY = 'evex-chat-session-v1';

function makeWorker(): Worker {
  return new Worker(new URL('./inference/worker.ts', import.meta.url), { type: 'module' });
}

function initialModel(): ModelId {
  const saved = localStorage.getItem('evex-model');
  return saved && saved in MODELS ? (saved as ModelId) : 'evex-2';
}

function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!first) return '新しいチャット';
  const title = first.content.replace(/\s+/g, ' ').trim();
  return title.length > 30 ? `${title.slice(0, 30)}…` : title;
}

function createChat(messages: ChatMessage[] = []): ChatSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: titleFromMessages(messages),
    createdAt: now,
    updatedAt: now,
    messages,
  };
}

function validMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (message): message is ChatMessage =>
      Boolean(
        message &&
          typeof message === 'object' &&
          'id' in message &&
          typeof message.id === 'string' &&
          'role' in message &&
          (message.role === 'user' || message.role === 'assistant') &&
          'content' in message &&
          typeof message.content === 'string',
      ),
  );
}

function initialChatStore(): ChatStore {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? 'null') as Partial<ChatStore> | null;
    if (stored && Array.isArray(stored.chats) && stored.chats.length) {
      const chats = stored.chats
        .filter((chat): chat is ChatSession => Boolean(chat && typeof chat.id === 'string'))
        .map((chat) => ({
          ...chat,
          title: typeof chat.title === 'string' ? chat.title : '新しいチャット',
          createdAt: Number(chat.createdAt) || Date.now(),
          updatedAt: Number(chat.updatedAt) || Date.now(),
          messages: validMessages(chat.messages).filter((message) => !message.pending),
        }));
      if (chats.length) {
        return {
          activeId: chats.some((chat) => chat.id === stored.activeId) ? String(stored.activeId) : chats[0].id,
          chats,
        };
      }
    }
  } catch {
    // Fall through to the previous single-session format.
  }

  let legacyMessages: ChatMessage[] = [];
  try {
    legacyMessages = validMessages(JSON.parse(sessionStorage.getItem(LEGACY_SESSION_KEY) ?? '[]'))
      .filter((message) => !message.pending);
  } catch {
    legacyMessages = [];
  }
  const chat = createChat(legacyMessages);
  return { activeId: chat.id, chats: [chat] };
}

function formatBytes(value: number): string {
  if (!value) return '0 MB';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 2).toFixed(value < 100 * 1024 ** 2 ? 0 : 1)} MB`;
}

function historyDate(value: number): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return '今日';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨日';
  return new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric' }).format(date);
}

export function App() {
  const workerRef = useRef<Worker | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [chatStore, setChatStore] = useState<ChatStore>(initialChatStore);
  const [modelId, setModelId] = useState<ModelId>(initialModel);
  const model = MODELS[modelId];
  const [backend, setBackend] = useState<Backend>(model.format === 'qwen3-transformers' ? 'webgpu' : 'auto');
  const [personas, setPersonas] = useState<Persona[]>([DEFAULT_PERSONA]);
  const [personasLoading, setPersonasLoading] = useState(false);
  const [personaEnabled, setPersonaEnabled] = useState(false);
  const [personaId, setPersonaId] = useState('anonymous');
  const selectedPersona = personas.find((item) => item.id === personaId) ?? personas[0] ?? DEFAULT_PERSONA;
  const persona = personaEnabled && model.supportsPersonas
    ? selectedPersona
    : personas[0] ?? DEFAULT_PERSONA;
  const [status, setStatus] = useState<Status>('idle');
  const [loadedModel, setLoadedModel] = useState<ModelId | null>(null);
  const [loadedBackend, setLoadedBackend] = useState<string>('');
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [cacheBytes, setCacheBytes] = useState(0);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const activeChat = chatStore.chats.find((chat) => chat.id === chatStore.activeId) ?? chatStore.chats[0];
  const messages = activeChat?.messages ?? [];

  const setMessages = useCallback(
    (update: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
      setChatStore((current) => ({
        ...current,
        chats: current.chats.map((chat) => {
          if (chat.id !== current.activeId) return chat;
          const nextMessages = typeof update === 'function' ? update(chat.messages) : update;
          return {
            ...chat,
            title: titleFromMessages(nextMessages),
            updatedAt: Date.now(),
            messages: nextMessages,
          };
        }),
      }));
    },
    [],
  );

  const post = (message: WorkerRequest) => workerRef.current?.postMessage(message);

  useEffect(() => {
    const inferenceWorker = makeWorker();
    workerRef.current = inferenceWorker;
    inferenceWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === 'loading') {
        setStatus('loading');
        setNotice('');
      } else if (response.type === 'progress') {
        setProgress(response);
      } else if (response.type === 'ready') {
        setStatus('ready');
        setLoadedModel(response.modelId);
        setLoadedBackend(response.backend);
        setCacheBytes(response.cachedBytes);
        setProgress(null);
        setNotice('');
      } else if (response.type === 'token') {
        const pendingId = pendingIdRef.current;
        if (!pendingId) return;
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingId ? { ...message, content: response.text } : message,
          ),
        );
      } else if (response.type === 'complete') {
        const pendingId = pendingIdRef.current;
        setMessages((current) =>
          current.map((message) =>
            message.id === pendingId
              ? { ...message, content: response.text, elapsedMs: response.elapsedMs, pending: false }
              : message,
          ),
        );
        pendingIdRef.current = null;
        setStatus('ready');
      } else if (response.type === 'aborted') {
        const pendingId = pendingIdRef.current;
        setMessages((current) =>
          current
            .map((message) =>
              message.id === pendingId ? { ...message, pending: false } : message,
            )
            .filter((message) => message.content.trim()),
        );
        pendingIdRef.current = null;
        setStatus('ready');
        setNotice('生成を停止しました。');
      } else if (response.type === 'cache-cleared') {
        setStatus('idle');
        setLoadedModel(null);
        setCacheBytes(0);
        setProgress(null);
        setNotice('保存したモデルを削除しました。');
      } else if (response.type === 'error') {
        setStatus('error');
        setNotice(response.message);
        const pendingId = pendingIdRef.current;
        setMessages((current) => current.filter((message) => message.id !== pendingId));
        pendingIdRef.current = null;
      }
    };
    return () => {
      inferenceWorker.terminate();
      workerRef.current = null;
    };
  }, [setMessages]);

  useEffect(() => {
    localStorage.setItem('evex-model', modelId);
    const anonymous = {
      ...DEFAULT_PERSONA,
      prompt: model.format === 'qwen3-transformers' ? 'B' : '<|other|>',
    };
    setPersonas([anonymous]);
    setPersonaId('anonymous');
    setPersonasLoading(model.supportsPersonas);
    if (!model.supportsPersonas) return;
    const controller = new AbortController();
    fetchPersonas(model)
      .then((items) => {
        if (!controller.signal.aborted) {
          setPersonas(items);
          setPersonasLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPersonasLoading(false);
          setNotice(error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort();
  }, [modelId, model]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      localStorage.setItem(
        HISTORY_KEY,
        JSON.stringify({
          ...chatStore,
          chats: chatStore.chats.map((chat) => ({
            ...chat,
            messages: chat.messages.filter((message) => !message.pending),
          })),
        }),
      );
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [chatStore]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const generating = status === 'generating';
  const ready = loadedModel === modelId && (status === 'ready' || generating);
  const completedMessages = useMemo(
    () => messages.filter((message) => !message.pending || message.content),
    [messages],
  );
  const sortedChats = useMemo(
    () => [...chatStore.chats].sort((left, right) => right.updatedAt - left.updatedAt),
    [chatStore.chats],
  );

  const resetGenerationState = () => {
    pendingIdRef.current = null;
    post({ type: 'reset' });
    setDraft('');
    setNotice('');
  };

  const newChat = (force = false) => {
    if (generating) return;
    if (!force && messages.length === 0) {
      setSidebarOpen(false);
      return;
    }
    const chat = createChat();
    setChatStore((current) => ({ activeId: chat.id, chats: [chat, ...current.chats] }));
    resetGenerationState();
    setSidebarOpen(false);
  };

  const openChat = (id: string) => {
    if (generating || id === chatStore.activeId) {
      setSidebarOpen(false);
      return;
    }
    setChatStore((current) => ({ ...current, activeId: id }));
    resetGenerationState();
    setSidebarOpen(false);
  };

  const deleteChat = (chat: ChatSession) => {
    if (generating || !window.confirm(`「${chat.title}」を履歴から削除しますか？`)) return;
    setChatStore((current) => {
      const remaining = current.chats.filter((item) => item.id !== chat.id);
      if (!remaining.length) {
        const next = createChat();
        return { activeId: next.id, chats: [next] };
      }
      return {
        activeId: current.activeId === chat.id ? remaining[0].id : current.activeId,
        chats: remaining,
      };
    });
    if (chat.id === chatStore.activeId) resetGenerationState();
  };

  const prepareConfigurationChange = () => {
    if (messages.length) newChat(true);
    else resetGenerationState();
  };

  const changeModel = (next: ModelId) => {
    if (next === modelId) return;
    prepareConfigurationChange();
    setModelId(next);
    const nextModel = MODELS[next];
    setPersonaEnabled(false);
    setBackend(nextModel.format === 'qwen3-transformers' ? 'webgpu' : 'auto');
    setStatus('idle');
    setLoadedModel(null);
  };

  const changePersona = (next: string) => {
    if (next === personaId) return;
    prepareConfigurationChange();
    setPersonaId(next);
  };

  const togglePersona = () => {
    if (!model.supportsPersonas || personasLoading || personas.length < 2) return;
    prepareConfigurationChange();
    const next = !personaEnabled;
    if (next && personaId === 'anonymous') {
      setPersonaId(personas.find((item) => item.id !== 'anonymous')?.id ?? 'anonymous');
    }
    setPersonaEnabled(next);
  };

  const changeBackend = (next: Backend) => {
    if (next === backend) return;
    prepareConfigurationChange();
    setBackend(next);
    setStatus('idle');
    setLoadedModel(null);
  };

  const load = () => {
    setNotice('');
    setSettingsOpen(false);
    setProgress({ file: '準備中', loaded: 0, total: model.downloadBytes, progress: 0 });
    post({ type: 'load', modelId, backend });
  };

  const startGeneration = (turns: ConversationTurn[]) => {
    const pendingId = crypto.randomUUID();
    pendingIdRef.current = pendingId;
    setMessages((current) => [
      ...current,
      {
        id: pendingId,
        role: 'assistant',
        content: '',
        at: Date.now(),
        model: model.name,
        persona: personaEnabled ? persona.label : undefined,
        pending: true,
      },
    ]);
    setStatus('generating');
    post({ type: 'generate', turns, persona });
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || !ready || generating) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      at: Date.now(),
    };
    const turns: ConversationTurn[] = [
      ...messages
        .filter((message) => !message.pending && message.content)
        .map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content: text },
    ];
    setMessages((current) => [...current, userMessage]);
    setDraft('');
    startGeneration(turns);
  };

  const regenerate = () => {
    if (!ready || generating) return;
    let lastAssistant = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') {
        lastAssistant = index;
        break;
      }
    }
    if (lastAssistant < 0) return;
    const withoutLast = messages.filter((_, index) => index !== lastAssistant);
    setMessages(withoutLast);
    startGeneration(
      withoutLast
        .filter((message) => !message.pending && message.content)
        .map((message) => ({ role: message.role, content: message.content })),
    );
  };

  const clearCache = () => {
    if (!window.confirm('IndexedDBに保存したモデルをすべて削除しますか？')) return;
    post({ type: 'clear-cache' });
  };

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button className="sidebar-backdrop" type="button" aria-label="履歴を閉じる" onClick={() => setSidebarOpen(false)} />
      )}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="チャット履歴">
        <div className="sidebar-header">
          <div className="brand">
            <strong>evex chat</strong>
            <span>ブラウザ内で実行</span>
          </div>
          <button className="sidebar-close" type="button" onClick={() => setSidebarOpen(false)}>閉じる</button>
        </div>

        <button className="new-chat-button" type="button" onClick={() => newChat()} disabled={generating}>
          新しいチャット
        </button>

        <nav className="history-list" aria-label="保存した会話">
          <p className="history-label">履歴</p>
          {sortedChats.map((chat) => (
            <div className={`history-item ${chat.id === chatStore.activeId ? 'active' : ''}`} key={chat.id}>
              <button className="history-open" type="button" onClick={() => openChat(chat.id)} disabled={generating}>
                <span>{chat.title}</span>
                <small>{historyDate(chat.updatedAt)}</small>
              </button>
              <button className="history-delete" type="button" onClick={() => deleteChat(chat)} disabled={generating}>
                削除
              </button>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          {cacheBytes > 0 && <span>モデル保存済み {formatBytes(cacheBytes)}</span>}
          <p>履歴とモデルはこのブラウザに保存されます。</p>
        </div>
      </aside>

      <div className="main-shell" data-model-ready={ready ? 'true' : 'false'}>
        <header className="main-header">
          <div className="header-title">
            <button className="history-toggle" type="button" onClick={() => setSidebarOpen(true)}>履歴</button>
            <div>
              <strong>{activeChat?.title ?? '新しいチャット'}</strong>
              <span>{ready ? `${model.name} · ${loadedBackend.toUpperCase()}` : model.name}</span>
            </div>
          </div>
          <button className="settings-toggle" type="button" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
            設定
          </button>
        </header>

        {settingsOpen && (
          <section className="settings-panel" aria-label="モデル設定">
            <div className="settings-grid">
              <label>
                <span>実行方法</span>
                <select aria-label="実行方法" value={backend} onChange={(event) => changeBackend(event.target.value as Backend)} disabled={generating || model.backends.length === 1}>
                  {model.backends.map((item) => (
                    <option key={item} value={item}>{item === 'auto' ? '自動' : item.toUpperCase()}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="settings-summary">
              <div>
                <strong>{ready ? '準備完了' : model.description}</strong>
                <span>{model.warning ?? `初回ダウンロード 約${formatBytes(model.downloadBytes)}`}</span>
              </div>
              <div className="settings-actions">
                <button className="secondary-button" type="button" onClick={clearCache}>保存モデルを削除</button>
                <button className="load-button" type="button" onClick={load} disabled={status === 'loading' || generating}>
                  {status === 'loading' ? '読み込み中' : ready ? '再読み込み' : 'モデルを読み込む'}
                </button>
              </div>
            </div>
          </section>
        )}

        <main className="conversation-scroll">
          {(progress || notice) && (
            <section className="runtime-panel" aria-live="polite">
              {progress && status === 'loading' && (
                <div className="progress-row">
                  <div className="progress-copy">
                    <strong>{progress.file.split('/').at(-1)}</strong>
                    <span>{formatBytes(progress.loaded)} / {formatBytes(progress.total || model.downloadBytes)}</span>
                  </div>
                  <div className="progress-track" aria-label={`読込 ${Math.round(progress.progress)}%`}>
                    <span style={{ width: `${Math.max(1, Math.min(100, progress.progress))}%` }} />
                  </div>
                </div>
              )}
              {notice && <p className={status === 'error' ? 'error' : ''}>{notice}</p>}
            </section>
          )}

          <section className="message-list" aria-label="会話">
            {completedMessages.length === 0 ? (
              <div className="empty-state">
                <h1>{ready ? '新しいチャット' : 'モデルを読み込む'}</h1>
                <p>
                  {ready
                    ? 'メッセージを入力してください。'
                    : `${model.name}（約${formatBytes(model.downloadBytes)}）をこのブラウザで実行します。`}
                </p>
                {!ready && (
                  <button className="primary-load" type="button" onClick={load} disabled={status === 'loading'}>
                    {status === 'loading' ? '読み込み中' : 'モデルを読み込む'}
                  </button>
                )}
              </div>
            ) : (
              completedMessages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <div className="message-body">
                    {message.role === 'assistant' && message.persona && !message.persona.startsWith('匿名') && (
                      <strong className="speaker-name">{message.persona}</strong>
                    )}
                    <p>{message.content || <span className="typing"><i /><i /><i /></span>}</p>
                  </div>
                </article>
              ))
            )}
            <div ref={bottomRef} />
          </section>
        </main>

        <div className="composer-wrap">
          <div className="composer-tools">
            <div className="persona-controls">
              <button
                className={`persona-toggle ${personaEnabled ? 'active' : ''}`}
                type="button"
                aria-pressed={personaEnabled}
                onClick={togglePersona}
                disabled={!model.supportsPersonas || personasLoading || personas.length < 2 || generating}
              >
                なりきり {personasLoading ? '準備中' : personaEnabled ? 'ON' : 'OFF'}
              </button>
              {personaEnabled && (
                <select aria-label="なりきる人物" value={personaId} onChange={(event) => changePersona(event.target.value)} disabled={generating}>
                  {personas.filter((item) => item.id !== 'anonymous').map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}{item.messages ? ` · ${item.messages.toLocaleString()}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="generation-tools">
              {ready && !generating && messages.some((message) => message.role === 'assistant') && (
                <button type="button" onClick={regenerate}>再生成</button>
              )}
              {generating && <button className="stop" type="button" onClick={() => post({ type: 'abort' })}>停止</button>}
            </div>
          </div>
          <div className="composer">
            <label className="composer-model-picker">
              <span>モデル</span>
              <select aria-label="モデル" value={modelId} onChange={(event) => changeModel(event.target.value as ModelId)} disabled={generating}>
                {MODEL_LIST.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </label>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              rows={1}
              maxLength={1200}
              placeholder={ready ? 'メッセージを入力' : '先にモデルを読み込んでください'}
              disabled={!ready || generating}
              aria-label="メッセージ"
            />
            <button type="button" onClick={submit} disabled={!ready || generating || !draft.trim()} aria-label="送信">
              送信
            </button>
          </div>
          <p className="disclaimer">
            {personaEnabled
              ? `${persona.label}の会話傾向を再現したAI出力で、本人の発言ではありません。`
              : '回答はこのブラウザ内で生成されます。'}
          </p>
        </div>
      </div>
    </div>
  );
}
