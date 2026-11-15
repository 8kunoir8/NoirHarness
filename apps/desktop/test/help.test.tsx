import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Command } from "../src/renderer/commands.js";
import { Help } from "../src/renderer/Help.js";

function command(patch: Partial<Command> & { id: string; label: string }): Command {
  return { enabled: true, run: () => undefined, ...patch };
}

describe("Help", () => {
  it("lists only commands that have a shortcut, with the platform's label", () => {
    render(
      <Help
        version="0.1.0"
        buildId="abcdef0123456789"
        commands={[
          command({ id: "close-tab", label: "Close tab", shortcut: { key: "w", mod: true } }),
          command({ id: "skills", label: "Open skills" }),
        ]}
      />,
    );

    const keyboard = screen.getByRole("region", { name: "Keyboard" });
    expect(within(keyboard).getByText("Ctrl+W")).toBeTruthy();
    // A command without a key is a palette entry, not a shortcut: the table is a keyboard map.
    expect(within(keyboard).queryByText("Open skills")).toBeNull();
  });

  it("names the build, short enough to paste into a bug report", () => {
    render(<Help version="0.1.0" buildId="abcdef0123456789" commands={[]} />);

    const build = screen.getByRole("region", { name: "Running this build" });
    expect(within(build).getByText("0.1.0")).toBeTruthy();
    expect(within(build).getByText("abcdef012345")).toBeTruthy();
    expect(within(build).getByText(/tag/).textContent).toContain("v<version>");
  });

  it("reports a missing handshake as such instead of an empty cell", () => {
    render(<Help version="0.1.0" buildId={undefined} commands={[]} />);

    expect(screen.getByText("not reported")).toBeTruthy();
  });

  it("opens a link through the shell bridge", async () => {
    const openExternal = vi.fn(async () => undefined);
    window.noir = { openExternal } as unknown as Window["noir"];
    try {
      render(<Help version="0.1.0" buildId="abc" commands={[]} />);
      await userEvent.click(screen.getByRole("button", { name: "Issues" }));
      expect(openExternal).toHaveBeenCalledWith("https://github.com/8kunoir8/NoirHarness/issues");
    } finally {
      delete window.noir;
    }
  });

  it("carries the update row it is given", () => {
    render(<Help version="0.1.0" buildId="abc" commands={[]} update={<p>Update row here</p>} />);

    expect(screen.getByText("Update row here")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Updates" })).toBeTruthy();
  });
});
