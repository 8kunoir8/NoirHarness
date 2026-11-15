import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

/** A fixed table beats `mime-types`: the shell is a Vite build, so the extension set is known. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface Asset {
  file: string;
  contentType: string;
  /** `index.html` must never be cached; a hashed asset may be cached forever. */
  immutable: boolean;
}

function withinRoot(root: string, candidate: string): boolean {
  const base = resolve(root);
  return candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Map a URL path to a file under `root`. A directory or an extensionless path is an SPA route and
 * gets `index.html`; a missing file with an extension is a 404, not a page that pretends to exist.
 */
export function resolveAsset(root: string, pathname: string): Asset | undefined {
  if (pathname.includes("\0") || pathname.includes("%00")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("..")) return undefined;

  const candidate = resolve(root, `.${decoded}`);
  if (!withinRoot(root, candidate)) return undefined;

  const index = resolve(root, "index.html");
  const html: Asset = { file: index, contentType: TYPES[".html"] ?? "text/html", immutable: false };
  try {
    const stat = statSync(candidate);
    if (stat.isDirectory()) return html;
    const ext = extname(candidate).toLowerCase();
    return {
      file: candidate,
      contentType: TYPES[ext] ?? "application/octet-stream",
      // Vite content-hashes the filename, so the bytes behind it cannot change.
      immutable: ext !== ".html",
    };
  } catch {
    return extname(decoded) === "" ? html : undefined;
  }
}

/** Answer the request when the path names something servable; `false` leaves it to the caller. */
export function serveAsset(req: IncomingMessage, res: ServerResponse, root: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const asset = resolveAsset(root, pathname);
  if (asset === undefined) return false;
  let body: Buffer;
  try {
    body = readFileSync(asset.file);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": body.length,
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
