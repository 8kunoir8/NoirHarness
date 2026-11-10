import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(appDir));
const staging = join(root, "build");

// Leftovers from earlier runs (and the deploy output itself) must not leak into the package.
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const deployTarget = join(staging, "kernel");
const deploy = spawnSync(
  pnpm,
  [
    "--filter", "@noir/app-kernel", "deploy", "--prod", "--legacy",
    // A hoisted layout has no symlinks, so electron-builder can copy the kernel
    // into resources without leaking absolute links back into this checkout.
    "--config.node-linker=hoisted",
    // win32 needs `shell: true` to run pnpm.cmd, and shell mode concatenates argv
    // without escaping, so the absolute target has to be quoted here.
    process.platform === "win32" ? `"${deployTarget}"` : deployTarget,
  ],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);
if (deploy.status !== 0) process.exit(deploy.status ?? 1);

if (!existsSync(join(staging, "kernel", "dist", "index.cjs"))) {
  throw new Error("deployed kernel is missing dist/index.cjs");
}
if (!existsSync(join(staging, "kernel", "node_modules", "better-sqlite3"))) {
  throw new Error("deployed kernel is missing better-sqlite3");
}
if (!existsSync(join(staging, "kernel", "node_modules", "@napi-rs", "keyring"))) {
  throw new Error("deployed kernel is missing @napi-rs/keyring");
}

// The kernel's native modules are built for the Node ABI, so ship the Node that ran this script.
mkdirSync(join(staging, "runtime"), { recursive: true });
cpSync(process.execPath, join(staging, "runtime", process.platform === "win32" ? "node.exe" : "node"));

console.log(`staged kernel and runtime in ${staging}`);
