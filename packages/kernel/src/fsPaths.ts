import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ErrorCodes, RpcFault } from "@noir/protocol";

/** Wire paths are relative and `/`-separated, whatever the host separator is. */
export function relativePath(value: string): string {
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("\\\\")) {
    throw new RpcFault(ErrorCodes.invalidParams, `Path must be relative: ${value}`);
  }
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new RpcFault(ErrorCodes.invalidParams, `Path must not contain "..": ${value}`);
  }
  return segments.join("/");
}

/** Real path of the deepest existing ancestor, so a not-yet-created file is still checked. */
function realAncestor(path: string): string {
  let current = path;
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new RpcFault(ErrorCodes.invalidParams, `Path escapes the workspace: ${target}`);
  }
}

export function resolveInsideRoot(root: string, value: string): string {
  const rel = relativePath(value);
  const absolute = rel === "" ? root : join(root, ...rel.split("/"));
  if (rel !== "") assertInside(realAncestor(root), realAncestor(absolute));
  return absolute;
}
