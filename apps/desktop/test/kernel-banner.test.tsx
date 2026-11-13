import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KernelBanner } from "../src/renderer/KernelBanner.js";

describe("KernelBanner", () => {
  it("says nothing when the desktop owns its daemon", () => {
    const { container } = render(<KernelBanner daemon buildMatches />);
    expect(container.firstChild).toBeNull();
  });

  it("warns that an update waits for the old build to finish", () => {
    render(<KernelBanner daemon buildMatches={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/older build/i);
  });

  it("warns that the kernel will stop with the window", () => {
    render(<KernelBanner daemon={false} buildMatches />);
    expect(screen.getByRole("status").textContent).toMatch(/closing it stops/i);
  });
});
