export const REDACTED = "[REDACTED]";
const MIN_SECRET_LENGTH = 8;
const MAX_SECRETS = 512;
const MAX_DEPTH = 32;

const BUILTIN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const ENV_SECRET_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)$/i;

export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    if (ENV_SECRET_NAME.test(name)) values.push(value);
  }
  return values;
}

export function parseRedactionPatterns(raw: string | undefined): RegExp[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("NOIR_REDACT_PATTERNS must be a JSON array of regex sources");
  }
  if (!Array.isArray(parsed)) throw new Error("NOIR_REDACT_PATTERNS must be a JSON array of regex sources");
  return parsed.map((entry: unknown) => {
    if (typeof entry !== "string") throw new Error(`Invalid NOIR_REDACT_PATTERNS entry: ${String(entry)}`);
    try {
      return new RegExp(entry, "g");
    } catch {
      throw new Error(`Invalid NOIR_REDACT_PATTERNS entry: ${entry}`);
    }
  });
}

export interface RedactorOptions {
  secrets?: Iterable<string>;
  patterns?: Iterable<RegExp>;
  env?: NodeJS.ProcessEnv;
}

/** Caller-supplied patterns are normalized to global so every occurrence is replaced. */
function withGlobalFlag(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.global ? pattern.flags : `${pattern.flags}g`);
}

export class Redactor {
  private secrets: string[] = [];
  private readonly patterns: RegExp[];

  constructor(opts: RedactorOptions = {}) {
    const initial = [...(opts.secrets ?? []), ...environmentSecrets(opts.env ?? {})];
    for (const secret of initial) this.addSecret(secret);
    this.patterns = [...BUILTIN_PATTERNS, ...(opts.patterns ?? [])].map(withGlobalFlag);
  }

  addSecret(value: string | null | undefined): void {
    if (value === null || value === undefined) return;
    const secret = value.trim();
    if (secret.length < MIN_SECRET_LENGTH || this.secrets.length >= MAX_SECRETS || this.secrets.includes(secret)) return;
    this.secrets.push(secret);
    this.secrets.sort((a, b) => b.length - a.length);
  }

  redactText(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    for (const pattern of this.patterns) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, REDACTED);
    }
    return out;
  }

  redact(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return this.redactText(value);
    // Past the cap the node's shape is unknown, so drop it rather than persist it unredacted.
    if (depth > MAX_DEPTH) return REDACTED;
    if (Array.isArray(value)) return value.map((item) => this.redact(item, depth + 1));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(out, key, { value: this.redact(item, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return value;
  }
}
