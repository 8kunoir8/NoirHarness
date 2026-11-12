import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { fetchPage, isPrivateAddress } from "../src/web.js";

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
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
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

describe("fetchPage", () => {
  it("returns the body and status of a request", async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>Hi</h1><p>there</p>");
    });
    try {
      const page = await fetchPage(site.url, new AbortController().signal, { allowPrivate: true });
      expect(page.status).toBe(200);
      expect(page.contentType).toContain("text/html");
      expect(page.body).toContain("<h1>Hi</h1>");
      expect(page.finalUrl).toBe(site.url);
    } finally {
      await site.close();
    }
  });
});
