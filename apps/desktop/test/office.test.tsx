import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { AgentRosterEntry } from "@noir/protocol";
import type * as OfficeSceneModule from "../src/renderer/office/scene.js";
import {
  MAX_BUBBLE_CHARS,
  MAX_OFFICE_AGENTS,
  actionFor,
  approvalBubbleText,
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

  it("carries the approval title into the needs_you bubble and nothing else", () => {
    const waiting = rosterEntry({
      agentId: "a",
      status: "needs_you",
      pendingApproval: { approvalId: "ap-1", title: "Run ls", category: "shell" },
    });
    expect(toOfficeStates([waiting], DESKS)[0]?.bubble).toBe("Run ls");
    expect(approvalBubbleText(waiting)).toBe("Run ls");
    expect(approvalBubbleText(rosterEntry({ agentId: "b", status: "working" }))).toBeNull();
    expect(approvalBubbleText(rosterEntry({ agentId: "c", status: "error" }))).toBeNull();
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
    frame: string;
    text: string;
    visible: boolean;
    setOrigin: (x?: number, y?: number) => FakeGameObject;
    setDepth: (value: number) => FakeGameObject;
    setPosition: (x: number, y: number) => FakeGameObject;
    setScale: (x: number, y?: number) => FakeGameObject;
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
  }

  function harness(): {
    game: {
      registry: Map<string, unknown>;
      events: Emitter;
      loop: { sleep: () => void; wake: () => void };
    };
    tweens: unknown[];
    tweenStops: Array<{ stop: () => void }>;
    sprites: FakeGameObject[];
    texts: FakeGameObject[];
    createScene: (
      reducedMotion: boolean,
      states: AgentOfficeState[],
      options?: HarnessOptions,
    ) => Promise<{ scene: SceneLike }>;
  } {
    const tweens: unknown[] = [];
    const tweenStops: Array<{ stop: () => void }> = [];
    const sprites: FakeGameObject[] = [];
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
      frame: string;
      text = "";
      scale = 1;
      flipX = false;
      visible = true;
      tint: number | undefined = undefined;
      private handlers = new Map<string, () => void>();

      constructor(x: number, y: number, frame: string) {
        this.x = x;
        this.y = y;
        this.frame = frame;
      }

      setOrigin = (): FakeGameObject => this;
      setDepth = (): FakeGameObject => this;
      setPosition = (x: number, y: number): FakeGameObject => {
        this.x = x;
        this.y = y;
        return this;
      };
      setScale = (x: number, y?: number): FakeGameObject => {
        this.scale = y ?? x;
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
      destroy = (): void => undefined;
    }

    let completeHandler: (() => void) | undefined;
    let errorHandler: (() => void) | undefined;
    let failImages = false;

    class Scene extends (Object as unknown as new () => object) {
      game = game;
      events = new Emitter();
      add = {
        image: (x: number, y: number, file: string, frame: string): FakeGameObject => {
          const object = new GameObject(x, y, frame);
          if (frame.startsWith("char-")) sprites.push(object);
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
      textures = { get: () => ({ add: vi.fn() }) };
      tweens = {
        add: (config: unknown): { stop: () => void } => {
          tweens.push(config);
          const tween = { stop: vi.fn() };
          tweenStops.push(tween);
          return tween;
        },
        killTweensOf: vi.fn(),
      };
      cameras = { main: { setZoom: vi.fn(), setBounds: vi.fn(), centerOn: vi.fn() } };
    }

    return {
      game,
      tweens,
      tweenStops,
      sprites,
      texts,
      createScene: async (
        reducedMotion: boolean,
        states: AgentOfficeState[],
        options: HarnessOptions = {},
      ) => {
        failImages = options.failImages === true;
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
        await scene.create();
        return { scene };
      },
    };
  }

  it("skips tweens but still seats the agent at its destination under reduced motion", async () => {
    const harnessed = harness();
    const state: AgentOfficeState = officeState({
      agentId: "a-1",
      name: "Scout",
      status: "working",
      action: "reading",
      desk: { x: 2, y: 4 },
    });
    await harnessed.createScene(true, [state]);

    expect(harnessed.tweens).toHaveLength(0);
    const sprite = harnessed.sprites[0];
    const shelf = (officeMap.zones.shelf as OfficePoint[])[hashAgentId("a-1") % officeMap.zones.shelf.length];
    expect(sprite?.x).toBe((shelf?.x ?? 0) * 16 + 8);
    expect(sprite?.y).toBe((shelf?.y ?? 0) * 16 + 8);
  });

  it("plays the action animation when motion is allowed", async () => {
    const harnessed = harness();
    await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "working",
        desk: { x: 2, y: 4 },
      }),
    ]);
    expect(harnessed.tweens.length).toBeGreaterThan(0);
  });

  it("does not restart the action animation for an unchanged snapshot", async () => {
    const harnessed = harness();
    const state: AgentOfficeState = officeState({
      agentId: "a-1",
      name: "Scout",
      status: "working",
      action: "working",
      desk: { x: 2, y: 4 },
    });
    await harnessed.createScene(false, [state]);
    const started = harnessed.tweens.length;
    harnessed.game.events.emit(keys.OFFICE_STATES_EVENT, [state]);
    expect(harnessed.tweens).toHaveLength(started);
  });

  it("walks towards the destination one tile per 120 ms", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "reading",
        desk: { x: 2, y: 4 },
      }),
    ]);
    const sprite = harnessed.sprites[0];
    expect(sprite?.x).toBe(2 * 16 + 8);
    expect(sprite?.y).toBe(4 * 16 + 8);
    scene.update(0, 120);
    expect(sprite?.x === 2 * 16 + 8 && sprite?.y === 4 * 16 + 8).toBe(false);
  });

  it("draws the approval title as a bubble and keeps the error marker", async () => {
    const harnessed = harness();
    await harnessed.createScene(false, [
      officeState({ agentId: "a-1", status: "needs_you", action: "blocked", bubble: "Run rm -rf build" }),
      officeState({ agentId: "a-2", status: "error", action: "error", desk: { x: 3, y: 4 }, deskIndex: 1 }),
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
        desk: { x: 2, y: 4 },
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
  });

  it("idles a new agent for the full window instead of wandering on frame one", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "idle",
        action: "idle",
        desk: { x: 2, y: 4 },
      }),
    ]);
    const sprite = harnessed.sprites[0];
    // The game clock is already far past the wander window when this snapshot spawns the agent.
    scene.update(60_000, 16);
    expect(sprite?.x).toBe(2 * 16 + 8);
    expect(sprite?.y).toBe(4 * 16 + 8);

    scene.update(68_001, 16);
    scene.update(68_017, 200);
    expect(sprite?.x === 2 * 16 + 8 && sprite?.y === 4 * 16 + 8).toBe(false);
  });

  it("stops a removed agent's action tween before destroying its sprite", async () => {
    const harnessed = harness();
    await harnessed.createScene(false, [
      officeState({
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "working",
        desk: { x: 2, y: 4 },
      }),
    ]);
    expect(harnessed.tweenStops).toHaveLength(1);

    harnessed.game.events.emit(keys.OFFICE_STATES_EVENT, []);
    expect(harnessed.tweenStops[0]?.stop).toHaveBeenCalledTimes(1);
  });
});
