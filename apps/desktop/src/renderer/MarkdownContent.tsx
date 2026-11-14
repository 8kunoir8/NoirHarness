import { useEffect, useState } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type { ArtifactReadResult } from "@noir/protocol";
import type { RequestFn } from "./api.js";

/**
 * GFM output only. Everything outside this set — including raw HTML, scripts, and `on*`
 * handlers — is removed before React renders it; `href` cannot leave `http`, `https` or
 * `mailto`. Images are the one exception: a chat answer that references a chart has to show it,
 * so `src` also allows `data:` — the renderer builds those itself from a workspace file.
 */
const schema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: ["http", "https", "mailto"],
    src: ["http", "https", "data"],
  },
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

/** Image types the kernel hands back as base64, keyed the way `readArtifact` keys them. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

function mimeOf(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : IMAGE_MIME[path.slice(dot).toLowerCase()];
}

/** Absolute sources load on their own; anything else names a file inside the workspace. */
function isAbsolute(src: string): boolean {
  return /^(https?|data):/i.test(src);
}

type ImageState = { status: "loading" } | { status: "ready"; url: string } | { status: "failed" };

export interface MarkdownImages {
  workspaceId: string;
  request: RequestFn;
}

function MarkdownImage({ src, alt, images }: { src?: string | undefined; alt?: string | undefined; images: MarkdownImages }) {
  const [state, setState] = useState<ImageState>({ status: "loading" });

  useEffect(() => {
    if (src === undefined || isAbsolute(src)) return;
    const mime = mimeOf(src);
    if (mime === undefined) {
      setState({ status: "failed" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    images
      .request<ArtifactReadResult>("artifact.read", { workspaceId: images.workspaceId, path: src })
      .then((result) => {
        // Only a binary read is a picture; anything else would be text pretending to be one.
        if (!live) return;
        setState(result.encoding === "base64" ? { status: "ready", url: `data:${mime};base64,${result.content}` } : { status: "failed" });
      })
      .catch(() => {
        if (live) setState({ status: "failed" });
      });
    // JSON-RPC has no cancellation: ignore a reply whose message scrolled away or re-rendered.
    return () => {
      live = false;
    };
  }, [src, images]);

  const label = alt === undefined || alt === "" ? (src ?? "image") : alt;
  if (src === undefined) return <span className="artifact-image-ref">{label}</span>;
  if (state.status === "failed") return <span className="artifact-image-ref">{label}</span>;
  if (state.status === "loading" && !isAbsolute(src)) return <span className="artifact-image-ref">{label}</span>;
  return <img src={isAbsolute(src) ? src : state.status === "ready" ? state.url : src} alt={label} loading="lazy" />;
}

export interface MarkdownContentProps {
  content: string;
  /** Opens a workspace-relative link; without it, links keep their text and lose navigation. */
  onOpenPath?: ((path: string) => void) | undefined;
  /**
   * Renders workspace images inline, through `artifact.read`. Without it an image keeps a text
   * reference, which is what a preview tab wants: it names the file instead of re-drawing it.
   */
  images?: MarkdownImages | undefined;
  /** `chat` loosens the block styles for a bubble; `artifact` keeps the document look. */
  variant?: "artifact" | "chat" | undefined;
}

export function MarkdownContent({ content, onOpenPath, images, variant = "artifact" }: MarkdownContentProps) {
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
      if (images === undefined) return <span className="artifact-image-ref">{alt || src || "image"}</span>;
      return <MarkdownImage src={src} alt={alt} images={images} />;
    },
    // A wide table scrolls on its own instead of stretching the bubble past the transcript.
    table({ children }) {
      return (
        <div className="markdown-table">
          <table>{children}</table>
        </div>
      );
    },
    code({ className, children }) {
      return <code className={className}>{children}</code>;
    },
  };

  return (
    // Two documents, two layouts: the preview tab pads and scrolls like a page, a bubble does not.
    <div className={variant === "chat" ? "markdown-chat" : "artifact-markdown"}>
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
