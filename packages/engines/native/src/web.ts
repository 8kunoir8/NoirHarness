import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIPv4, isIPv6, type LookupFunction } from "node:net";
import { TextDecoder } from "node:util";
import { htmlToText } from "./htmlText.js";

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
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
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
  // Wrappers that carry an IPv4 target: a translator or relay on the host's path would reach it,
  // and refusing them costs a page nothing. `::ffff:0:0/96` is deliberately absent — it is how
  // `BlockList` itself represents every IPv4 address, so listing it refuses the whole internet.
  ["64:ff9b::", 96],
  ["2002::", 16],
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
/**
 * Pretty-printing indents by nesting depth, so a 6 KB body nested 3,000 deep builds about 18 MB
 * before the 64 KiB cap is applied — on the kernel thread, from a page nobody reviewed. Past this
 * budget the body is returned as it arrived, which is still the JSON it was.
 */
const MAX_PRETTY_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "NoirHarness/0.1";
const ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8";

export interface FetchPageOptions {
  /**
   * The tests talk to a server on 127.0.0.1; everything else stays refused. The tool never sets
   * this, so a caller cannot widen the guard by passing a flag.
   */
  allowLoopback?: boolean;
  /** Shrunk by the timeout tests. The tool never sets it. */
  timeouts?: { totalMs?: number; idleMs?: number };
}

/** Names that point at the local machine or its network, refused before DNS. */
const REFUSED_HOSTS: Record<string, true> = { localhost: true };
const REFUSED_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa"];

function isLoopback(address: string): boolean {
  return address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address);
}

export interface FetchPageResult {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
  /** Bytes received on the wire, which is what a binary refusal should report. */
  bytes: number;
  /** After redirects: the URL the body came from, so relative links resolve correctly. */
  finalUrl: string;
}

interface RawResponse {
  status: number;
  statusText: string;
  headers: IncomingHttpHeaders;
  /** Empty for a type that is not textual: its bytes were counted, not kept. */
  body: Buffer;
  bytes: number;
}

/** The length the server declared, when it declared one that is larger than what arrived. */
function declaredLength(header: string | undefined): number {
  if (header === undefined) return 0;
  const value = Number(header);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** The type without its parameters: `text/html; charset=iso-8859-1` becomes `text/html`. */
function bareType(header: string): string {
  return (header.split(";")[0] ?? "").trim().toLowerCase();
}

const TEXTUAL =
  /^(text\/|application\/(json|xml|xhtml\+xml)|[a-z-]+\/[a-z0-9.+-]*\+(json|xml))/i;

/** The types the tool keeps: everything else is counted and dropped as it arrives. */
function isTextual(type: string): boolean {
  return TEXTUAL.test(type);
}

function charsetOf(header: string): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(header);
  return match?.[1]?.toLowerCase();
}

/** A byte-order mark is the one declaration a page cannot get wrong. */
function bomCharset(body: Buffer): string | undefined {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return "utf-8";
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  return undefined;
}

/** The charset a document declares about itself, read from the bytes before the first pass. */
function declaredCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, 1_024).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  if (meta?.[1] !== undefined) return meta[1].toLowerCase();
  const xml = /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head);
  return xml?.[1]?.toLowerCase();
}

/**
 * Decodes with the declared charset, or UTF-8 when there is none or the label is unknown. A page
 * that says it is Latin-1 no longer arrives full of replacement characters.
 */
function decodeBody(body: Buffer, charset: string | undefined): string {
  const label = charset ?? bomCharset(body) ?? declaredCharset(body);
  if (label === undefined) return body.toString("utf8");
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return body.toString("utf8");
  }
}

/**
 * The `lookup` given to `net.connect`: every address the host resolves to is checked, and the
 * connection uses that same answer. Validating separately and then connecting with `fetch` would
 * leave a window in which a second resolution returns something else.
 *
 * `net.connect` asks with `all: true` and expects the array back in that shape; handing it a single
 * address instead fails every real hostname with `Invalid IP address`, which is why the loopback
 * tests (literal addresses, where `lookup` is never called) could not see it.
 */
export function guardedLookup(allowLoopback: boolean): LookupFunction {
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
      const blocked = addresses.find(
        (entry) => isPrivateAddress(entry.address) && !(allowLoopback && isLoopback(entry.address)),
      );
      if (blocked !== undefined) {
        callback(new Error(`${hostname} resolves to a private address`), "", 0);
        return;
      }
      if (options.all === true) {
        callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })), 0);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

function requestOnce(
  target: URL,
  signal: AbortSignal,
  options: FetchPageOptions,
  deadline: number,
): Promise<RawResponse> {
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  let settled = false;
  // Declared before `fail` can run: an error during connect would otherwise hit the TDZ.
  let overall: NodeJS.Timeout | undefined;

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
      lookup: guardedLookup(options.allowLoopback === true),
    },
    (response) => {
      // `identity` is a request, and servers ignore it. Decoding is not implemented, so a body that
      // arrived compressed is bytes that would reach the model as mojibake: say so instead.
      const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
      if (encoding !== "" && encoding !== "identity") {
        fail(new Error(`${target.host} sent the page ${encoding}-compressed after identity was asked for`));
        return;
      }
      const keep = isTextual(bareType(response.headers["content-type"] ?? ""));
      // A binary body is never returned, so its bytes are counted and dropped rather than held.
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settledResponse = false;
      // Set before the cap destroys the stream: that close is our decision, not a broken body.
      let stopped = false;
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
            body: keep ? Buffer.concat(chunks) : Buffer.alloc(0),
            // A capped body is shorter than the response: report what the server declared.
            bytes: Math.max(bytes, declaredLength(response.headers["content-length"])),
          });
        }
      };
      response.on("data", (chunk: Buffer) => {
        if (bytes >= MAX_BODY_BYTES) return;
        const room = MAX_BODY_BYTES - bytes;
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        bytes += kept.length;
        if (keep) chunks.push(kept);
        if (bytes >= MAX_BODY_BYTES) {
          stopped = true;
          response.destroy();
          finish();
        }
      });
      response.on("end", finish);
      // A destroy on purpose (the cap, an abort) is settled already. A socket that closed on its
      // own leaves the body short, and returning it would hide the truncation; Node reports that
      // as an `ECONNRESET` first, so both paths say the same thing.
      const short = (): Error => new Error(`The response from ${target.host} closed before its body finished`);
      response.on("close", () => {
        if (!settledResponse && !stopped && !response.complete) fail(short());
        else finish();
      });
      response.on("error", (error: Error) => {
        fail(response.complete ? error : short());
      });
    },
  );

  const idleMs = options.timeouts?.idleMs ?? IDLE_TIMEOUT_MS;
  const remaining = Math.max(0, deadline - Date.now());
  overall = setTimeout(() => {
    fail(new Error(`No response from ${target.host} within the ${REQUEST_TIMEOUT_MS / 1000} s the fetch allows`));
  }, remaining);

  request.setTimeout(idleMs, () => {
    fail(new Error(`The response from ${target.host} stalled for ${idleMs / 1000} s`));
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
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`Not an absolute URL: ${url}`);
  }
  // One deadline for the whole fetch, not one per hop: six hops each given 20 s would hold a turn
  // for two minutes, and the model asked for one page.
  const deadline = Date.now() + (options.timeouts?.totalMs ?? REQUEST_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertFetchable(target, options.allowLoopback === true);
    if (Date.now() >= deadline) throw new Error(`No response from ${target.host} within the fetch deadline`);
    const response = await requestOnce(target, signal, options, deadline);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && typeof location === "string" && location !== "") {
      try {
        target = new URL(location, target);
      } catch {
        throw new Error(`${target.host} redirected to an unusable location: ${location}`);
      }
      continue;
    }
    const declared = response.headers["content-type"] ?? "";
    const type = bareType(declared);
    return {
      status: response.status,
      statusText: response.statusText,
      contentType: type,
      body: isTextual(type) ? decodeBody(response.body, charsetOf(declared)) : "",
      bytes: response.bytes,
      finalUrl: target.toString(),
    };
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects from ${url}`);
}

/**
 * Refuses a URL the tool must not reach, before a socket exists. The `lookup` guard cannot see an
 * IP literal — `net.connect` skips DNS when the host is already an address — so the literal case is
 * decided here, and a redirect is checked by the same function on every hop.
 */
function assertFetchable(target: URL, allowLoopback: boolean): void {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be fetched, not ${target.protocol}`);
  }
  if (target.username !== "" || target.password !== "") {
    // `node:http` would turn these into `Authorization: Basic`, so refusing is the only way to
    // keep the promise that the tool sends no credentials.
    throw new Error(`${target.host} cannot be fetched: the URL carries credentials`);
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (REFUSED_HOSTS[host] === true || REFUSED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`${host} is a local name and cannot be fetched`);
  }
  if ((isIPv4(host) || isIPv6(host)) && isPrivateAddress(host) && !(allowLoopback && isLoopback(host))) {
    throw new Error(`${host} is a private address and cannot be fetched`);
  }
}

/** Turns a response into what the model reads: extracted HTML, pretty JSON, or a refusal. */
export function formatPage(result: FetchPageResult): string {
  const type = result.contentType;
  if (type === "text/html" || type === "application/xhtml+xml") {
    return htmlToText(result.body, { baseUrl: result.finalUrl });
  }
  if (type === "application/json" || type.endsWith("+json")) {
    if (result.body.length > MAX_PRETTY_BYTES) return result.body;
    try {
      const pretty = JSON.stringify(JSON.parse(result.body) as unknown, null, 2);
      return pretty.length > MAX_PRETTY_BYTES ? result.body : pretty;
    } catch {
      return result.body;
    }
  }
  if (TEXTUAL.test(type)) return result.body;
  return `${type === "" ? "unknown type" : type}, ${result.bytes} bytes \u2014 binary content is not returned`;
}
