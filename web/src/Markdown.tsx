import { isValidElement, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { codeToHtml } from 'shiki';

const SHIKI_THEME = 'github-dark';

interface CodeBlockProps {
  code: string;
  lang: string;
}

function normalizeLang(lang: string): string {
  switch (lang.toLowerCase()) {
    case 'js':
      return 'javascript';
    case 'ts':
      return 'typescript';
    case 'py':
      return 'python';
    case 'sh':
    case 'shell':
      return 'bash';
    default:
      return lang || 'text';
  }
}

function extractCodeBlock(children: ReactNode): CodeBlockProps | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ children?: ReactNode; className?: string }>(child)) return null;

  const code = String(child.props.children ?? '').replace(/\n$/, '');
  const lang = /language-([\w-]+)/.exec(child.props.className ?? '')?.[1] ?? 'text';
  return { code, lang: normalizeLang(lang) };
}

function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);

    codeToHtml(code, { lang, theme: SHIKI_THEME })
      .catch(() => codeToHtml(code, { lang: 'text', theme: SHIKI_THEME }))
      .then((highlighted) => {
        if (!cancelled) setHtml(highlighted);
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  if (html) {
    return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <pre>
      <code>{code}</code>
    </pre>
  );
}

/** Renders assistant/notice text as GitHub-flavored Markdown. Links open safely. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          pre: ({ children }) => {
            const codeBlock = extractCodeBlock(children);
            return codeBlock ? <CodeBlock {...codeBlock} /> : <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
