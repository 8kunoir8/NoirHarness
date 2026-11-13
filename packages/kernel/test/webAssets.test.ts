import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAsset, serveAsset } from "../src/webAssets.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "noir web "));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "style.css"), "body{}");
  writeFileSync(join(dir, "assets", "inter.woff2"), "font");
  writeFileSync(join(dir, "secret.txt"), "do not serve me");
  return dir;
}

describe("asset resolution", () => {
  let dir: string;
  beforeEach(() => {
    dir = root();
  });

  it("serves index for the root and for an extensionless route", () => {
    expect(resolveAsset(dir, "/")?.file).toBe(join(dir, "index.html"));
    expect(resolveAsset(dir, "/pair")?.file).toBe(join(dir, "index.html"));
    expect(resolveAsset(dir, "/pair")?.immutable).toBe(false);
  });

  it("names the type and the caching for an asset", () => {
    const asset = resolveAsset(dir, "/assets/app.js");
    expect(asset?.contentType).toContain("javascript");
    expect(asset?.immutable).toBe(true);
    expect(resolveAsset(dir, "/assets/style.css")?.contentType).toContain("text/css");
    expect(resolveAsset(dir, "/assets/inter.woff2")?.contentType).toBe("font/woff2");
  });

  it("404s a missing file that claims an extension", () => {
    expect(resolveAsset(dir, "/assets/gone.js")).toBeUndefined();
    expect(resolveAsset(dir, "/nothing.json")).toBeUndefined();
  });

  it("refuses to leave the root, however the path is written", () => {
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/a/../../secret.txt", "/%00"]) {
      expect(resolveAsset(dir, path)).toBeUndefined();
    }
    // A file that exists outside the root is still not reachable by an encoded climb.
    expect(resolveAsset(join(dir, "assets"), "/../secret.txt")).toBeUndefined();
  });

  it("does not fall back to index for a traversal attempt", () => {
    // A traversal is not a route; answering with the shell would hide the refusal.
    expect(resolveAsset(dir, "/..%5c..%5csecret.txt")).toBeUndefined();
  });
});

describe("asset serving", () => {
  let dir: string;
  beforeEach(() => {
    dir = root();
  });

  function reply(method: string, url: string): { handled: boolean; status: number; headers: Record<string, string>; body: string } {
    const headers: Record<string, string> = {};
    let status = 0;
    let body = "";
    const res = {
      writeHead: (code: number, given: Record<string, string | number>) => {
        status = code;
        for (const [key, value] of Object.entries(given)) headers[key] = String(value);
        return res;
      },
      end: (payload?: string | Buffer) => {
        if (payload !== undefined) body = String(payload);
        return res;
      },
    };
    const handled = serveAsset({ method, url } as never, res as never, dir);
    return { handled, status, headers, body };
  }

  it("writes the bytes with a immutable cache for hashed assets", () => {
    const got = reply("GET", "/assets/app.js");
    expect(got.handled).toBe(true);
    expect(got.status).toBe(200);
    expect(got.body).toBe("console.log(1)");
    expect(got.headers["cache-control"]).toContain("immutable");
  });

  it("never caches the shell", () => {
    expect(reply("GET", "/").headers["cache-control"]).toBe("no-store");
  });

  it("answers a HEAD without a body", () => {
    const got = reply("HEAD", "/assets/style.css");
    expect(got.status).toBe(200);
    expect(got.body).toBe("");
    expect(got.headers["content-length"]).toBe("6");
  });

  it("leaves a write and an unservable path to the caller", () => {
    expect(reply("POST", "/assets/app.js").handled).toBe(false);
    expect(reply("GET", "/assets/gone.js").handled).toBe(false);
  });
});
