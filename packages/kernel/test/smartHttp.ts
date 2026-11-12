import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

/** Runs git with a fixed identity, so a fixture never depends on the machine's git config. */
export const git = (cwd: string, args: string[]): string => {
  const result = spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

/** A repo at `dir` containing one skill directory, committed. */
export function skillRepo(dir: string, name: string, body = "BODY"): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`);
  git(dir, ["init", "-q", "-b", "main", "."]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "one"]);
}

/**
 * Serves `bareDir` over the smart protocol. The dumb protocol cannot clone `--depth 1`, so the
 * fixture must go through `git http-backend`.
 */
export async function serveSmartHttp(bareDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: bareDir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        CONTENT_LENGTH: String(req.headers["content-length"] ?? ""),
      },
    });
    req.pipe(child.stdin);
    let headersDone = false;
    let buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) return void res.write(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      headersDone = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of buffer.subarray(0, end).toString().split("\r\n")) {
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.write(buffer.subarray(end + 4));
    });
    child.on("close", () => {
      if (!headersDone) res.writeHead(500);
      res.end();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}
