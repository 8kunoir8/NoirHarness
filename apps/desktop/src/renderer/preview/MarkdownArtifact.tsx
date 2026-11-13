import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * GFM output only. Everything outside this set — including raw HTML, scripts, and `on*`
 * handlers — is removed before React renders it; `href` cannot leave `http`, `https` or
 * `mailto`, and images keep only their alt text.
 */
const schema: SanitizeSchema = {
  ...defaultSchema,
  protocols: { ...(defaultSchema.protocols ?? {}), href: ["http", "https", "mailto"] },
  tagNames: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "code",
    "pre",
    "blockquote",
    "strong",
    "em",
    "del",
    "hr",
    "br",
    "a",
    "img",
    "input",
  ],
};

const EXTERNAL_PROTOCOLS: Record<string, true> = {
  "http:": true,
  "https:": true,
  "mailto:": true,
};

type LinkTarget =
  | { kind: "external"; href: string }
  | { kind: "workspace"; href: string }
  | { kind: "blocked" };

/**
 * `new URL` only succeeds for absolute URLs, so a failure means the renderer never sees a
 * scheme and the link is a workspace-relative path. Everything with another scheme
 * (`javascript:`, `data:`, `file:`, …) is refused.
 */
function linkTarget(href: string | undefined): LinkTarget {
  if (href === undefined || href === "" || href.startsWith("#")) return { kind: "blocked" };
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: "workspace", href };
  }
  return EXTERNAL_PROTOCOLS[url.protocol] === true ? { kind: "external", href } : { kind: "blocked" };
}

/**
 * External links leave through the typed preload bridge. A browser has no bridge — it is the same
 * page the kernel served — so the link opens a tab instead of being swallowed.
 */
function openExternally(href: string): void {
  const bridge = window.noir;
  if (bridge !== undefined) void bridge.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

export interface MarkdownArtifactProps {
  content: string;
  onOpenPath?: ((path: string) => void) | undefined;
}

export function MarkdownArtifact({ content, onOpenPath }: MarkdownArtifactProps) {
  const components: Components = {
    a({ href, children }) {
      const target = linkTarget(href);
      if (target.kind === "external") {
        return (
          <a
            href={target.href}
            rel="noreferrer noopener"
            onClick={(event) => {
              event.preventDefault();
              openExternally(target.href);
            }}
          >
            {children}
          </a>
        );
      }
      if (target.kind === "workspace" && onOpenPath !== undefined) {
        return (
          <a
            href={target.href}
            onClick={(event) => {
              event.preventDefault();
              onOpenPath(target.href);
            }}
          >
            {children}
          </a>
        );
      }
      // Unsafe or unresolvable targets keep their text but lose the navigation.
      return <>{children}</>;
    },
    img({ src, alt }) {
      return <span className="artifact-image-ref">{alt || src || "image"}</span>;
    },
    code({ className, children }) {
      return <code className={className}>{children}</code>;
    },
  };

  return (
    <div className="artifact-markdown">
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema]]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}
