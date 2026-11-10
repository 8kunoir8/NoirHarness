import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { ErrorCodes, RpcFault } from "@noir/protocol";

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Wire paths are relative and `/`-separated, whatever the host separator is. */
export function relativePath(value: string): string {
  if (value.includes("\\")) {
    throw new RpcFault(ErrorCodes.invalidParams, `Path must use "/" separators: ${value}`);
  }
  if (isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new RpcFault(ErrorCodes.invalidParams, `Path must be relative: ${value}`);
  }
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new RpcFault(ErrorCodes.invalidParams, `Path must not contain "..": ${value}`);
  }
  return segments.join("/");
}

/**
 * Real path of the deepest existing ancestor, with the not-yet-created tail re-appended,
 * so a new file is still checked through its symlinked ancestors.
 * Only ENOENT/ENOTDIR mean "not created yet"; anything else fails closed.
 */
function canonicalize(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      if (!isMissing(error)) {
        throw new RpcFault(ErrorCodes.invalidParams, `Path cannot be resolved: ${current}`);
      }
      try {
        lstatSync(current);
      } catch (statError) {
        if (!isMissing(statError)) {
          throw new RpcFault(ErrorCodes.invalidParams, `Path cannot be inspected: ${current}`);
        }
        const parent = dirname(current);
        if (parent === current) {
          throw new RpcFault(ErrorCodes.invalidParams, `Path cannot be resolved: ${path}`);
        }
        tail.unshift(basename(current));
        current = parent;
        continue;
      }
      // Visible to lstat but not realpath: a dangling link, a link loop, or a permissions problem.
      throw new RpcFault(ErrorCodes.invalidParams, `Path cannot be resolved: ${current}`);
    }
  }
}

function escapes(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

export function resolveInsideRoot(root: string, value: string): string {
  // `root` is trusted: the kernel recorded it after a realpath check when the project was added.
  const rel = relativePath(value);
  const canonicalRoot = canonicalize(root);
  if (rel === "") return canonicalRoot;
  const target = canonicalize(join(root, ...rel.split("/")));
  if (escapes(canonicalRoot, target)) {
    throw new RpcFault(ErrorCodes.invalidParams, `Path escapes the workspace: ${target}`);
  }
  return target;
}
