import type { ComponentPropsWithoutRef, ElementType } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Assistant replies come back as markdown. Rendering them as plain text shows
 * the reader literal `###` and `**`, so text parts go through this instead.
 *
 * Styled element-by-element rather than with @tailwindcss/typography: `prose`
 * assumes an article on a page background, and these are short chat bubbles.
 */

// react-markdown hands every component the hast node alongside the DOM props.
// It must not reach the element or React warns about an unknown attribute.
type MdProps<T extends ElementType> = ComponentPropsWithoutRef<T> & {
  node?: unknown;
};

const el =
  <T extends ElementType>(Tag: T, className: string) =>
  ({ node: _node, ...props }: MdProps<T>) => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Tag className={className} {...(props as any)} />
  );

export default function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      // Markdown re-parses on every streamed token; defer keeps typing and
      // scrolling responsive while a long reply streams in.
      defer
      className="markdown-text space-y-3 leading-relaxed break-words"
      components={{
        h1: el("h1", "mt-5 mb-2 text-lg font-semibold first:mt-0"),
        h2: el("h2", "mt-5 mb-2 text-base font-semibold first:mt-0"),
        h3: el("h3", "mt-4 mb-1 text-sm font-semibold first:mt-0"),
        h4: el("h4", "mt-3 mb-1 text-sm font-semibold first:mt-0"),

        p: el("p", "whitespace-pre-wrap"),
        strong: el("strong", "font-semibold"),
        em: el("em", "italic"),

        ul: el("ul", "list-disc space-y-1 pl-5"),
        ol: el("ol", "list-decimal space-y-1 pl-5"),
        li: el("li", "pl-0.5"),

        blockquote: el("blockquote", "border-l-2 border-ink pl-3 text-ink-soft"),
        hr: el("hr", "border-line"),

        a: ({ node: _node, ...props }: MdProps<"a">) => (
          <a
            className="markdown-link underline underline-offset-2"
            target="_blank"
            rel="noopener noreferrer nofollow"
            {...props}
          />
        ),

        // For a fenced block the library composes pre > code from these two, so
        // <pre> owns the scroll container and resets the inline-code styling
        // that `code` would otherwise apply inside it.
        pre: el(
          "pre",
          "overflow-x-auto border border-line bg-surface-alt p-3 text-xs " +
            "leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs",
        ),
        // Background and padding come from index.css so light and dark can
        // differ; see .markdown-text :not(pre) > code.
        code: el("code", "text-xs"),

        table: ({ node: _node, ...props }: MdProps<"table">) => (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs" {...props} />
          </div>
        ),
        th: el("th", "border border-line px-2 py-1 text-left font-semibold"),
        td: el("td", "border border-line px-2 py-1 align-top"),
      }}
    />
  );
}
