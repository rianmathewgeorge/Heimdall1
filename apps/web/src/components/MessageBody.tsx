import type React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/**
 * Renders one message.
 *
 * The Playground used to print `message.content` as raw text, so a perfectly good
 * answer arrived as literal `###`, `**bold**` and `\[\operatorname{Cov}(X,Y)=...\]`.
 * The maths was never the problem — the reader was being shown the source.
 *
 * SECURITY: this displays MODEL output, which is untrusted. `react-markdown` does
 * not render embedded HTML unless `rehype-raw` is added, and it is deliberately
 * not added here — so a model cannot inject markup into the operator's console.
 * KaTeX likewise runs with `trust: false` (its default), which blocks \\href and
 * \\includegraphics. Links are forced to open in a new tab with `noreferrer`.
 */
/**
 * `remark-math` understands `$…$` and `$$…$$`. Models overwhelmingly emit the
 * LaTeX delimiters `\(…\)` and `\[…\]` instead, which it ignores — so the maths
 * fell through as literal backslashes. Convert them first.
 *
 * Fenced and inline code are left alone: a code sample containing `\[` is code,
 * not maths, and rewriting it would corrupt what the agent actually wrote.
 */
export function normaliseMathDelimiters(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg;                       // a code span or fence
      return seg
        // Leading indentation is consumed too: `\[` often sits indented inside a
        // list item, and leaving those spaces made the block a lazy continuation
        // of the list, so it typeset as INLINE math instead of a display block.
        .replace(/[ \t]*\\\[([\s\S]*?)\\\]/g, (_m, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
    })
    .join("");
}

export function MessageBody({ content }: { content: string }): React.ReactElement {
  return (
    <div className="message-body markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          table: ({ children }) => (
            <div className="table-scroll"><table>{children}</table></div>
          ),
        }}
      >
        {normaliseMathDelimiters(content)}
      </ReactMarkdown>
    </div>
  );
}
