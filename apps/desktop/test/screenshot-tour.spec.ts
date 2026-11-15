import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { closeWindow, launchApp } from "./app-harness.js";
import { removeDir } from "./helpers.js";

/**
 * Regenerates the README's screenshots from the real app. A throwaway provider answers the way a
 * local model would on its standard port, and every surface is driven through the UI a reader would
 * use. Skipped unless asked for, so the suite stays independent of a machine's display and of port
 * 1234: `NOIR_CAPTURE=1 npx playwright test test/screenshot-tour.spec.ts`.
 */


const ROOT = join(process.cwd(), "..", "..");
const DOCS = join(ROOT, "docs", "images");
/** Fixed paths so the shots show a name a reader would recognise instead of a temp-dir hash. */
const DATA_DIR = join("C:", "Users", "Public", "noir-demo-data");
const WORKSPACE = join("C:", "Users", "Public", "noir-demo");
const PORT = 1234;

const REPLY = [
  "Three files changed on the auth path. The refresh now retries once before it signs the user out.",
  "",
  "| file | change |",
  "| --- | --- |",
  "| `src/auth/session.ts` | retry on 401, keep the old token valid |",
  "| `src/auth/token.ts` | extract `refreshWithRetry` |",
  "| `test/auth.test.ts` | cover the retry path |",
  "",
  "Sessions created this week:",
  "",
  "![sessions per day](chart.png)",
].join("\n");

function chunk(delta: unknown, finishReason: string | null): string {
  const frame = {
    id: "chatcmpl-tour",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "qwen2.5-coder-32b",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const parts: Buffer[] = [];
  req.on("data", (data: Buffer) => parts.push(data));
  req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  return promise;
}

function lastUserText(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || !("messages" in parsed)) return "";
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return "";
  const last = messages
    .filter((message: unknown) => {
      return message !== null && typeof message === "object" && "role" in message && message.role === "user";
    })
    .at(-1);
  if (last === null || last === undefined || typeof last !== "object" || !("content" in last)) return "";
  return typeof last.content === "string" ? last.content : "";
}

async function startTourProvider(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const body = await readBody(req);
      const prompt = lastUserText(body);
      // After the approval is answered the loop calls back with a `tool` message; a second tool call
      // there would re-raise the card the tour just dismissed.
      const answered = body.includes('"role":"tool"');
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive" });
      if (prompt.includes("tests") && !answered) {
        // A tool call the app stops on: this is the approval card, not an executed command.
        const args = JSON.stringify({ command: "pnpm test --filter @noir/desktop" });
        const half = Math.ceil(args.length / 2);
        res.write(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                { index: 0, id: "call-1", type: "function", function: { name: "shell.exec", arguments: args.slice(0, half) } },
              ],
            },
            null,
          ),
        );
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, null));
        res.write(chunk({}, "tool_calls"));
      } else {
        const text = answered ? "Rejected, so nothing ran. Say the word if you want the suite to run." : REPLY;
        res.write(chunk({ role: "assistant", content: text }, null));
        res.write(chunk({}, "stop"));
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1840, completion_tokens: 236 } })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    })();
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(PORT, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The app's own default is 1440x900; the smaller display clamps it, the wide one does not. */
async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const wide = screen.getAllDisplays().reduce((best, display) => {
      return display.workArea.width > best.workArea.width ? display : best;
    });
    win?.setBounds({ x: wide.workArea.x + 40, y: wide.workArea.y + 20, width: 1440, height: 900 });
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(DOCS, `${name}.png`) });
}

test.skip(process.env["NOIR_CAPTURE"] !== "1", "Set NOIR_CAPTURE=1 to regenerate docs/images.");

test("captures the README screenshots", async () => {
  test.setTimeout(600_000);
  mkdirSync(DOCS, { recursive: true });
  for (const dir of [DATA_DIR, WORKSPACE]) {
    if (existsSync(dir)) execFileSync("cmd", ["/c", "rmdir", "/s", "/q", dir]);
    mkdirSync(dir, { recursive: true });
  }
  const harness = { dataDir: DATA_DIR, workspacePath: WORKSPACE };

  // A workspace worth photographing: a small repo, a document, and the chart the reply embeds.
  mkdirSync(join(WORKSPACE, "src"), { recursive: true });
  writeFileSync(join(WORKSPACE, "src", "main.ts"), "export const started = true;\n");
  writeFileSync(join(WORKSPACE, "README.md"), "# demo workspace\n\nA small repository the screenshots were taken against.\n");
  execFileSync("git", ["init", "-q", "--template="], { cwd: WORKSPACE });
  execFileSync("git", ["config", "user.email", "demo@example.com"], { cwd: WORKSPACE });
  execFileSync("git", ["config", "user.name", "demo"], { cwd: WORKSPACE });
  execFileSync("git", ["add", "."], { cwd: WORKSPACE });
  execFileSync("git", ["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "init"], { cwd: WORKSPACE });
  writeFileSync(join(WORKSPACE, "chart.png"), readFileSync(join(process.cwd(), "test", "fixtures", "chart.png")));
  writeFileSync(
    join(WORKSPACE, "notes.md"),
    [
      "# Release notes",
      "",
      "The auth path now retries a token refresh once before it signs the user out.",
      "",
      "| surface | state |",
      "| --- | --- |",
      "| chat | shipped |",
      "| editor | shipped |",
      "| artifacts | shipped |",
      "",
      "> Everything here runs on this machine; the only network call is the provider's.",
    ].join("\n"),
  );

  const provider = await startTourProvider();
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(harness);
    const page = await app.firstWindow();
    await sizeWindow(app);
    await expect(page.getByTestId("kernel-status")).toHaveText("kernel ok", { timeout: 30_000 });

    // 1. Setup: the chain's first two links, as a local-model user would fill them in.
    const providers = page.getByRole("region", { name: "Providers", exact: true });
    await providers.getByLabel("Name", { exact: true }).fill("LMStudio");
    await providers.getByLabel("Base URL", { exact: true }).fill(provider.url);
    await providers.getByLabel("API key", { exact: true }).fill("local");
    await providers.getByRole("button", { exact: true, name: "Add provider" }).click();
    await expect(providers.locator("li").filter({ hasText: "LMStudio" })).toBeVisible();

    const models = page.getByRole("region", { name: "Models", exact: true });
    await models.getByLabel("Provider", { exact: true }).selectOption({ label: "LMStudio" });
    await models.getByLabel("Engine", { exact: true }).selectOption("native");
    await models.getByLabel("Model id", { exact: true }).fill("qwen2.5-coder-32b");
    await models.getByLabel("Display name", { exact: true }).fill("Qwen2.5 Coder 32B");
    await models.getByLabel("Context window", { exact: true }).fill("32768");
    await shot(page, "setup");

    await models.getByRole("button", { exact: true, name: "Add model" }).click();
    await expect(models.locator("li").filter({ hasText: "qwen2.5-coder-32b" })).toBeVisible();

    // 2. Chat: a real turn streamed from the provider into the transcript.
    const main = page.getByRole("navigation", { exact: true, name: "Main" });
    await main.getByRole("button", { name: "Chats", exact: true }).click();
    const projects = page.getByRole("region", { name: "Projects", exact: true });
    await projects.getByLabel("Project path", { exact: true }).fill(WORKSPACE);
    await projects.getByRole("button", { exact: true, name: "Add project" }).click();
    const sessions = page.getByRole("region", { name: "Sessions", exact: true });
    await sessions.getByLabel("New chat model", { exact: true }).selectOption({ label: "Qwen2.5 Coder 32B" });
    await sessions.getByRole("button", { exact: true, name: "New chat" }).click();
    await page.getByLabel("Prompt", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Rename chat", exact: true }).click();
    await page.getByLabel("Chat title", { exact: true }).fill("Auth refresh retry");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Rename chat", exact: true })).toHaveText("Auth refresh retry");

    await page.getByLabel("Prompt", { exact: true }).fill("What changed on the auth path this week?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const reply = page.getByTestId("message-assistant").filter({ hasText: "Three files changed on the auth path" });
    await expect(reply.locator("table")).toBeVisible({ timeout: 30_000 });
    await expect(reply.locator("img")).toBeVisible();
    // The transcript lives in `.shell-main`; scroll it, not the image, which a settling turn re-renders.
    await page.locator(".shell-main").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await shot(page, "chat");

    // 3. Approval: the same loop waiting on a tool the app will not run by itself.
    await page.getByLabel("Prompt", { exact: true }).fill("Run the desktop tests");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const permission = page.getByTestId("permission-card");
    await expect(permission).toBeVisible({ timeout: 30_000 });
    await page.locator(".shell-main").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await shot(page, "approval");
    // Reject the command the card is asking about, so the tour never runs it.
    await permission.getByRole("button", { name: /Reject/ }).first().click();
    await expect(permission).toBeHidden({ timeout: 30_000 });

    // 4. Artifacts: the document preview, rendered by the app rather than downloaded.
    await page.getByRole("group", { exact: true, name: "List pane" }).getByRole("button", { exact: true, name: "File list" }).click();
    await expect(page.getByRole("treeitem").filter({ hasText: "notes.md" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Preview notes.md", exact: true }).click();
    await expect(page.getByRole("region", { name: "Preview notes.md", exact: true })).toBeVisible({ timeout: 20_000 });
    await shot(page, "artifacts");

    // 5. Editor and diff: edit a tracked file, save it, and let the inspector show the change.
    await page.getByRole("treeitem", { name: /src/ }).click();
    await page.getByRole("treeitem", { name: /main\.ts/ }).click();
    const editor = page.locator(".monaco-editor .view-lines");
    await expect(editor).toContainText("export const started = true;", { timeout: 20_000 });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("export const started = true;\nexport const port = 1234;\n");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(editor).toContainText("export const port = 1234;", { timeout: 20_000 });
    await shot(page, "editor");

    // The inspector lists the change against the last commit and renders the diff beside the chat,
    // so the capture walks back to the chat tab the tour opened.
    await page.getByRole("tab").first().click();
    await page.getByRole("banner").getByRole("button", { name: "Inspector", exact: true }).click();
    const changedFiles = page.getByRole("region", { name: "Changed files", exact: true });
    await expect(changedFiles).toContainText("src/main.ts", { timeout: 20_000 });
    await changedFiles.getByRole("button", { name: "Show diff for src/main.ts", exact: true }).click();
    await expect(page.getByRole("region", { name: "Diff", exact: true })).toContainText("+export const port = 1234;");
    await shot(page, "diff");

    // The pane is a chat surface: with no chat tab active it only repeats "open a chat", so it goes
    // away before the shots that are about another view.
    await page.getByRole("banner").getByRole("button", { name: "Inspector", exact: true }).click();
    await expect(page.getByRole("region", { name: "Changed files", exact: true })).toBeHidden();

    // 6. Source control: the same workspace, from the page that commits.
    await main.getByRole("button", { name: "Source", exact: true }).click();
    await expect(page.getByRole("region", { name: "Staged", exact: true })).toBeVisible({ timeout: 20_000 });
    await shot(page, "source");

    // 7. The office: agents painted from the roster.
    await main.getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("region", { name: "Office", exact: true })).toBeVisible({ timeout: 30_000 });
    await shot(page, "office");

    // 8. Automations: a schedule the kernel fires on its own.
    await main.getByRole("button", { name: "Automations", exact: true }).click();
    await page.getByRole("button", { name: "New schedule", exact: true }).click();
    const scheduleEditor = page.getByRole("region", { name: "Schedule editor", exact: true });
    await scheduleEditor.getByLabel("Name", { exact: true }).fill("Nightly review");
    await scheduleEditor.getByLabel("Prompt", { exact: true }).fill("Review yesterday's commits and list the risks.");
    await scheduleEditor.getByLabel("Cadence", { exact: true }).selectOption("15");
    await scheduleEditor.getByRole("button", { name: "Save schedule", exact: true }).click();
    const schedules = page.getByRole("region", { name: "Schedules", exact: true });
    await expect(schedules).toContainText("Nightly review", { timeout: 20_000 });
    // Saving blanks the editor on purpose; reopening the row shows the schedule the shot describes.
    await schedules.getByRole("button", { name: /Nightly review/ }).first().click();
    await expect(scheduleEditor.getByLabel("Name", { exact: true })).toHaveValue("Nightly review");
    await shot(page, "automations");

    // 9. Help: the keyboard map, generated from the command registry.
    await main.getByRole("button", { name: "Help", exact: true }).click();
    await shot(page, "help");
  } finally {
    if (app !== undefined) await closeWindow(app);
    await provider.close();
    await removeDir(DATA_DIR);
    await removeDir(WORKSPACE);
  }
});
