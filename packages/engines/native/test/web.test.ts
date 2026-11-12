import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { EnginePermissionRequest } from "@noir/engine-core";
import { PERMISSION_DENIED, runTool, toolKind, toolTitle, type ToolContext } from "../src/tools.js";
import { fetchPage, formatPage, guardedLookup, isPrivateAddress, type FetchPageResult } from "../src/web.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.3.9",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "224.0.0.1",
    "240.0.0.1",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
  ])("refuses %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"])(
    "allows %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

interface Site {
  url: string;
  close(): Promise<void>;
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Site> {
  const server = createServer(handler);
  const listening = Promise.withResolvers<void>();
  // Without this a bind failure leaves the promise pending and the suite hangs to its timeout.
  server.on("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

describe("guardedLookup", () => {
  // Every other test talks to an address literal, and `net.connect` never calls `lookup` for one.
  // That is how a callback shape Node rejects ("Invalid IP address") reached a commit: the shape is
  // only exercised by a name, so it is asserted here against `localhost`, which resolves offline.
  function resolve(options: { all?: boolean; family?: number }): Promise<{
    error: Error | null;
    address: unknown;
    family: number | undefined;
  }> {
    const done = Promise.withResolvers<{ error: Error | null; address: unknown; family: number | undefined }>();
    guardedLookup(true)("localhost", options, (error, address, family) => {
      done.resolve({ error: error ?? null, address, family });
    });
    return done.promise;
  }

  it("answers the array shape when net.connect asks for all addresses", async () => {
    const { error, address } = await resolve({ all: true });
    expect(error).toBeNull();
    expect(Array.isArray(address)).toBe(true);
    const entries = address as Array<{ address: string; family: number }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => typeof entry.address === "string" && typeof entry.family === "number")).toBe(
      true,
    );
  });

  it("answers a single address when it is not asked for all", async () => {
    const { error, address, family } = await resolve({ family: 4 });
    expect(error).toBeNull();
    expect(typeof address).toBe("string");
    expect(family).toBe(4);
  });

  it("refuses a name that resolves to a private address", async () => {
    const done = Promise.withResolvers<Error | null>();
    guardedLookup(false)("localhost", { all: true }, (error) => done.resolve(error ?? null));
    expect((await done.promise)?.message).toMatch(/private address/);
  });
});

describe("fetchPage", () => {
  it("returns the body and status of a request", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>Hi</h1><p>there</p>");
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, { allowLoopback: true });
      expect(page.status).toBe(200);
      expect(page.contentType).toContain("text/html");
      expect(page.body).toContain("<h1>Hi</h1>");
      expect(page.finalUrl).toBe(site.url);
    } finally {
      await site.close();
    }
  });
});

describe("fetchPage refusals", () => {
  it("refuses a host that resolves to a private address when private targets are not allowed", async () => {
    const site = await serve((_req, res) => res.end("secret"));
    try {
      await expect(fetchPage(site.url, new AbortController().signal)).rejects.toThrow(/private address/);
    } finally {
      await site.close();
    }
  });

  it("refuses a scheme that is not HTTP", async () => {
    await expect(fetchPage("file:///etc/passwd", new AbortController().signal)).rejects.toThrow(/http/i);
    await expect(fetchPage("ftp://example.com/x", new AbortController().signal)).rejects.toThrow(/http/i);
  });

  it("refuses an IPv4-mapped IPv6 literal, which net.connect connects to without DNS", async () => {
    const signal = new AbortController().signal;
    // Node normalizes every spelling of the mapping to hex, so the dotted form never reaches us.
    await expect(fetchPage("http://[::ffff:127.0.0.1]/", signal)).rejects.toThrow(/private address/);
    await expect(fetchPage("http://[::ffff:10.0.0.1]/", signal)).rejects.toThrow(/private address/);
    await expect(fetchPage("http://[::ffff:169.254.169.254]/", signal)).rejects.toThrow(/private address/);
  });

  it("refuses a URL that carries credentials instead of sending them", async () => {
    let reached = false;
    const site = await serve((_req, res) => {
      reached = true;
      res.end("x");
    });
    try {
      // `node:http` turns userinfo into `Authorization: Basic`, which the tool must never send.
      const withCredentials = site.url.replace("http://", "http://user:pw@");
      await expect(fetchPage(withCredentials, new AbortController().signal, { allowLoopback: true })).rejects.toThrow(
        /credentials/,
      );
      expect(reached).toBe(false);
    } finally {
      await site.close();
    }
  });

  it("refuses a host that names itself local", async () => {
    for (const host of [
      "printer.local",
      "localhost:1",
      "localhost.",
      "LOCALHOST",
      "nas.internal",
      "router.home.arpa",
      "thing.localhost",
    ]) {
      // Decided from the name, before DNS: an offline name cannot be proven private by its answer.
      await expect(fetchPage(`http://${host}/`, new AbortController().signal)).rejects.toThrow(/local/i);
    }
  });

  it("refuses the IPv6 loopback and the unspecified address as literals", async () => {
    for (const host of ["[::1]", "[::]"]) {
      await expect(fetchPage(`http://${host}:1/`, new AbortController().signal)).rejects.toThrow(/private/i);
    }
  });

  it("re-validates each redirect target", async () => {
    const far = await serve((_req, res) => {
      res.writeHead(302, { location: "http://10.0.0.1/" });
      res.end();
    });
    try {
      await expect(fetchPage(far.url, new AbortController().signal, { allowLoopback: true })).rejects.toThrow(
        /private address/,
      );
    } finally {
      await far.close();
    }
  });

  it("names a redirect it cannot follow", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(302, { location: "http://[::zz]/" });
      res.end();
    });
    try {
      await expect(fetchPage(site.url, new AbortController().signal, { allowLoopback: true })).rejects.toThrow(
        /unusable location/,
      );
    } finally {
      await site.close();
    }
  });

  it("sends exactly three headers, and asks for identity", async () => {
    // The page decides what it sees; a browser fingerprint or a cookie would be a different tool.
    let seen: Record<string, string | string[] | undefined> = {};
    const site = await serve((req, res) => {
      seen = req.headers;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    try {
      await fetchPage(site.url, new AbortController().signal, { allowLoopback: true });
      // `connection` is added by Node's own client, not by the tool.
      expect(Object.keys(seen).sort()).toEqual(["accept", "accept-encoding", "connection", "host", "user-agent"]);
      expect(seen["accept-encoding"]).toBe("identity");
      expect(seen["user-agent"]).toBe("NoirHarness/0.1");
      expect(seen["authorization"]).toBeUndefined();
      expect(seen["cookie"]).toBeUndefined();
    } finally {
      await site.close();
    }
  });

  it("refuses a body that arrived compressed despite asking for identity", async () => {
    const site = await serve((_req, res) => {
      // Servers do this: `identity` is a request, not a guarantee.
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]));
    });
    try {
      await expect(fetchPage(site.url, new AbortController().signal, { allowLoopback: true })).rejects.toThrow(
        /compressed/i,
      );
    } finally {
      await site.close();
    }
  });

  it("holds one deadline across the whole redirect chain", async () => {
    // Each hop used to get its own 20 s budget, so six hops could hold a turn for two minutes.
    let hop = 0;
    const site = await serve((_req, res) => {
      hop += 1;
      setTimeout(() => {
        res.writeHead(302, { location: `/${hop + 1}` });
        res.end();
      }, 120);
    });
    try {
      const started = Date.now();
      await expect(
        fetchPage(site.url, new AbortController().signal, { allowLoopback: true, timeouts: { totalMs: 400 } }),
      ).rejects.toThrow(/No response|redirects/);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(hop).toBeLessThan(6);
    } finally {
      await site.close();
    }
  });

  it("stops after five redirects instead of chasing a loop", async () => {
    let hop = 0;
    const site = await serve((_req, res) => {
      hop += 1;
      res.writeHead(302, { location: `/${hop + 1}` });
      res.end();
    });
    try {
      await expect(fetchPage(site.url, new AbortController().signal, { allowLoopback: true })).rejects.toThrow(
        /redirects/,
      );
      expect(hop).toBe(6);
    } finally {
      await site.close();
    }
  });

  it("follows a redirect within the allowed hops", async () => {
    const inner = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>landed</p>");
    });
    const outer = await serve((_req, res) => {
      res.writeHead(302, { location: inner.url });
      res.end();
    });
    try {
      const page = await fetchPage(outer.url, new AbortController().signal, { allowLoopback: true });
      expect(page.status).toBe(200);
      expect(page.body).toContain("landed");
      expect(page.finalUrl).toBe(inner.url);
    } finally {
      await outer.close();
      await inner.close();
    }
  });
});

describe("fetchPage limits", () => {
  it("cuts the body at the 2 MiB cap instead of buffering it", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = "x".repeat(64 * 1024);
      for (let i = 0; i < 64; i++) res.write(chunk);
      res.end();
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, { allowLoopback: true });
      expect(Buffer.byteLength(page.body)).toBe(2 * 1024 * 1024);
    } finally {
      await site.close();
    }
  });

  it("fails a response that stalls after its headers", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("start");
    });
    try {
      const signal = new AbortController().signal;
      await expect(
        fetchPage(site.url, signal, { allowLoopback: true, timeouts: { idleMs: 100, totalMs: 10_000 } }),
      ).rejects.toThrow(/stalled/);
    } finally {
      await site.close();
    }
  });

  it("fails a request that never answers", async () => {
    const site = await serve(() => {
      // Accept the request and never respond.
    });
    try {
      await expect(
        fetchPage(site.url, new AbortController().signal, { allowLoopback: true, timeouts: { totalMs: 150 } }),
      ).rejects.toThrow(/No response|aborted|socket/i);
    } finally {
      await site.close();
    }
  });

  it("decodes a Latin-1 page by its declared charset", async () => {
    const text = "caf\u00e9 cr\u00e8me";
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      res.end(Buffer.from(`<p>${text}</p>`, "latin1"));
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, { allowLoopback: true });
      expect(page.body).toContain(text);
      expect(page.body).not.toContain("\ufffd");
      expect(formatPage(page)).toBe(text);
    } finally {
      await site.close();
    }
  });

  it("falls back to the charset the document declares in a meta tag", async () => {
    // CP1252 quotes are 0x93/0x94, which UTF-8 would show as replacement characters.
    const body = Buffer.concat([
      Buffer.from('<meta charset="windows-1252"><p>', "latin1"),
      Buffer.from([0x93]),
      Buffer.from("quoted", "latin1"),
      Buffer.from([0x94]),
      Buffer.from("</p>", "latin1"),
    ]);
    const site = await serve((_req, res) => {
      // No charset in the header, only in the markup.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, { allowLoopback: true });
      expect(page.body).toContain("\u201cquoted\u201d");
    } finally {
      await site.close();
    }
  });

  it("falls back to UTF-8 for a charset label it cannot use", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=x-not-a-charset" });
      res.end("plain \u00e9");
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, { allowLoopback: true });
      expect(page.body).toBe("plain \u00e9");
    } finally {
      await site.close();
    }
  });

  it("reports the size a binary body declares, not the cap it was stopped at", async () => {
    const declared = 5 * 1024 * 1024;
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(declared) });
      // Only enough to cross the 2 MiB cap: the refusal must still say 5 MiB, not 2 MiB.
      res.write(Buffer.alloc(2 * 1024 * 1024 + 4_096, 1));
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, {
        allowLoopback: true,
        timeouts: { idleMs: 2_000 },
      });
      expect(page.bytes).toBe(declared);
      expect(formatPage(page)).toBe(`image/png, ${declared} bytes — binary content is not returned`);
    } finally {
      await site.close();
    }
  });

  it("counts a binary body without holding it", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.alloc(512 * 1024, 7));
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, { allowLoopback: true });
      expect(page.bytes).toBe(512 * 1024);
      expect(page.body).toBe("");
      expect(formatPage(page)).toBe("image/png, 524288 bytes — binary content is not returned");
    } finally {
      await site.close();
    }
  });

  it("fails a response whose body stops before its Content-Length", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "50" });
      res.write("only part");
      // Drop the socket without finishing the body.
      setTimeout(() => res.socket?.destroy(), 20);
    });
    try {
      await expect(
        fetchPage(site.url, new AbortController().signal, { allowLoopback: true, timeouts: { idleMs: 5_000 } }),
      ).rejects.toThrow(/before|incomplete|closed/i);
    } finally {
      await site.close();
    }
  });

  it("aborts a fetch when the turn is interrupted", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("start");
    });
    const controller = new AbortController();
    try {
      const pending = fetchPage(site.url, controller.signal, { allowLoopback: true, timeouts: { idleMs: 5_000 } });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toThrow(/aborted/);
    } finally {
      await site.close();
    }
  });
});

describe("formatPage", () => {
  const page = (overrides: Partial<FetchPageResult> = {}): FetchPageResult => {
    const body = overrides.body ?? "<h1>Doc</h1><p>body</p>";
    return {
      status: 200,
      statusText: "OK",
      contentType: "text/html",
      body,
      bytes: Buffer.byteLength(body),
      finalUrl: "https://example.test/page",
      ...overrides,
    };
  };

  it("extracts HTML as readable text", () => {
    expect(formatPage(page())).toBe("# Doc\n\nbody");
  });

  it("resolves relative links against the final URL", () => {
    expect(formatPage(page({ body: '<a href="/next">Next</a>' }))).toBe("[Next](https://example.test/next)");
  });

  it("pretty-prints JSON", () => {
    expect(formatPage(page({ contentType: "application/json", body: '{"a":1,"b":[2]}' }))).toBe(
      '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}',
    );
  });

  it("returns plain text unchanged", () => {
    expect(formatPage(page({ contentType: "text/plain", body: "as-is" }))).toBe("as-is");
  });

  it("does not let a deeply nested JSON body amplify into megabytes", () => {
    // Pretty-printing indents by depth, so a 6 KB body nested 3,000 deep would build ~18 MB before
    // the 64 KiB cap ever ran, on the kernel thread. Past the budget the body is returned as it is.
    const deep = "[".repeat(3_000) + "]".repeat(3_000);
    const out = formatPage(page({ contentType: "application/json", body: deep, bytes: deep.length }));
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(deep.length * 4);

    // A body that is merely large is not deep, and still gets its indentation.
    const wide = JSON.stringify(Array.from({ length: 400 }, (_whole, index) => ({ index })));
    expect(formatPage(page({ contentType: "application/json", body: wide, bytes: wide.length }))).toContain(
      "\n  {",
    );
  });

  it("names a missing content type instead of guessing", () => {
    expect(formatPage(page({ contentType: "", body: "<!doctype html><p>body</p>" }))).toBe(
      "unknown type, 26 bytes — binary content is not returned",
    );
  });

  it("reports a binary content type instead of returning its bytes", () => {
    expect(formatPage(page({ contentType: "image/png", body: "\u0089PNG" }))).toBe(
      "image/png, 5 bytes — binary content is not returned",
    );
  });
});

describe("web.fetch", () => {
  const okay = (overrides: Partial<FetchPageResult> = {}): FetchPageResult => ({
    status: 200,
    statusText: "OK",
    contentType: "text/html",
    body: "<h1>Doc</h1><p>body</p>",
    bytes: 22,
    finalUrl: "https://example.test/page",
    ...overrides,
  });

  function context(fetched: FetchPageResult, overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      sessionId: "session-1",
      workspaceRoot: process.cwd(),
      signal: new AbortController().signal,
      onPermission: async () => "allow_once",
      skills: [],
      readSkill: async (name) => {
        throw new Error(`no skill ${name}`);
      },
      // The tool order: approve, then fetch. Injecting the fetch keeps runTool's own path guarded.
      fetchPage: async () => fetched,
      ...overrides,
    };
  }

  it("asks for network approval and returns the page as readable text", async () => {
    const onPermission = vi.fn(async (_request: EnginePermissionRequest) => "allow_once" as const);
    const out = await runTool("web.fetch", { url: "https://example.test/page" }, context(okay(), { onPermission }));
    expect(out).toBe("# Doc\n\nbody");
    expect(onPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCall: expect.objectContaining({ kind: "fetch", title: "Fetch https://example.test/page" }),
      }),
    );
  });

  it("does not fetch when the user rejects", async () => {
    const fetchSpy = vi.fn(async () => okay());
    const out = await runTool(
      "web.fetch",
      { url: "https://example.test/page" },
      context(okay(), { onPermission: async () => "reject" as const, fetchPage: fetchSpy }),
    );
    expect(out).toBe(PERMISSION_DENIED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prefixes a non-2xx status so the model sees it", async () => {
    const out = await runTool(
      "web.fetch",
      { url: "https://example.test/gone" },
      context(okay({ status: 404, statusText: "Not Found", contentType: "text/plain", body: "no page" })),
    );
    expect(out).toBe("HTTP 404 Not Found\n\nno page");
  });

  it("caps the text it returns at 64 KiB", async () => {
    const body = "x".repeat(70 * 1024);
    const out = await runTool(
      "web.fetch",
      { url: "https://example.test/big" },
      context(okay({ contentType: "text/plain", body, bytes: body.length })),
    );
    expect(Buffer.byteLength(out)).toBe(64 * 1024 + "\n[truncated]".length);
    expect(out.endsWith("[truncated]")).toBe(true);
  });

  it("refuses a private target even after the user allows the fetch", async () => {
    const site = await serve((_req, res) => res.end("secret"));
    try {
      // No injected page: the tool takes the guarded path, which a private URL cannot pass.
      const { fetchPage: _omit, ...withoutSeam } = context(okay());
      await expect(runTool("web.fetch", { url: site.url }, withoutSeam)).rejects.toThrow(/private address/);
    } finally {
      await site.close();
    }
  });

  it("titles the tool call with the URL", () => {
    expect(toolTitle("web.fetch", { url: "https://example.test/a" })).toBe("Fetch https://example.test/a");
    expect(toolKind("web.fetch")).toBe("fetch");
  });
});
