import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/smoke-package.mjs <path to NoirHarness.exe>");
  process.exit(1);
}
const exe = resolve(target);
if (!existsSync(exe)) {
  console.error(`smoke: executable not found: ${exe}`);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "noir-smoke-"));
const runtimeFile = join(dataDir, "runtime", "kernel.json");
const timeoutMs = 30_000;

let stdout = "";
let stderr = "";
let exited = null;

const child = spawn(exe, [], {
  env: { ...process.env, NOIR_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: false,
});
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.on("exit", (code, signal) => {
  exited = { code, signal };
});
child.on("error", (error) => {
  stderr += `spawn failed: ${error.message}\n`;
  exited = { code: null, signal: null };
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

function fail(message) {
  console.error(`smoke: ${message}`);
  if (stdout.trim()) console.error(`--- stdout ---\n${stdout.trimEnd()}`);
  if (stderr.trim()) console.error(`--- stderr ---\n${stderr.trimEnd()}`);
  if (!exited) killTree(child.pid);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}

const deadline = Date.now() + timeoutMs;
let info = null;
while (Date.now() < deadline) {
  if (existsSync(runtimeFile)) {
    try {
      const parsed = JSON.parse(readFileSync(runtimeFile, "utf8"));
      if (typeof parsed.pid === "number" && typeof parsed.port === "number" && typeof parsed.token === "string") {
        info = parsed;
        break;
      }
    } catch {
      // still being written
    }
  }
  if (exited) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
}

if (!info) {
  fail(
    exited
      ? `app exited before writing ${runtimeFile} (code ${exited.code ?? "null"}, signal ${exited.signal ?? "null"})`
      : `timed out after ${timeoutMs}ms waiting for ${runtimeFile}`,
  );
}

if (!isAlive(info.pid)) fail(`kernel pid ${info.pid} from ${runtimeFile} is not alive`);

console.log(`smoke: kernel pid ${info.pid} listening on port ${info.port}`);
killTree(child.pid);

if (isAlive(info.pid)) {
  killTree(info.pid);
  if (isAlive(info.pid)) fail(`kernel pid ${info.pid} survived shutdown`);
}

rmSync(dataDir, { recursive: true, force: true });
console.log("smoke: ok");
