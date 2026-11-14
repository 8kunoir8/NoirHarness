import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { AgentRosterEntry } from "@noir/protocol";
import type * as OfficeSceneModule from "../src/renderer/office/scene.js";
import {
  MAX_BUBBLE_CHARS,
  MAX_OFFICE_AGENTS,
  actionFor,
  approvalBubbleText,
  statusBubbleText,
  assignDeskIndices,
  hashAgentId,
  toOfficeStates,
  type AgentOfficeState,
  type OfficePoint,
} from "../src/renderer/office/mapper.js";
import { findPath } from "../src/renderer/office/pathfinding.js";
import { OFFICE_DESKS } from "../src/renderer/office/desks.js";
import officeMap from "../src/renderer/office/map.json";
import manifest from "../src/renderer/office/assets/manifest.json";

// The component test must never build a real WebGL context: Phaser is replaced by a constructor
// double and the scene module by a factory double, so the assertions stay on call counts.
const phaserDouble = vi.hoisted(() => {
  interface FakeGameConfig {
    parent?: unknown;
    width?: number;
    height?: number;
    pixelArt?: boolean;
    fps?: { target?: number };
    scene?: unknown[];
  }
  interface FakeGameInstance {
    config: FakeGameConfig;
    registry: Map<string, unknown>;
    destroyed: boolean;
    destroyCalls: unknown[][];
    events: {
      on: (event: string, handler: (payload: unknown) => void) => void;
      off: (event: string, handler: (payload: unknown) => void) => void;
      emit: (event: string, payload?: unknown) => void;
    };
    emit: (event: string, payload?: unknown) => void;
    listenerCount: (event: string) => number;
  }

  const games: FakeGameInstance[] = [];

  class FakeGame implements FakeGameInstance {
    config: FakeGameConfig;
    registry = new Map<string, unknown>();
    destroyed = false;
    destroyCalls: unknown[][] = [];
    private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

    events = {
      on: (event: string, handler: (payload: unknown) => void): void => {
        const set = this.handlers.get(event) ?? new Set();
        set.add(handler);
        this.handlers.set(event, set);
      },
      off: (event: string, handler: (payload: unknown) => void): void => {
        this.handlers.get(event)?.delete(handler);
      },
      emit: (event: string, payload?: unknown): void => {
        for (const handler of this.handlers.get(event) ?? []) handler(payload);
      },
    };

    constructor(config: FakeGameConfig) {
      this.config = config;
      games.push(this);
    }

    emit(event: string, payload?: unknown): void {
      this.events.emit(event, payload);
    }

    listenerCount = (event: string): number => this.handlers.get(event)?.size ?? 0;

    destroy = vi.fn((...args: unknown[]): void => {
      this.destroyCalls.push(args);
      this.destroyed = true;
    });
  }

  return { games, FakeGame, Phaser: { AUTO: 0, Game: FakeGame } };
});

const sceneDouble = vi.hoisted(() => ({ createOfficeScene: vi.fn(() => ({ key: "OfficeScene" })) }));

vi.mock("phaser", () => ({ default: phaserDouble.Phaser }));
vi.mock("../src/renderer/office/scene.js", () => ({
  createOfficeScene: sceneDouble.createOfficeScene,
}));

const { AgentOffice } = await import("../src/renderer/office/AgentOffice.js");
const keys = await import("../src/renderer/office/keys.js");

function rosterEntry(overrides: Partial<AgentRosterEntry> & { agentId: string }): AgentRosterEntry {
  return {
    agentId: overrides.agentId,
    name: overrides.name ?? overrides.agentId,
    role: overrides.role ?? "Coder",
    status: overrides.status ?? "idle",
    activeSessionId: overrides.activeSessionId ?? null,
    activeSessionStatus: overrides.activeSessionStatus ?? null,
    activeToolKind: overrides.activeToolKind ?? null,
    sessionCount: overrides.sessionCount ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0,
    usage: overrides.usage ?? null,
    pendingApproval: overrides.pendingApproval ?? null,
  };
}

const DESKS: readonly OfficePoint[] = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 3, y: 1 },
];

function officeState(overrides: Partial<AgentOfficeState> & { agentId: string }): AgentOfficeState {
  return {
    agentId: overrides.agentId,
    name: overrides.name ?? overrides.agentId,
    status: overrides.status ?? "idle",
    action: overrides.action ?? "idle",
    desk: overrides.desk ?? { x: 1, y: 1 },
    deskIndex: overrides.deskIndex ?? 0,
    bubble: overrides.bubble ?? null,
  };
}

describe("office mapper", () => {
  it("maps needs_you to blocked and error to error", () => {
    expect(actionFor(rosterEntry({ agentId: "a", status: "needs_you" }))).toBe("blocked");
    expect(actionFor(rosterEntry({ agentId: "a", status: "error" }))).toBe("error");
  });

  it("maps working read, search and skill to reading", () => {
    for (const kind of ["read", "search", "skill"] as const) {
      expect(actionFor(rosterEntry({ agentId: "a", status: "working", activeToolKind: kind })))
        .toBe("reading");
    }
  });

  it("maps working shell to shell", () => {
    expect(actionFor(rosterEntry({ agentId: "a", status: "working", activeToolKind: "shell" })))
      .toBe("shell");
  });

  it("maps working write, other and no tool to working", () => {
    for (const kind of ["write", "other", null] as const) {
      expect(actionFor(rosterEntry({ agentId: "a", status: "working", activeToolKind: kind })))
        .toBe("working");
    }
  });

  it("maps idle to idle", () => {
    expect(actionFor(rosterEntry({ agentId: "a", status: "idle", activeToolKind: "shell" }))).toBe("idle");
  });

  it("returns a destination desk for every state", () => {
    const states = toOfficeStates(
      [
        rosterEntry({ agentId: "a", status: "working", activeToolKind: "shell" }),
        rosterEntry({ agentId: "b", status: "needs_you" }),
      ],
      DESKS,
    );
    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(DESKS).toContainEqual(state.desk);
      expect(state.name).not.toBe("");
    }
    expect(states[0]?.action).toBe("shell");
    expect(states[1]?.action).toBe("blocked");
  });

  it("caps the office at 32 characters", () => {
    const roster = Array.from({ length: MAX_OFFICE_AGENTS + 4 }, (_, index) =>
      rosterEntry({ agentId: `agent-${index}` }),
    );
    expect(toOfficeStates(roster, OFFICE_DESKS)).toHaveLength(MAX_OFFICE_AGENTS);
  });

  it("puts the approval title in the bubble ahead of the action word", () => {
    const waiting = rosterEntry({
      agentId: "a",
      status: "needs_you",
      pendingApproval: { approvalId: "ap-1", title: "Run ls", category: "shell" },
    });
    expect(toOfficeStates([waiting], DESKS)[0]?.bubble).toBe("Run ls");
    expect(statusBubbleText(waiting)).toBe("Run ls");
    expect(approvalBubbleText(waiting)).toBe("Run ls");
    expect(approvalBubbleText(rosterEntry({ agentId: "b", status: "working" }))).toBeNull();
    expect(approvalBubbleText(rosterEntry({ agentId: "c", status: "error" }))).toBeNull();
  });

  it("says one word for the action when there is nothing to approve", () => {
    const bubble = (
      status: AgentRosterEntry["status"],
      kind: AgentRosterEntry["activeToolKind"] = null,
    ): string | null => statusBubbleText(rosterEntry({ agentId: "a", status, activeToolKind: kind }));
    expect(bubble("working")).toBe("Working");
    expect(bubble("working", "read")).toBe("Reading");
    expect(bubble("working", "search")).toBe("Reading");
    expect(bubble("working", "skill")).toBe("Reading");
    expect(bubble("working", "shell")).toBe("Shell");
    expect(bubble("working", "write")).toBe("Working");
    expect(bubble("needs_you")).toBe("Approval");
    expect(bubble("error")).toBe("Error");
    // Idle says nothing: a room of parked agents must not be a wall of bubbles.
    expect(bubble("idle")).toBeNull();
    expect(toOfficeStates([rosterEntry({ agentId: "quiet", status: "idle" })], DESKS)[0]?.bubble).toBeNull();
  });

  it("falls back to the category and truncates the bubble at 80 characters", () => {
    const unreadable = rosterEntry({
      agentId: "a",
      status: "needs_you",
      pendingApproval: { approvalId: "", title: "  ", category: "delete" },
    });
    expect(approvalBubbleText(unreadable)).toBe("delete");

    const long = rosterEntry({
      agentId: "b",
      status: "needs_you",
      pendingApproval: { approvalId: "ap-2", title: "x".repeat(200), category: "shell" },
    });
    expect(approvalBubbleText(long)).toHaveLength(MAX_BUBBLE_CHARS);
  });
});

describe("desk assignment", () => {
  it("is stable when the id order changes", () => {
    const forward = assignDeskIndices(["alpha", "beta", "gamma"], DESKS.length);
    const reverse = assignDeskIndices(["gamma", "beta", "alpha"], DESKS.length);
    expect([...forward.entries()]).toEqual([...reverse.entries()]);
  });

  it("moves a colliding agent to the next free desk", () => {
    const colliding = ["a", "b", "c", "d", "e", "f"].filter((id) => hashAgentId(id) % 2 === 0);
    const ids = colliding.slice(0, 2);
    expect(ids).toHaveLength(2);
    const assigned = assignDeskIndices(ids, 2);
    const first = assigned.get(ids[0] ?? "");
    const second = assigned.get(ids[1] ?? "");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("keeps every agent when agents outnumber desks", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const assigned = assignDeskIndices(ids, DESKS.length);
    expect(assigned.size).toBe(ids.length);
    for (const index of assigned.values()) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(DESKS.length);
    }
  });

  // `desks.ts` is the eager copy of the map's desk anchors; this keeps it honest.
  it("keeps every desk unique and walkable on the committed map", () => {
    expect(OFFICE_DESKS.length).toBeGreaterThan(0);
    expect(new Set(OFFICE_DESKS.map((desk) => `${desk.x},${desk.y}`)).size).toBe(OFFICE_DESKS.length);
    for (const desk of OFFICE_DESKS) {
      expect(officeMap.floor[desk.y]?.[desk.x]).toBeDefined();
      expect(officeMap.collision[desk.y]?.[desk.x]).toBe(".");
    }
  });
});

describe("pathfinding", () => {
  const grid: boolean[][] = [
    [true, true, true],
    [false, false, true],
    [true, true, true],
  ];

  it("walks around a wall using four neighbours only", () => {
    expect(findPath(grid, { x: 0, y: 0 }, { x: 2, y: 2 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
  });

  it("returns an empty path when the start is the goal", () => {
    expect(findPath(grid, { x: 1, y: 0 }, { x: 1, y: 0 })).toEqual([]);
  });

  it("returns null when no route exists", () => {
    const blocked: boolean[][] = [
      [true, false, true],
      [true, false, true],
      [true, false, true],
    ];
    expect(findPath(blocked, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it("returns null for a blocked or out-of-bounds endpoint", () => {
    expect(findPath(grid, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeNull();
    expect(findPath(grid, { x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull();
  });
});

describe("AgentOffice", () => {
  afterEach(() => {
    cleanup();
    phaserDouble.games.length = 0;
    sceneDouble.createOfficeScene.mockClear();
  });

  const state: AgentOfficeState = officeState({
    agentId: "a-1",
    name: "Scout",
    status: "working",
    action: "working",
    desk: { x: 1, y: 1 },
  });

  it("creates exactly one game per mount and destroys it on unmount", async () => {
    const onSelect = vi.fn();
    const view = render(
      <AgentOffice states={[state]} selectedId={undefined} reducedMotion={false} onSelect={onSelect} />,
    );

    await waitFor(() => expect(phaserDouble.games).toHaveLength(1));
    expect(sceneDouble.createOfficeScene).toHaveBeenCalledTimes(1);
    const game = phaserDouble.games[0];
    expect(game?.config.width).toBe(768);
    expect(game?.config.height).toBe(512);
    expect(game?.config.pixelArt).toBe(true);
    expect(game?.config.fps?.target).toBe(30);
    expect(game?.config.scene).toHaveLength(1);
    expect(game?.registry.get(keys.OFFICE_STATES_KEY)).toEqual([state]);

    view.rerender(
      <AgentOffice states={[state]} selectedId="a-1" reducedMotion onSelect={onSelect} />,
    );
    expect(game?.registry.get(keys.OFFICE_SELECTED_KEY)).toBe("a-1");
    expect(game?.registry.get(keys.OFFICE_REDUCED_KEY)).toBe(true);

    game?.emit(keys.OFFICE_SELECT_EVENT, "a-1");
    expect(onSelect).toHaveBeenCalledWith("a-1");
    expect(game?.listenerCount(keys.OFFICE_SELECT_EVENT)).toBe(1);
    expect(game?.listenerCount(keys.OFFICE_UNAVAILABLE_EVENT)).toBe(1);

    view.unmount();
    expect(game?.destroyCalls).toEqual([[true]]);
    expect(game?.listenerCount(keys.OFFICE_SELECT_EVENT)).toBe(0);
    expect(game?.listenerCount(keys.OFFICE_UNAVAILABLE_EVENT)).toBe(0);
    expect(phaserDouble.games).toHaveLength(1);
  });

  it("publishes the ready, count, desk and selection hooks once the game boots", async () => {
    const first = officeState({ agentId: "b", deskIndex: 3, desk: { x: 1, y: 1 } });
    const second = officeState({ agentId: "a", deskIndex: 1, desk: { x: 2, y: 1 } });
    const view = render(
      <AgentOffice states={[first, second]} selectedId="a" reducedMotion={false} />,
    );

    expect(view.container.querySelector(".office-canvas")?.getAttribute("data-office-ready")).toBeNull();
    await waitFor(() =>
      expect(view.container.querySelector(".office-canvas")?.getAttribute("data-office-ready")).toBe("true"),
    );

    const canvas = view.container.querySelector<HTMLElement>(".office-canvas");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.getAttribute("data-office-count")).toBe("2");
    // Sorted by agent id so the string is comparable across restarts.
    expect(canvas?.getAttribute("data-office-desks")).toBe(JSON.stringify({ a: 1, b: 3 }));
    expect(canvas?.getAttribute("data-office-selected")).toBe("a");
    // The canvas is decorative: nothing inside it is focusable.
    expect(canvas?.querySelector("button, [tabindex], [role]")).toBeNull();
    view.unmount();
  });

  it("keeps the canvas out of the accessibility tree and reports unavailability", async () => {
    const onUnavailable = vi.fn();
    sceneDouble.createOfficeScene.mockImplementationOnce(() => {
      throw new Error("no webgl");
    });
    const view = render(
      <AgentOffice states={[state]} selectedId={undefined} reducedMotion={false} onUnavailable={onUnavailable} />,
    );
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(view.container.querySelector("[data-office-ready]")).toBeNull();
    view.unmount();
  });

  it("reports a scene that fails after construction, not just a failed constructor", async () => {
    const onUnavailable = vi.fn();
    const view = render(
      <AgentOffice states={[state]} selectedId={undefined} reducedMotion={false} onUnavailable={onUnavailable} />,
    );
    await waitFor(() => expect(phaserDouble.games).toHaveLength(1));
    const game = phaserDouble.games[0];
    expect(game?.listenerCount(keys.OFFICE_UNAVAILABLE_EVENT)).toBe(1);

    act(() => {
      game?.emit(keys.OFFICE_UNAVAILABLE_EVENT);
    });
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(view.container.querySelector("[data-office-ready]")).toBeNull(),
    );

    view.unmount();
    expect(game?.listenerCount(keys.OFFICE_UNAVAILABLE_EVENT)).toBe(0);
  });
});

describe("office scene", () => {
  // The component test above replaces `scene.js` with a double; the scene tests need the real
  // module, so it is loaded past the mock once for this block.
  let realScene: typeof OfficeSceneModule;
  beforeAll(async () => {
    realScene = await vi.importActual<typeof OfficeSceneModule>(
      "../src/renderer/office/scene.js",
    );
  });

  interface FakeGameObject {
    x: number;
    y: number;
    depth: number;
    frame: string;
    text: string;
    visible: boolean;
    flipX: boolean;
    /** The selection tint, or `undefined` once it was cleared. */
    tint: number | undefined;
    /** Every frame this object was ever given, in order, so a repaint is observable. */
    paints: string[];
    destroyed: boolean;
    setOrigin: (x?: number, y?: number) => FakeGameObject;
    setDepth: (value: number) => FakeGameObject;
    setPosition: (x: number, y: number) => FakeGameObject;
    setFrame: (value: string) => FakeGameObject;
    setFlipX: (value: boolean) => FakeGameObject;
    setTint: (value: number) => FakeGameObject;
    clearTint: () => FakeGameObject;
    setInteractive: () => FakeGameObject;
    on: (event: string, handler: () => void) => FakeGameObject;
    setText: (value: string) => FakeGameObject;
    setVisible: (value: boolean) => FakeGameObject;
    destroy: () => void;
  }

  /** Phaser's emitter, reduced to the semantics the scene relies on (`once`, `off` by handler). */
  class Emitter {
    readonly log: Array<{ event: string; args: unknown[] }> = [];
    private readonly handlers = new Map<string, Map<(...args: unknown[]) => void, boolean>>();

    on = (event: string, handler: (...args: unknown[]) => void): void => {
      const set = this.handlers.get(event) ?? new Map();
      set.set(handler, false);
      this.handlers.set(event, set);
    };

    once = (event: string, handler: (...args: unknown[]) => void): void => {
      const set = this.handlers.get(event) ?? new Map();
      set.set(handler, true);
      this.handlers.set(event, set);
    };

    off = (event: string, handler: (...args: unknown[]) => void): void => {
      this.handlers.get(event)?.delete(handler);
    };

    emit = (event: string, ...args: unknown[]): void => {
      this.log.push({ event, args });
      const set = this.handlers.get(event);
      if (set === undefined) return;
      for (const [handler, once] of [...set.entries()]) {
        if (once) set.delete(handler);
        handler(...args);
      }
    };

    count = (event: string): number => this.handlers.get(event)?.size ?? 0;
  }

  interface SceneLike {
    create: () => Promise<void>;
    update: (time: number, delta: number) => void;
    events: Emitter;
  }

  interface HarnessOptions {
    /** Reject the committed map/manifest import. */
    failAssets?: boolean;
    /** Make the image loader emit `loaderror` instead of `complete`. */
    failImages?: boolean;
    /** Keep the texture keys but leave their sources empty, the way a blocked load does. */
    failDecode?: boolean;
    /** The agent behind the open chat, as the host pushes it. */
    selected?: string;
  }

  function harness(): {
    game: {
      registry: Map<string, unknown>;
      events: Emitter;
      loop: { sleep: () => void; wake: () => void };
    };
    sprites: FakeGameObject[];
    screens: FakeGameObject[];
    rings: FakeGameObject[];
    texts: FakeGameObject[];
    createScene: (
      reducedMotion: boolean,
      states: AgentOfficeState[],
      options?: HarnessOptions,
    ) => Promise<{ scene: SceneLike }>;
  } {
    const sprites: FakeGameObject[] = [];
    const screens: FakeGameObject[] = [];
    const rings: FakeGameObject[] = [];
    const texts: FakeGameObject[] = [];
    const registry = new Map<string, unknown>();
    const game = {
      registry,
      events: new Emitter(),
      loop: { sleep: vi.fn(), wake: vi.fn() },
    };

    class GameObject implements FakeGameObject {
      x: number;
      y: number;
      depth = 0;
      frame: string;
      text = "";
      flipX = false;
      visible = true;
      paints: string[] = [];
      destroyed = false;
      tint: number | undefined = undefined;
      private handlers = new Map<string, () => void>();

      constructor(x: number, y: number, frame: string) {
        this.x = x;
        this.y = y;
        this.frame = frame;
        this.paints.push(frame);
      }

      setOrigin = (): FakeGameObject => this;
      setDepth = (value: number): FakeGameObject => {
        this.depth = value;
        return this;
      };
      setPosition = (x: number, y: number): FakeGameObject => {
        this.x = x;
        this.y = y;
        return this;
      };
      setFrame = (value: string): FakeGameObject => {
        this.frame = value;
        this.paints.push(value);
        return this;
      };
      setFlipX = (value: boolean): FakeGameObject => {
        this.flipX = value;
        return this;
      };
      setTint = (value: number): FakeGameObject => {
        this.tint = value;
        return this;
      };
      clearTint = (): FakeGameObject => {
        this.tint = undefined;
        return this;
      };
      setInteractive = (): FakeGameObject => this;
      on = (event: string, handler: () => void): FakeGameObject => {
        this.handlers.set(event, handler);
        return this;
      };
      click = (): void => {
        this.handlers.get("pointerdown")?.();
      };
      setText = (value: string): FakeGameObject => {
        this.text = value;
        return this;
      };
      setVisible = (value: boolean): FakeGameObject => {
        this.visible = value;
        return this;
      };
      destroy = (): void => {
        this.destroyed = true;
      };
    }

    let completeHandler: (() => void) | undefined;
    let errorHandler: (() => void) | undefined;
    let failImages = false;
    let failDecode = false;

    class Scene extends (Object as unknown as new () => object) {
      game = game;
      events = new Emitter();
      add = {
        image: (x: number, y: number, file: string, frame: string): FakeGameObject => {
          const object = new GameObject(x, y, frame);
          if (frame.startsWith("char-")) sprites.push(object);
          if (frame.startsWith("pc-")) screens.push(object);
          return object;
        },
        ellipse: (x: number, y: number): FakeGameObject => {
          const object = new GameObject(x, y, "ring");
          rings.push(object);
          return object;
        },
        text: (x: number, y: number, text: string): FakeGameObject => {
          const object = new GameObject(x, y, "text");
          object.setText(text);
          texts.push(object);
          return object;
        },
      };
      load = {
        image: vi.fn(),
        once: (event: string, handler: () => void): void => {
          if (event === "complete") completeHandler = handler;
          if (event === "loaderror") errorHandler = handler;
        },
        start: (): void => {
          if (failImages) errorHandler?.();
          else completeHandler?.();
        },
      };
      textures = { get: () => ({ add: vi.fn(), getSourceImage: () => ({ width: failDecode ? 0 : 1 }) }) };
      cameras = { main: { setZoom: vi.fn(), setBounds: vi.fn(), centerOn: vi.fn() } };
    }

    return {
      game,
      sprites,
      screens,
      rings,
      texts,
      createScene: async (
        reducedMotion: boolean,
        states: AgentOfficeState[],
        options: HarnessOptions = {},
      ) => {
        failImages = options.failImages === true;
        failDecode = options.failDecode === true;
        const factory = realScene.createOfficeScene(
          { AUTO: 0, Scene, Game: class {} } as never,
          {
            loadAssets: async () => {
              if (options.failAssets === true) throw new Error("office assets unavailable");
              return { map: officeMap as never, manifest: manifest as never };
            },
          },
        );
        const scene = new (factory as unknown as new () => SceneLike)();
        registry.set(keys.OFFICE_STATES_KEY, states);
        registry.set(keys.OFFICE_REDUCED_KEY, reducedMotion);
        registry.set(keys.OFFICE_SELECTED_KEY, options.selected);
        await scene.create();
        return { scene };
      },
    };
  }

  it("holds a still frame at the station under reduced motion", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(true, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "reading",
        desk: { x: 2, y: 5 },
      }),
    ]);

    const character = hashAgentId("a-1") % manifest.characters.count;
    const shelf = (officeMap.zones.shelf as OfficePoint[])[
      hashAgentId("a-1") % officeMap.zones.shelf.length
    ];
    const sprite = harnessed.sprites[0];
    expect(sprite?.x).toBe((shelf?.x ?? 0) * 16 + 8);
    // The art is two tiles tall, so the feet sit on the tile's bottom edge, not its centre.
    expect(sprite?.y).toBe((shelf?.y ?? 0) * 16 + 16);
    expect(sprite?.frame).toBe(`char-${character}-up-5`);

    // Reduced motion never advances a frame, however much game time passes.
    const painted = sprite?.paints.length ?? 0;
    scene.update(0, 5_000);
    expect(sprite?.paints).toHaveLength(painted);
  });

  it("maps each action onto its own clip frame", async () => {
    const harnessed = harness();
    await harnessed.createScene(true, [
      officeState({ agentId: "a-work", status: "working", action: "working", desk: { x: 2, y: 5 } }),
      officeState({
        agentId: "a-read",
        status: "working",
        action: "reading",
        desk: { x: 5, y: 5 },
        deskIndex: 1,
      }),
      officeState({
        agentId: "a-block",
        status: "needs_you",
        action: "blocked",
        desk: { x: 8, y: 5 },
        deskIndex: 2,
      }),
      officeState({
        agentId: "a-idle",
        status: "idle",
        action: "idle",
        desk: { x: 11, y: 5 },
        deskIndex: 3,
      }),
    ]);

    const columnFor = (index: number, agentId: string): string | undefined => {
      const character = hashAgentId(agentId) % manifest.characters.count;
      return harnessed.sprites[index]?.frame.slice(`char-${character}-up-`.length);
    };
    // `type` opens at column 3, `read` at 5, `seated` at 7; an idle agent stands on frame 0.
    expect(columnFor(0, "a-work")).toBe("3");
    expect(columnFor(1, "a-read")).toBe("5");
    expect(columnFor(2, "a-block")).toBe("7");
    expect(columnFor(3, "a-idle")).toBe("0");
  });

  it("advances the working clip on the game clock", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({ agentId: "a-1", status: "working", action: "working", desk: { x: 2, y: 5 } }),
    ]);
    const character = hashAgentId("a-1") % manifest.characters.count;
    const sprite = harnessed.sprites[0];
    expect(sprite?.frame).toBe(`char-${character}-up-3`);

    scene.update(0, 300);
    expect(sprite?.frame).toBe(`char-${character}-up-4`);
    scene.update(300, 300);
    expect(sprite?.frame).toBe(`char-${character}-up-3`);
  });

  it("lights the agent's monitor only while it works", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({ agentId: "a-1", status: "working", action: "working", desk: { x: 2, y: 5 } }),
      officeState({
        agentId: "a-2",
        status: "working",
        action: "reading",
        desk: { x: 5, y: 5 },
        deskIndex: 1,
      }),
    ]);

    const [working, reading] = harnessed.screens;
    // The desk's art covers the two rows above the seat, so the monitor stands on the desk's own row
    // and sorts half a pixel in front of the desk but behind the agent, whose depth is its feet.
    expect(working?.x).toBe(2 * 16 + 8);
    expect(working?.y).toBe(3 * 16);
    expect(working?.depth).toBe(3 * 16 + 32 + 0.5);
    expect(working?.frame).toBe("pc-on-1");
    expect(reading?.frame).toBe("pc-off");

    scene.update(0, 300);
    expect(working?.frame).toBe("pc-on-2");
    scene.update(300, 300);
    expect(working?.frame).toBe("pc-on-3");
    scene.update(600, 300);
    expect(working?.frame).toBe("pc-on-1");
    expect(reading?.frame).toBe("pc-off");
  });

  it("does not restart the action animation for an unchanged snapshot", async () => {
    const harnessed = harness();
    const state: AgentOfficeState = officeState({
      agentId: "a-1",
      name: "Scout",
      status: "working",
      action: "working",
      desk: { x: 2, y: 5 },
    });
    const { scene } = await harnessed.createScene(false, [state]);
    const sprite = harnessed.sprites[0];
    scene.update(0, 300);
    const painted = sprite?.paints.length ?? 0;

    harnessed.game.events.emit(keys.OFFICE_STATES_EVENT, [state]);
    expect(sprite?.paints).toHaveLength(painted);
  });

  it("walks towards the destination one tile per 120 ms", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "reading",
        desk: { x: 2, y: 5 },
      }),
    ]);
    const sprite = harnessed.sprites[0];
    expect(sprite?.x).toBe(2 * 16 + 8);
    expect(sprite?.y).toBe(6 * 16);
    scene.update(0, 120);
    expect(sprite?.x === 2 * 16 + 8 && sprite?.y === 6 * 16).toBe(false);
  });

  it("picks the atlas row from the step and mirrors leftwards", () => {
    const { directionBetween } = realScene;
    expect(directionBetween({ x: 4, y: 4 }, { x: 5, y: 4 })).toEqual({
      direction: "right",
      flipX: false,
    });
    expect(directionBetween({ x: 4, y: 4 }, { x: 3, y: 4 })).toEqual({
      direction: "right",
      flipX: true,
    });
    expect(directionBetween({ x: 4, y: 4 }, { x: 4, y: 3 })).toEqual({
      direction: "up",
      flipX: false,
    });
    expect(directionBetween({ x: 4, y: 4 }, { x: 4, y: 5 })).toEqual({
      direction: "down",
      flipX: false,
    });
  });

  it("draws the approval title as a bubble and keeps the error marker", async () => {
    const harnessed = harness();
    await harnessed.createScene(false, [
      officeState({ agentId: "a-1", status: "needs_you", action: "blocked", bubble: "Run rm -rf build" }),
      officeState({ agentId: "a-2", status: "error", action: "error", desk: { x: 3, y: 5 }, deskIndex: 1 }),
    ]);

    const visible = harnessed.texts.filter((text) => text.visible).map((text) => text.text);
    expect(visible).toContain("Run rm -rf build");
    expect(visible).toContain("×");
  });

  it("tears down on scene destroy, not only on shutdown", async () => {
    const added = vi.spyOn(document, "addEventListener");
    const removed = vi.spyOn(document, "removeEventListener");
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "working",
        desk: { x: 2, y: 5 },
      }),
    ]);

    expect(scene.events.count("shutdown")).toBe(1);
    expect(scene.events.count("destroy")).toBe(1);
    expect(harnessed.game.events.count(keys.OFFICE_STATES_EVENT)).toBe(1);
    expect(added).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    scene.events.emit("destroy");
    expect(removed).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(harnessed.game.events.count(keys.OFFICE_STATES_EVENT)).toBe(0);
    // Idempotent: a shutdown after the destroy must not throw or remove anything twice.
    expect(() => scene.events.emit("shutdown")).not.toThrow();
    added.mockRestore();
    removed.mockRestore();
  });

  it("raises the unavailable event when an awaited load fails", async () => {
    const failedAssets = harness();
    await failedAssets.createScene(false, [], { failAssets: true });
    expect(
      failedAssets.game.events.log.filter((entry) => entry.event === keys.OFFICE_UNAVAILABLE_EVENT),
    ).toHaveLength(1);

    const failedImages = harness();
    await failedImages.createScene(false, [], { failImages: true });
    expect(
      failedImages.game.events.log.filter((entry) => entry.event === keys.OFFICE_UNAVAILABLE_EVENT),
    ).toHaveLength(1);

    // A load the browser refuses keeps its texture key but never decodes: the scene has to fail
    // rather than paint the missing-texture tile over the whole room.
    const emptyTextures = harness();
    await emptyTextures.createScene(false, [], { failDecode: true });
    expect(
      emptyTextures.game.events.log.filter((entry) => entry.event === keys.OFFICE_UNAVAILABLE_EVENT),
    ).toHaveLength(1);
  });

  it("idles a new agent for the full window instead of wandering on frame one", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "idle",
        action: "idle",
        desk: { x: 2, y: 5 },
      }),
    ]);
    const sprite = harnessed.sprites[0];
    // The game clock is already far past the wander window when this snapshot spawns the agent.
    scene.update(60_000, 16);
    expect(sprite?.x).toBe(2 * 16 + 8);
    expect(sprite?.y).toBe(6 * 16);

    scene.update(68_001, 16);
    scene.update(68_017, 200);
    expect(sprite?.x === 2 * 16 + 8 && sprite?.y === 6 * 16).toBe(false);
  });

  it("keeps four idle agents on four different tiles while they roam", async () => {
    const harnessed = harness();
    const desks: OfficePoint[] = [
      { x: 2, y: 5 },
      { x: 5, y: 5 },
      { x: 8, y: 5 },
      { x: 11, y: 5 },
    ];
    const { scene } = await harnessed.createScene(
      false,
      desks.map((desk, index) => officeState({ agentId: `a-${index}`, desk })),
    );
    // A minute of idling: six wander windows, each followed by a walk to the next free tile.
    let time = 60_000;
    for (let tick = 0; tick < 60; tick += 1) {
      time += 1_000;
      scene.update(time, 1_000);
      const occupied = harnessed.sprites.map((sprite) => `${sprite.x},${sprite.y}`);
      expect(new Set(occupied).size).toBe(occupied.length);
    }
    expect(harnessed.sprites.some((sprite) => sprite.x !== 2 * 16 + 8 || sprite.y !== 6 * 16)).toBe(true);
  });

  it("stands a cup on the middle of its tabletop instead of its own tile corner", () => {
    const cups = officeMap.furniture.filter((item) => item.frame === "coffee");
    // Each cup's art is centred on its table's 32-pixel art and its base three pixels inside the
    // tabletop, which starts eleven pixels down a 32-tall table frame.
    expect(cups.map((cup) => realScene.restOn(officeMap.furniture, manifest.frames, cup, 16))).toEqual([
      { x: 276, y: 119, bottom: 144 },
      { x: 324, y: 183, bottom: 208 },
    ]);
  });

  it("rings and names only the agent behind the open chat", async () => {
    const harnessed = harness();
    const states = [
      officeState({ agentId: "a-1", name: "Scout", status: "working", action: "working", desk: { x: 2, y: 5 } }),
      officeState({
        agentId: "a-2",
        name: "Beta",
        status: "working",
        action: "working",
        desk: { x: 5, y: 5 },
        deskIndex: 1,
      }),
    ];
    const { scene } = await harnessed.createScene(false, states, { selected: "a-1" });

    const [scout, beta] = harnessed.sprites;
    expect(scout?.tint).toBe(0x9ad0ff);
    expect(beta?.tint).toBeUndefined();
    // One ring and one nameplate per character; the ring sits under the feet, the plate below them.
    expect(harnessed.rings).toHaveLength(2);
    expect(harnessed.rings.map((ring) => ring.visible)).toEqual([true, false]);
    expect(scout?.x).toBe(harnessed.rings[0]?.x);
    expect(harnessed.rings[0]?.y).toBe((5 + 1) * 16 - 2.5);
    const plates = harnessed.texts.filter((text) => text.text === "Scout" || text.text === "Beta");
    expect(plates.map((plate) => [plate.text, plate.visible])).toEqual([
      ["Scout", true],
      ["Beta", false],
    ]);

    // Moving the chat to the other agent swaps the highlight without a re-spawn.
    harnessed.game.registry.set(keys.OFFICE_SELECTED_KEY, "a-2");
    harnessed.game.events.emit(keys.OFFICE_STATES_EVENT, states);
    expect(scout?.tint).toBeUndefined();
    expect(beta?.tint).toBe(0x9ad0ff);
    expect(harnessed.rings.map((ring) => ring.visible)).toEqual([false, true]);
    expect(plates.map((plate) => plate.visible)).toEqual([false, true]);
  });

  it("destroys a removed agent's objects and stops painting it", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "working",
        desk: { x: 2, y: 5 },
      }),
    ]);
    const sprite = harnessed.sprites[0];
    const painted = sprite?.paints.length ?? 0;

    harnessed.game.events.emit(keys.OFFICE_STATES_EVENT, []);
    expect(sprite?.destroyed).toBe(true);
    expect(harnessed.texts.every((text) => text.destroyed)).toBe(true);

    scene.update(0, 5_000);
    expect(sprite?.paints).toHaveLength(painted);
  });
});
