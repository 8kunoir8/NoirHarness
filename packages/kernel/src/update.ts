import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import type { UpdateState } from "@noir/protocol";

const run = promisify(execFile);

/**
 * The only channel that works for a private repository: no releases, and git already holds
 * whatever credentials the user has. A packaged app has no checkout, so this cannot hang off a
 * workspace and runs from the data directory instead.
 */
const DEFAULT_UPDATE_URL = "https://github.com/8kunoir8/NoirHarness.git";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A credential helper with nothing cached would otherwise wait forever on a prompt. */
const TIMEOUT_MS = 8_000;

const CHECKED_AT_KEY = "update.checkedAt";
const LATEST_KEY = "update.latest";
const DISMISSED_KEY = "update.dismissed";

/** `v?<major>.<minor>.<patch>[-prerelease]`; missing fields count as 0, a tag that fails is ignored. */
const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

interface ParsedVersion {
  parts: readonly [number, number, number];
  prerelease: string | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) return null;
  const [, major = "0", minor = "0", patch = "0", prerelease] = match;
  return {
    parts: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease ?? null,
  };
}

/** Numeric field by field; a prerelease sits below the release it precedes, and labels compare lexically. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  // An unparseable tag cannot be ordered against a parsed one; `latestTag` drops those instead.
  if (left === null || right === null) return 0;
  for (let index = 0; index < 3; index += 1) {
    const one = left.parts[index] ?? 0;
    const other = right.parts[index] ?? 0;
    if (one !== other) return one < other ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : left.prerelease > right.prerelease ? 1 : 0;
}

/** The greatest tag that parses; tags that do not are ignored rather than treated as newest. */
export function latestTag(tags: readonly string[]): string | null {
  let latest: string | null = null;
  for (const tag of tags) {
    if (parseVersion(tag) === null) continue;
    if (latest === null || compareVersions(tag, latest) > 0) latest = tag;
  }
  return latest;
}

/** `ls-remote` prints `<sha>\t<ref>`; the peeled `^{}` entry names the same tag as its commit. */
function tagNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const ref = line.slice(tab + 1).trim();
    if (!ref.startsWith("refs/tags/")) continue;
    const name = ref.slice("refs/tags/".length).replace(/\^\{\}$/, "");
    if (name !== "") names.push(name);
  }
  return names;
}

/**
 * Cadence and acknowledgement live here, not in a renderer, so two windows cannot disagree about
 * whether the user has seen a release. Every failure answers with `status: "failed"` and a reason
 * for Help; nothing on screen changes because a check could not complete.
 */
export class UpdateService {
  constructor(
    private readonly db: Database.Database,
    private readonly dataDir: string,
  ) {}

  async check(force: boolean): Promise<UpdateState> {
    const url = process.env.NOIR_UPDATE_URL ?? DEFAULT_UPDATE_URL;
    const current = process.env.NOIR_APP_VERSION ?? "0.0.0";
    const cachedAt = this.read(CHECKED_AT_KEY);
    const cachedLatest = this.read(LATEST_KEY);
    const dismissedVersion = this.read(DISMISSED_KEY);
    let latest = typeof cachedLatest === "string" ? cachedLatest : null;
    let checkedAt = typeof cachedAt === "number" ? cachedAt : 0;
    let reason: string | undefined;

    const fresh = typeof cachedAt === "number" && Date.now() - cachedAt < CHECK_INTERVAL_MS;
    if (force || !fresh) {
      checkedAt = Date.now();
      try {
        latest = await this.readRemote(url);
        this.write(LATEST_KEY, latest);
      } catch (error) {
        // The cached answer stands; only the attempt is recorded.
        reason = error instanceof Error ? error.message : "git failed";
      }
      this.write(CHECKED_AT_KEY, checkedAt);
    }

    const status =
      reason !== undefined ? "failed" : latest !== null && compareVersions(latest, current) > 0 ? "available" : "current";
    return {
      current,
      latest,
      status,
      ...(reason === undefined ? {} : { reason }),
      checkedAt,
      dismissed: latest !== null && typeof dismissedVersion === "string" && dismissedVersion === latest,
      url,
    };
  }

  dismiss(version: string): { ok: true } {
    this.write(DISMISSED_KEY, version);
    return { ok: true };
  }

  /** `GIT_TERMINAL_PROMPT=0` turns a blocked credential prompt into a fast failure, not a hang. */
  private async readRemote(url: string): Promise<string | null> {
    const command = process.env.NOIR_GIT_COMMAND ?? "git";
    const { stdout } = await run(command, ["ls-remote", "--tags", url], {
      cwd: this.dataDir,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return latestTag(tagNames(stdout));
  }

  private read(key: string): unknown {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value_json);
    } catch {
      // A malformed setting is treated as absent.
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(key, JSON.stringify(value));
  }
}
