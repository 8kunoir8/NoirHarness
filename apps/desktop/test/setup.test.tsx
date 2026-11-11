import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { RequestFn } from "../src/renderer/api.js";
import { Setup } from "../src/renderer/Setup.js";

type RequestMock = RequestFn & Mock<(method: string, params?: unknown) => unknown>;

function makeRequest(overrides: Record<string, (params?: unknown) => unknown> = {}): RequestMock {
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    const override = overrides[method];
    if (override !== undefined) return override(params);
    if (method === "provider.list") return { providers: [] };
    if (method === "model.list") return { models: [] };
    if (method === "system.health") return { status: "ok", pid: 1, engineDir: "C:/data/engine" };
    throw new Error(`unexpected ${method}`);
  });
  return request as unknown as RequestMock;
}
describe("Setup", () => {
  it("creates a provider from the form and refreshes the list", async () => {
    const request = makeRequest({
      "provider.create": (params) => {
        expect(params).toMatchObject({
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKind: "openai-completions",
          apiKey: "sk-secret",
        });
        return { id: "p1" };
      },
      "provider.list": () => ({
        providers: [
          {
            id: "p1",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com/v1",
            apiKind: "openai-completions",
            enabled: true,
            hasKey: true,
            createdAt: 1,
          },
        ],
      }),
    });

    render(<Setup request={request} onOpenChat={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Name"), "DeepSeek");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://api.deepseek.com/v1");
    await userEvent.type(screen.getByLabelText("API key"), "sk-secret");
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("provider.create", expect.anything()));
    expect(await screen.findByText("key stored")).toBeTruthy();
    // The key is never echoed back into the form or the list.
    expect(screen.queryByDisplayValue("sk-secret")).toBeNull();
    // The hint names the real owner directory reported by the kernel, not a hardcoded omp path.
    expect(await screen.findByText(/C:\/data\/engine\/models\.yml/)).toBeTruthy();
  });

  it("creates a model for the selected provider with a numeric context window", async () => {
    const request = makeRequest({
      "provider.list": () => ({
        providers: [
          {
            id: "p1",
            name: "DeepSeek",
            baseUrl: "https://api.deepseek.com/v1",
            apiKind: "openai-completions",
            enabled: true,
            hasKey: true,
            createdAt: 1,
          },
        ],
      }),
      "model.create": (params) => {
        expect(params).toMatchObject({ providerId: "p1", modelId: "deepseek-chat", contextWindow: 64000 });
        return { id: "m1" };
      },
      "model.list": () => ({
        models: [
          {
            id: "m1",
            providerId: "p1",
            modelId: "deepseek-chat",
            displayName: "deepseek-chat",
            contextWindow: 64000,
            maxTokens: null,
            enabled: true,
            createdAt: 1,
            engine: "acp",
          },
        ],
      }),
    });

    render(<Setup request={request} onOpenChat={() => undefined} />);
    await screen.findByRole("option", { name: "DeepSeek" });
    await userEvent.selectOptions(screen.getByLabelText("Provider"), "p1");
    await userEvent.type(screen.getByLabelText("Model id"), "deepseek-chat");
    await userEvent.clear(screen.getByLabelText("Context window"));
    await userEvent.type(screen.getByLabelText("Context window"), "64000");
    await userEvent.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() => expect(request).toHaveBeenCalledWith("model.create", expect.anything()));
    expect(await screen.findByText("DeepSeek/deepseek-chat")).toBeTruthy();
  });

  it("disables provider submission until a key is entered", async () => {
    const request = makeRequest();
    render(<Setup request={request} onOpenChat={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Name"), "Local");
    await userEvent.type(screen.getByLabelText("Base URL"), "http://127.0.0.1:11434/v1");
    const button = screen.getByRole("button", { name: "Add provider" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("API key"), "k");
    expect(button.disabled).toBe(false);
  });

  it("keeps the typed key when provider.create fails and shows the error", async () => {
    const request = makeRequest({
      "provider.create": () => {
        throw new Error("baseUrl must be a valid URL");
      },
    });
    render(<Setup request={request} onOpenChat={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Name"), "Bad");
    await userEvent.type(screen.getByLabelText("Base URL"), "not-a-url");
    await userEvent.type(screen.getByLabelText("API key"), "sk-keep");
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "baseUrl must be a valid URL");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("sk-keep");
  });

  it("enables Open chat only after a model exists", async () => {
    const empty = makeRequest();
    const { unmount } = render(<Setup request={empty} onOpenChat={() => undefined} />);
    const open = (await screen.findByRole("button", { name: "Open chat" })) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    unmount();

    const withModel = makeRequest({
      "model.list": () => ({
        models: [
          {
            id: "m1",
            providerId: "p1",
            modelId: "m",
            displayName: "m",
            contextWindow: 1000,
            maxTokens: null,
            enabled: true,
            createdAt: 1,
            engine: "acp",
          },
        ],
      }),
    });
    const opened = vi.fn();
    render(<Setup request={withModel} onOpenChat={opened} />);
    const openWithModel = (await screen.findByRole("button", { name: "Open chat" })) as HTMLButtonElement;
    await waitFor(() => expect(openWithModel.disabled).toBe(false));
    await userEvent.click(openWithModel);
    expect(opened).toHaveBeenCalledOnce();
  });
});
