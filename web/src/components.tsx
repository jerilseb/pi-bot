import { useState } from 'react';
import { Markdown } from './Markdown.tsx';
import type { Entry } from './store.ts';

function argsToText(args: unknown): string {
  if (typeof args === 'string') return args;
  if (args === null || args === undefined) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function ToolCard({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const argText = argsToText(entry.args);
  return (
    <div className={`tool-card ${entry.isError ? 'tool-error' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-label">{entry.label || entry.name}</span>
        <span className={`tool-status tool-status-${entry.status}`}>
          {entry.status === 'running' ? '…' : entry.isError ? 'error' : 'done'}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          {argText && (
            <>
              <div className="tool-section-title">args</div>
              <pre className="tool-pre">{argText}</pre>
            </>
          )}
          {entry.result && (
            <>
              <div className="tool-section-title">result</div>
              <pre className="tool-pre">{entry.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="thinking">
      <button type="button" className="thinking-head" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} thinking
      </button>
      {open && <pre className="thinking-body">{text}</pre>}
    </div>
  );
}

export function MenuCard({
  entry,
  onSelect,
}: {
  entry: Extract<Entry, { kind: 'menu' }>;
  onSelect: (optionIndex: number | null) => void;
}) {
  return (
    <div className="menu-card">
      <div className="menu-text">
        <Markdown text={entry.text} />
      </div>
      <div className="menu-buttons">
        {entry.options.map((opt, i) => (
          <button
            type="button"
            key={`${entry.menuId}-${i}`}
            disabled={entry.resolved}
            onClick={() => onSelect(i)}
          >
            {opt.label}
          </button>
        ))}
        {entry.allowCancel && (
          <button
            type="button"
            className="menu-cancel"
            disabled={entry.resolved}
            onClick={() => onSelect(null)}
          >
            Cancel
          </button>
        )}
      </div>
      {entry.resolved && <div className="menu-resolved">Selection sent.</div>}
    </div>
  );
}
