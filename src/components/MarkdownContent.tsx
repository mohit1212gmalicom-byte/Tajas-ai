import { useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const language = match?.[1] || 'code';
  const codeText = String(children).replace(/\n$/, '');

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-950 text-neutral-100 dark:border-neutral-800">
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900 px-3.5 py-1.5 text-[11px] font-mono text-neutral-400">
        <span>{language}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-white"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? 'Copied' : 'Copy code'}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 text-xs leading-relaxed font-mono">
        <code>{codeText}</code>
      </pre>
    </div>
  );
}

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="prose-tejas space-y-2.5 text-sm leading-relaxed break-words">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-4 text-lg font-bold tracking-tight">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 text-base font-semibold tracking-tight">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2.5 text-sm font-semibold">{children}</h3>
          ),
          p: ({ children }) => <p className="leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="rounded-lg border border-neutral-200 bg-neutral-50 px-3.5 py-2 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-neutral-200 bg-neutral-50 px-3 py-2 font-semibold dark:border-neutral-800 dark:bg-neutral-900">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
              {children}
            </td>
          ),
          a: ({ href, children }) => {
            const safeHref =
              href && /^https?:\/\//i.test(href) ? href : undefined;
            return safeHref ? (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:opacity-80"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          code: ({ className, children, ...props }) => {
            const isBlock = Boolean(className?.includes('language-')) || String(children).includes('\n');
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code
                {...props}
                className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[12px] text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
              >
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
