import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
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

const SLASH_COMMANDS = [
  { command: '/help', description: 'Show available commands' },
  { command: '/status', description: 'Show chat/session status' },
  { command: '/openaiusage', description: 'Show OpenAI Codex usage' },
  { command: '/elevenlabsusage', description: 'Show ElevenLabs usage' },
  { command: '/abort', description: 'Abort the current response' },
  { command: '/new', description: 'Start a fresh conversation' },
  { command: '/restart', description: 'Restart the bot via PM2' },
] as const;

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<ChatSocket | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const timelineContentRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

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

  const scrollToBottom = useCallback(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: 'auto' });
  }, []);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    const updateAutoScroll = () => {
      const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
      shouldAutoScrollRef.current = distanceFromBottom < 120;
    };

    timeline.addEventListener('scroll', updateAutoScroll, { passive: true });
    updateAutoScroll();
    return () => timeline.removeEventListener('scroll', updateAutoScroll);
  }, []);

  useEffect(() => {
    const content = timelineContentRef.current;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (!shouldAutoScrollRef.current) return;
      requestAnimationFrame(scrollToBottom);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (!shouldAutoScrollRef.current) return;

    scrollToBottom();
    const firstFrame = requestAnimationFrame(() => {
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
    });
    const timeout = window.setTimeout(scrollToBottom, 120);

    return () => {
      cancelAnimationFrame(firstFrame);
      window.clearTimeout(timeout);
    };
  }, [state.entries, state.running, scrollToBottom]);

  const send = useCallback((text: string, uploadIds: string[]) => {
    shouldAutoScrollRef.current = true;
    socketRef.current?.send({ type: 'prompt', text, ...(uploadIds.length ? { uploadIds } : {}) });
  }, []);

  const onMenuSelect = useCallback((menuId: string, optionIndex: number | null) => {
    shouldAutoScrollRef.current = true;
    socketRef.current?.send(
      optionIndex === null
        ? { type: 'menu_select', menuId, cancel: true }
        : { type: 'menu_select', menuId, optionIndex },
    );
    dispatch({ type: 'resolveMenu', menuId });
  }, []);

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
        onNew={() => socketRef.current?.send({ type: 'new' })}
      />
      <main className="timeline" ref={timelineRef}>
        <div className="timeline-content" ref={timelineContentRef}>
          {state.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} onMenuSelect={onMenuSelect} />
          ))}
          {state.running && <div className="run-indicator">working…</div>}
          <div ref={bottomRef} />
        </div>
      </main>
      <Composer
        running={state.running}
        onAbort={() => socketRef.current?.send({ type: 'abort' })}
        onSend={send}
      />
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
  onNew: () => void;
}) {
  const [pushed, setPushed] = useState(false);
  return (
    <header className="header">
      <div className="brand">
        <img
          src="/j-rex-192.png"
          alt="J-Rex"
          className={`brand-avatar ${props.connected ? 'brand-avatar-connected' : ''}`}
          title={props.status}
        />
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
                    <a
                      key={a.assetId}
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="att-file"
                    >
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
      return (
        <div className={`notice notice-${entry.level}`}>
          <Markdown text={entry.text} />
        </div>
      );
  }
}

function Composer({
  running,
  onAbort,
  onSend,
}: {
  running: boolean;
  onAbort: () => void;
  onSend: (text: string, uploadIds: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  // Telegram-style swipe-left-to-cancel: track how far left the thumb has slid
  // (slideX, ≤ 0) and whether it's past the cancel threshold (cancelArmed).
  const [slideX, setSlideX] = useState(0);
  const [cancelArmed, setCancelArmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const holdingRef = useRef(false);
  // discardRef tells the recorder's onstop handler to drop the audio instead of
  // transcribing it. startXRef is the pointer's X at hold start; cancelArmedRef
  // mirrors cancelArmed so the pointerup handler reads a fresh value.
  const discardRef = useRef(false);
  const startXRef = useRef(0);
  const cancelArmedRef = useRef(false);

  // How far left (px) the thumb must travel during a hold to cancel the recording.
  const DISCARD_THRESHOLD = 90;

  const hasContent = text.trim().length > 0 || uploads.length > 0;
  const slashQuery = /^\/\S*$/.test(text) ? text.toLowerCase() : null;
  const slashMatches = slashQuery
    ? SLASH_COMMANDS.filter(
        ({ command, description }) =>
          command.startsWith(slashQuery) || description.toLowerCase().includes(slashQuery.slice(1)),
      )
    : [];
  const showSlashCommands = slashMatches.length > 0 && !recording && !transcribing;

  const setRecordingGestureActive = useCallback((active: boolean) => {
    document.documentElement.classList.toggle('recording-gesture', active);
    if (active) window.getSelection()?.removeAllRanges();
  }, []);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 180);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, text]);

  useEffect(() => {
    window.addEventListener('resize', resizeTextarea);
    return () => window.removeEventListener('resize', resizeTextarea);
  }, [resizeTextarea]);

  useEffect(() => {
    return () => setRecordingGestureActive(false);
  }, [setRecordingGestureActive]);

  useEffect(() => {
    setSelectedSlashIndex(0);
  }, [slashQuery]);

  const selectSlashCommand = useCallback((command: string) => {
    setText(command);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      resizeTextarea();
    });
  }, [resizeTextarea]);

  const submit = async () => {
    if (!text.trim() && uploads.length === 0) return;
    onSend(
      text.trim(),
      uploads.map((u) => u.uploadId),
    );
    setText('');
    setUploads([]);
  };

  const handleFiles = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of list) form.append('file', f, f.name);
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

  // Upload files pasted into the composer (e.g. a copied iOS screenshot). Pasted
  // images often arrive without a filename, so synthesize one from the mime type.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      if (file.name) {
        files.push(file);
      } else {
        const ext = file.type.split('/')[1] || 'png';
        files.push(new File([file], `pasted-${Date.now()}.${ext}`, { type: file.type }));
      }
    }
    if (files.length === 0) return; // plain text paste — let the default happen
    e.preventDefault();
    void handleFiles(files);
  };

  // Press-and-hold to record (Telegram-style): pointer down starts, release stops
  // and transcribes into the composer. holdingRef guards an early release that
  // happens before getUserMedia resolves.
  const startRecording = async () => {
    if (recording || holdingRef.current || busy) {
      setRecordingGestureActive(false);
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setRecordingGestureActive(false);
      alert(
        'Microphone needs a secure connection. Open this app over HTTPS (or localhost) — plain http:// blocks mic access on iOS/Safari.',
      );
      return;
    }
    setRecordingGestureActive(true);
    holdingRef.current = true;
    discardRef.current = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!holdingRef.current) {
        // Released before the mic was ready — discard.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        setRecording(false);
        if (discardRef.current) {
          // Swiped left past the threshold — drop the audio without transcribing.
          discardRef.current = false;
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('file', blob, 'mic.webm');
        setBusy(true);
        setTranscribing(true);
        try {
          const res = await fetch('/api/transcribe', { method: 'POST', body: form });
          const data = (await res.json()) as { text?: string; error?: string };
          if (data.text) setText((t) => (t ? `${t} ${data.text}` : data.text || ''));
          else if (data.error) alert(`Transcription failed: ${data.error}`);
        } finally {
          setTranscribing(false);
          setBusy(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setRecordingGestureActive(false);
      holdingRef.current = false;
      setRecording(false);
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError')
        alert('Microphone permission was denied. Allow it in Safari site settings.');
      else if (name === 'NotFoundError') alert('No microphone was found.');
      else alert(`Could not start recording: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const stopRecording = (discard = false) => {
    setRecordingGestureActive(false);
    if (!holdingRef.current) return;
    holdingRef.current = false;
    discardRef.current = discard;
    cancelArmedRef.current = false;
    setSlideX(0);
    setCancelArmed(false);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
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
        <button
          type="button"
          className="icon-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          aria-label="Attach file"
          title="Attach file"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M21.4 10.6 12 20a6 6 0 0 1-8.5-8.5l9.8-9.8a4.2 4.2 0 0 1 6 6L9.5 17.5a2.4 2.4 0 0 1-3.4-3.4l9-9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          placeholder="Message J-Rex…"
          aria-label="Message J-Rex"
          title="Enter to send. Shift+Enter for newline."
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (showSlashCommands) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedSlashIndex((i) => (i + 1) % slashMatches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
                return;
              }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                e.preventDefault();
                selectSlashCommand(slashMatches[selectedSlashIndex]?.command ?? slashMatches[0].command);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setText('');
                return;
              }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
        />
        {showSlashCommands && (
          <div className="slash-menu" role="listbox" aria-label="Slash commands">
            {slashMatches.map((item, index) => (
              <button
                key={item.command}
                type="button"
                className={index === selectedSlashIndex ? 'selected' : ''}
                role="option"
                aria-selected={index === selectedSlashIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectSlashCommand(item.command)}
              >
                <span className="slash-command">{item.command}</span>
                <span className="slash-description">{item.description}</span>
              </button>
            ))}
          </div>
        )}
        {running ? (
          <button
            type="button"
            className="send-btn stop-btn"
            onClick={onAbort}
            aria-label="Stop response"
            title="Stop response"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : transcribing ? (
          <button
            type="button"
            className="send-btn mic-btn transcribing-btn"
            disabled
            aria-label="Transcribing voice"
            title="Transcribing voice…"
          >
            <span className="spinner" aria-hidden="true" />
          </button>
        ) : hasContent ? (
          <button
            type="button"
            className="send-btn"
            onClick={() => void submit()}
            disabled={busy}
            aria-label="Send"
            title="Send"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M3.4 20.4 21 12 3.4 3.6 3 10l12 2-12 2z" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <>
            {recording && (
              <div className={`record-hint ${cancelArmed ? 'armed' : ''}`} aria-hidden="true">
                {cancelArmed ? 'Release to cancel' : '‹ Slide to cancel'}
              </div>
            )}
            <button
              type="button"
              className={`send-btn mic-btn ${recording ? 'recording' : ''} ${
                cancelArmed ? 'cancel-armed' : ''
              }`}
              disabled={busy}
              aria-label={
                recording
                  ? 'Recording — release to send, swipe left to cancel'
                  : 'Hold to record voice'
              }
              title="Hold to record"
              style={
                recording
                  ? {
                      transform: `translate(${slideX}px, -32px) scale(2.6)`,
                      transition: slideX < 0 ? 'none' : undefined,
                    }
                  : undefined
              }
              onPointerDown={(e) => {
                e.preventDefault();
                setRecordingGestureActive(true);
                startXRef.current = e.clientX;
                cancelArmedRef.current = false;
                setSlideX(0);
                setCancelArmed(false);
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {}
                void startRecording();
              }}
              onPointerMove={(e) => {
                e.preventDefault();
                if (!holdingRef.current) return;
                window.getSelection()?.removeAllRanges();
                const offset = Math.min(0, e.clientX - startXRef.current);
                setSlideX(offset);
                const armed = offset <= -DISCARD_THRESHOLD;
                if (armed !== cancelArmedRef.current) {
                  cancelArmedRef.current = armed;
                  setCancelArmed(armed);
                }
              }}
              onPointerUp={(e) => {
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {}
                stopRecording(cancelArmedRef.current);
              }}
              onPointerCancel={() => stopRecording(true)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path
                  d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"
                  fill="currentColor"
                />
                <path
                  d="M19 11a7 7 0 0 1-14 0M12 18v3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
