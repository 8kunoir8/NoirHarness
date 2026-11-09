import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Settings, type RequestFn } from "../src/renderer/Settings.js";

describe("Settings", () => {
  it("lists providers and creates one", async () => {
    const request: RequestFn = vi.fn(async (method: string) => {
      if (method === "provider.list") return { providers: [{ id: "1", name: "Local", baseUrl: "http://x/v1", apiKind: "openai-completions", enabled: true, hasKey: true, createdAt: 1 }] };
      if (method === "provider.create") return { id: "2" };
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Settings request={request} />);
    expect(await screen.findByText("Local")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Name"), "Work");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await userEvent.type(screen.getByLabelText("API key"), "sk-test");
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect(request).toHaveBeenCalledWith("provider.create", {
      name: "Work", baseUrl: "https://api.example.com/v1", apiKind: "openai-completions", apiKey: "sk-test", enabled: true,
    });
  });

  it("keeps the submit disabled until required fields are filled", async () => {
    const request: RequestFn = vi.fn(async () => ({ providers: [] })) as unknown as RequestFn;
    render(<Settings request={request} />);
    const button = screen.getByRole("button", { name: "Add provider" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Name"), "n");
    expect(button.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    expect(button.disabled).toBe(true);
  });

  it("keeps the form values when provider.create fails", async () => {
    const request: RequestFn = vi.fn(async (method: string) => {
      if (method === "provider.list") return { providers: [{ id: "1", name: "Local", baseUrl: "http://x/v1", apiKind: "openai-completions", enabled: true, hasKey: true, createdAt: 1 }] };
      if (method === "provider.create") throw new Error("baseUrl must be a valid URL");
      throw new Error(method);
    }) as unknown as RequestFn;

    render(<Settings request={request} />);
    expect(await screen.findByText("Local")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Name"), "Work");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://api.example.com/v1");
    await userEvent.type(screen.getByLabelText("API key"), "sk-test");
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect((await screen.findByRole("alert")).textContent).toContain("baseUrl must be a valid URL");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Work");
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("https://api.example.com/v1");
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("sk-test");
    expect(screen.getByText("Local")).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
