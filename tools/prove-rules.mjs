/**
 * Proves each local rule still fails on the code it exists to stop.
 *
 * A rule that silently stops matching is worse than no rule: the check gets cited as proof. Each
 * fixture is the smallest file that must be rejected (with the exact count of findings), plus the
 * nearest correct file that must pass — so a rule that flags everything fails the same way.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import noir from "../tools/eslint-plugin-noir/index.js";

const RENDERER_ROOT = "src/renderer";

/** file → [source, expected findings under the rule] */
const CASES = [
  {
    rule: "noir/no-cross-process-import",
    files: {
      "src/renderer/electron.ts": ['import { app } from "electron";\n', 1],
      "src/renderer/node-builtin.ts": ['import { readFile } from "node:fs/promises";\n', 1],
      "src/renderer/kernel.ts": ['import { Kernel } from "@noir/kernel";\n', 1],
      "src/renderer/escape.ts": ['import { helper } from "../main/helper.js";\n', 1],
      "src/renderer/dynamic.ts": ['export const load = (): Promise<unknown> => import("electron");\n', 1],
      "src/renderer/allowed.ts": [
        'import { SessionView } from "@noir/protocol";\nimport { request } from "./api.js";\n',
        0,
      ],
    },
  },
  {
    rule: "noir/no-bare-timer",
    files: {
      "src/renderer/leak.ts": [
        "export function later(run: () => void): void {\n  setTimeout(run, 10);\n  window.setInterval(run, 10);\n}\n",
        2,
      ],
      // The one file allowed to own raw ids: it is the module that hands back cancellers.
      "src/renderer/defer.ts": [
        "export function after(ms: number, run: () => void): () => void {\n  const id = window.setTimeout(run, ms);\n  return () => window.clearTimeout(id);\n}\n",
        0,
      ],
    },
  },
  {
    rule: "noir/strict-locator-name",
    files: {
      "test/loose.spec.ts": ['page.getByRole("button", { name: "Send" });\npage.getByLabel("Prompt");\n', 2],
      "test/partial.spec.ts": ['page.getByRole("button", { name: "Send", level: 1 });\n', 1],
      "test/exact.spec.ts": [
        'page.getByRole("button", { name: "Send", exact: true });\npage.getByLabel("Prompt", { exact: true });\n',
        0,
      ],
      // A regex is already anchored by whoever wrote it; `exact` does not apply.
      "test/regex.spec.ts": ['page.getByRole("button", { name: /^send$/i });\n', 0],
    },
  },
];

let failures = 0;

function compare(label, actual, expected) {
  if (actual === expected) {
    console.log(`ok   ${label}: ${expected} finding(s)`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${label}: expected ${expected} finding(s), got ${actual}`);
}

const dir = await mkdtemp(path.join(tmpdir(), "noir-rules-"));
try {
  for (const { rule, files } of CASES) {
    const eslint = new ESLint({
      cwd: dir,
      ignore: false,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.ts"],
          languageOptions: { parser: tseslint.parser },
          plugins: { noir },
          rules: {
            "noir/no-cross-process-import": ["error", { rendererRoot: RENDERER_ROOT }],
            "noir/no-bare-timer": ["error", { allow: [`${RENDERER_ROOT}/defer.ts`] }],
            "noir/strict-locator-name": "error",
          },
        },
      ],
    });

    for (const [file, [source]] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), source);
    }

    const results = await eslint.lintFiles(Object.keys(files));
    for (const result of results) {
      const file = path.relative(dir, result.filePath).split(path.sep).join("/");
      const hit = result.messages.filter((message) => message.ruleId === rule).length;
      compare(`${rule} on ${file}`, hit, files[file][1]);
      const fatal = result.messages.filter((message) => message.ruleId === null).length;
      compare(`${rule} parsed ${file}`, fatal, 0);
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} rule proof(s) failed`);
  process.exitCode = 1;
} else {
  console.log("\nevery local rule fails on the code it exists to stop");
}
