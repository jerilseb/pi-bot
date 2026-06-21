import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
