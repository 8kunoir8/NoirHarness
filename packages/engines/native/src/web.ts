import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIPv4, isIPv6, type LookupFunction } from "node:net";

/**
 * Addresses a fetch may not reach. The kernel runs on the user's machine, so the interesting
 * failure is not a hostile remote host: it is a model that can reach the machine's own services,
 * the router, or a link-local metadata endpoint. `BlockList` does the prefix arithmetic.
 */
const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["255.255.255.255", 32],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");
}

/** An IPv4-mapped IPv6 address is the IPv4 address; `::ffff:127.0.0.1` is loopback. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const target = mapped?.[1] ?? address;
  if (isIPv4(target)) return PRIVATE_RANGES.check(target, "ipv4");
  if (isIPv6(target)) return PRIVATE_RANGES.check(target, "ipv6");
  // Not an address at all: fail closed rather than let an unparsed form through.
  return true;
}

const REQUEST_TIMEOUT_MS = 20_000;
const IDLE_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "NoirHarness/0.1";
const ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8";

export interface FetchPageOptions {
  /** Tests talk to a loopback server; the tool never sets this. */
  allowPrivate?: boolean;
}

export interface FetchPageResult {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
  /** After redirects: the URL the body came from, so relative links resolve correctly. */
  finalUrl: string;
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * The `lookup` given to `net.connect`: every address the host resolves to is checked, and the
 * connection uses that same answer. Validating separately and then connecting with `fetch` would
 * leave a window in which a second resolution returns something else.
 */
function guardedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options.family, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);
        return;
      }
      const first = addresses[0];
      if (first === undefined) {
        callback(new Error(`No address for ${hostname}`), "", 0);
        return;
      }
      if (!allowPrivate) {
        const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
        if (blocked !== undefined) {
          callback(new Error(`${hostname} resolves to a private address`), "", 0);
          return;
        }
      }
      callback(null, first.address, first.family);
    });
  };
}

function requestOnce(target: URL, signal: AbortSignal, allowPrivate: boolean): Promise<RawResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  let settled = false;

  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(overall);
    request.destroy();
    reject(error);
  };

  const request = send(
    target,
    {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: ACCEPT,
        // No compression: decompression is a second way to exceed the cap, and a decompression bomb.
        "accept-encoding": "identity",
      },
      lookup: guardedLookup(allowPrivate),
    },
    (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settledResponse = false;
      const finish = (): void => {
        if (settledResponse) return;
        settledResponse = true;
        request.destroy();
        if (!settled) {
          settled = true;
          clearTimeout(overall);
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        }
      };
      response.on("data", (chunk: Buffer) => {
        if (size >= MAX_BODY_BYTES) return;
        const room = MAX_BODY_BYTES - size;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(kept);
        size += kept.length;
        if (size >= MAX_BODY_BYTES) {
          response.destroy();
          finish();
        }
      });
      response.on("end", finish);
      // A destroyed response never emits "end"; both paths settle through the same guard.
      response.on("close", finish);
      response.on("error", fail);
    },
  );

  const overall = setTimeout(() => {
    fail(new Error(`No response from ${target.host} within ${REQUEST_TIMEOUT_MS / 1000} s`));
  }, REQUEST_TIMEOUT_MS);

  request.setTimeout(IDLE_TIMEOUT_MS, () => {
    fail(new Error(`The response from ${target.host} stalled for ${IDLE_TIMEOUT_MS / 1000} s`));
  });
  request.on("error", (error: Error) => {
    fail(error);
  });
  const onAbort = (): void => {
    fail(new Error("Fetch aborted."));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  request.on("close", () => {
    signal.removeEventListener("abort", onAbort);
  });

  if (signal.aborted) onAbort();
  else request.end();

  return promise;
}

/** One GET, following redirects. Every hop is a fresh request, so every hop is re-validated. */
export async function fetchPage(
  url: string,
  signal: AbortSignal,
  options: FetchPageOptions = {},
): Promise<FetchPageResult> {
  let target = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await requestOnce(target, signal, options.allowPrivate === true);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && typeof location === "string" && location !== "") {
      target = new URL(location, target);
      continue;
    }
    return {
      status: response.status,
      statusText: response.statusText,
      contentType: (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
      body: response.body.toString("utf8"),
      finalUrl: target.toString(),
    };
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}`);
}
