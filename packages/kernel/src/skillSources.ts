import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ErrorCodes, RpcFault } from "@noir/protocol";

export type FetchTarget =
  | { kind: "git"; url: string; ref: string | undefined }
  | { kind: "local"; path: string };

/** Hostnames that may be reached over plain `http`. A whole-host comparison, never a prefix. */
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export function parseGitTarget(source: string, ref: string | undefined): FetchTarget {
  if (ref !== undefined && !REF.test(ref)) throw new RpcFault(ErrorCodes.invalidParams, `Invalid ref: ${ref}`);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new RpcFault(ErrorCodes.invalidParams, `${source} is not a URL`);
  }
  // `ext::` reaches a remote command; `C:\x` parses as protocol `c:`; both fall out here.
  const loopback = LOOPBACK_HOSTS[url.hostname] === true;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new RpcFault(ErrorCodes.invalidParams, `${url.protocol} is not an accepted transport`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new RpcFault(ErrorCodes.invalidParams, "A skill source URL must not carry credentials");
  }
  return { kind: "git", url: url.href, ref };
}

/** Resolves a `local` target to a real directory; a link is refused rather than followed. */
export async function parseLocalTarget(source: string): Promise<FetchTarget> {
  if (!isAbsolute(source)) throw new RpcFault(ErrorCodes.invalidParams, "A local skill source must be an absolute path");
  const marker = await lstat(source).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RpcFault(ErrorCodes.invalidParams, `${source} is not a directory`);
    }
    throw error;
  });
  if (marker.isSymbolicLink()) throw new RpcFault(ErrorCodes.invalidParams, `${source} is a symlink`);
  if (!marker.isDirectory()) throw new RpcFault(ErrorCodes.invalidParams, `${source} is not a directory`);
  return { kind: "local", path: source };
}
