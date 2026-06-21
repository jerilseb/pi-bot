import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { MenuCard, ThinkingBlock, ToolCard } from './components.tsx';
import { Markdown } from './Markdown.tsx';
import { enablePush, registerServiceWorker } from './push.ts';
import { initialState, reducer, type Entry } from './store.ts';
import { ChatSocket } from './ws.ts';

interface PendingUpload {
  uploadId: string;
  name: string;
  kind: string;
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<ChatSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const socket = new ChatSocket(
      (event) => dispatch({ type: 'event', event }),
      (connected) => dispatch({ type: 'status', connected }),
    );
    socketRef.current = socket;
    socket.connect();
    void registerServiceWorker();

    const reportVisibility = () =>
      socket.send({ type: 'visibility', visible: document.visibilityState === 'visible' });
    document.addEventListener('visibilitychange', reportVisibility);
    reportVisibility();

    return () => {
      document.removeEventListener('visibilitychange', reportVisibility);
      socket.close();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.entries]);

  const send = useCallback((text: string, uploadIds: string[]) => {
    socketRef.current?.send({ type: 'prompt', text, ...(uploadIds.length ? { uploadIds } : {}) });
  }, []);

  const onMenuSelect = useCallback(
    (menuId: string, optionIndex: number | null) => {
      socketRef.current?.send(
        optionIndex === null
          ? { type: 'menu_select', menuId, cancel: true }
          : { type: 'menu_select', menuId, optionIndex },
      );
      dispatch({ type: 'resolveMenu', menuId });
    },
    [],
  );

  return (
    <div className="app">
      <Header
        model={state.model}
        allowedModels={state.allowedModels}
        connected={state.connected}
        running={state.running}
        status={state.status}
        pushEnabled={state.pushEnabled}
        vapidPublicKey={state.vapidPublicKey}
        onSetModel={(m) => socketRef.current?.send({ type: 'set_model', model: m })}
        onAbort={() => socketRef.current?.send({ type: 'abort' })}
        onNew={() => socketRef.current?.send({ type: 'new' })}
      />
      <main className="timeline">
        {state.entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} onMenuSelect={onMenuSelect} />
        ))}
        {state.running && <div className="run-indicator">working…</div>}
        <div ref={bottomRef} />
      </main>
      <Composer onSend={send} />
    </div>
  );
}

function Header(props: {
  model: string;
  allowedModels: string[];
  connected: boolean;
  running: boolean;
  status: string;
  pushEnabled: boolean;
  vapidPublicKey: string | null;
  onSetModel: (model: string) => void;
  onAbort: () => void;
  onNew: () => void;
}) {
  const [pushed, setPushed] = useState(false);
  return (
    <header className="header">
      <div className="brand">
        <span className={`dot ${props.connected ? 'dot-on' : 'dot-off'}`} title={props.status} />
        <strong>J-Rex</strong>
      </div>
      <div className="header-controls">
        <select
          value={props.model}
          disabled={props.running}
          onChange={(e) => props.onSetModel(e.target.value)}
          title={props.running ? 'Wait for the current response to finish' : 'Switch model'}
        >
          {props.allowedModels.length === 0 && <option value={props.model}>{props.model}</option>}
          {props.allowedModels.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {props.running && (
          <button type="button" className="btn-abort" onClick={props.onAbort}>
            Stop
          </button>
        )}
        <button type="button" onClick={props.onNew} title="Start a fresh conversation">
          New
        </button>
        {props.pushEnabled && props.vapidPublicKey && !pushed && (
          <button
            type="button"
            onClick={async () => {
              const ok = await enablePush(props.vapidPublicKey as string);
              setPushed(ok);
            }}
            title="Enable push notifications"
          >
            🔔
          </button>
        )}
      </div>
    </header>
  );
}

function EntryView({
  entry,
  onMenuSelect,
}: {
  entry: Entry;
  onMenuSelect: (menuId: string, optionIndex: number | null) => void;
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          <div className="bubble">
            {entry.text && <div className="user-text">{entry.text}</div>}
            {entry.attachments.length > 0 && (
              <div className="attachments">
                {entry.attachments.map((a) =>
                  a.kind === 'image' ? (
                    <a key={a.assetId} href={a.url} target="_blank" rel="noreferrer">
                      <img src={a.url} alt={a.name} className="att-image" />
                    </a>
                  ) : (
                    <a key={a.assetId} href={a.url} target="_blank" rel="noreferrer" className="att-file">
                      📎 {a.name}
                    </a>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      );

    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <div className="bubble">
            <ThinkingBlock text={entry.thinking} />
            <Markdown text={entry.text || (entry.streaming ? '…' : '')} />
            {entry.streaming && <span className="cursor" />}
          </div>
        </div>
      );

    case 'tool':
      return (
        <div className="msg msg-tool">
          <ToolCard entry={entry} />
        </div>
      );

    case 'file':
      return (
        <div className="msg msg-assistant">
          <div className="bubble">
            {entry.fileKind === 'image' ? (
              <a href={entry.url} target="_blank" rel="noreferrer">
                <img src={entry.url} alt={entry.name} className="att-image" />
              </a>
            ) : (
              <a href={entry.url} target="_blank" rel="noreferrer" className="att-file">
                📄 {entry.name}
              </a>
            )}
            {entry.caption && <div className="caption">{entry.caption}</div>}
          </div>
        </div>
      );

    case 'voice':
      return (
        <div className="msg msg-assistant">
          <div className="bubble">
            {/* biome-ignore lint/a11y/useMediaCaption: generated voice note */}
            <audio controls src={entry.url} className="voice-player" />
          </div>
        </div>
      );

    case 'menu':
      return (
        <div className="msg msg-assistant">
          <MenuCard entry={entry} onSelect={(i) => onMenuSelect(entry.menuId, i)} />
        </div>
      );

    case 'notice':
      return <div className={`notice notice-${entry.level}`}><Markdown text={entry.text} /></div>;
  }
}

function Composer({ onSend }: { onSend: (text: string, uploadIds: string[]) => void }) {
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  const submit = async () => {
    if (!text.trim() && uploads.length === 0) return;
    onSend(text.trim(), uploads.map((u) => u.uploadId));
    setText('');
    setUploads([]);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('file', f, f.name);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { uploads: PendingUpload[] };
      setUploads((prev) => [...prev, ...data.uploads]);
    } catch (err) {
      alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      alert(
        'Microphone needs a secure connection. Open this app over HTTPS (or localhost) — plain http:// blocks mic access on iOS/Safari.',
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        setRecording(false);
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('file', blob, 'mic.webm');
        setBusy(true);
        try {
          const res = await fetch('/api/transcribe', { method: 'POST', body: form });
          const data = (await res.json()) as { text?: string; error?: string };
          if (data.text) setText((t) => (t ? `${t} ${data.text}` : data.text || ''));
          else if (data.error) alert(`Transcription failed: ${data.error}`);
        } finally {
          setBusy(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') alert('Microphone permission was denied. Allow it in Safari site settings.');
      else if (name === 'NotFoundError') alert('No microphone was found.');
      else alert(`Could not start recording: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <footer className="composer">
      {uploads.length > 0 && (
        <div className="upload-chips">
          {uploads.map((u) => (
            <span key={u.uploadId} className="chip">
              {u.kind === 'image' ? '🖼' : '📎'} {u.name}
              <button
                type="button"
                onClick={() => setUploads((prev) => prev.filter((p) => p.uploadId !== u.uploadId))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <button type="button" className="icon-btn" onClick={() => fileInputRef.current?.click()} disabled={busy}>
          📎
        </button>
        <button
          type="button"
          className={`icon-btn ${recording ? 'recording' : ''}`}
          onClick={() => void toggleRecording()}
        >
          {recording ? '⏹' : '🎤'}
        </button>
        <textarea
          value={text}
          placeholder="Message J-Rex…"
          aria-label="Message J-Rex"
          title="Enter to send. Shift+Enter for newline."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
        />
        <button
          type="button"
          className="send-btn"
          onClick={() => void submit()}
          disabled={busy}
          aria-label="Send"
          title="Send"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
    </footer>
  );
}
