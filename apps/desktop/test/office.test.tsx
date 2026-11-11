import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { AgentRosterEntry } from "@noir/protocol";
import type * as OfficeSceneModule from "../src/renderer/office/scene.js";
import {
  MAX_OFFICE_AGENTS,
  actionFor,
  assignDesks,
  hashAgentId,
  toOfficeStates,
  type AgentOfficeState,
  type OfficePoint,
} from "../src/renderer/office/mapper.js";
import { findPath } from "../src/renderer/office/pathfinding.js";
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
  };
}

const DESKS: readonly OfficePoint[] = [
  { x: 1, y: 1 },
  { x: 2, y: 1 },
  { x: 3, y: 1 },
];

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
    expect(toOfficeStates(roster, officeMap.desks)).toHaveLength(MAX_OFFICE_AGENTS);
  });
});

describe("desk assignment", () => {
  it("is stable when the id order changes", () => {
    const forward = assignDesks(["alpha", "beta", "gamma"], DESKS);
    const reverse = assignDesks(["gamma", "beta", "alpha"], DESKS);
    expect([...forward.entries()]).toEqual([...reverse.entries()]);
  });

  it("moves a colliding agent to the next free desk", () => {
    const colliding = ["a", "b", "c", "d", "e", "f"].filter((id) => hashAgentId(id) % 2 === 0);
    const ids = colliding.slice(0, 2);
    expect(ids).toHaveLength(2);
    const assigned = assignDesks(ids, DESKS.slice(0, 2));
    const first = assigned.get(ids[0] ?? "");
    const second = assigned.get(ids[1] ?? "");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toEqual(first);
  });

  it("keeps every desk even when agents outnumber desks", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const assigned = assignDesks(ids, DESKS);
    expect(assigned.size).toBe(ids.length);
    for (const desk of assigned.values()) expect(DESKS).toContainEqual(desk);
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

  const state: AgentOfficeState = {
    agentId: "a-1",
    name: "Scout",
    status: "working",
    action: "working",
    desk: { x: 1, y: 1 },
  };

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

    view.unmount();
    expect(game?.destroyCalls).toEqual([[true]]);
    expect(phaserDouble.games).toHaveLength(1);
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
    view.unmount();
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
    destroy: () => void;
  }

  interface SceneLike {
    create: () => Promise<void>;
    update: (time: number, delta: number) => void;
  }

  function harness(): {
    game: {
      registry: Map<string, unknown>;
      events: {
        on: (event: string, handler: (payload?: unknown) => void) => void;
        off: (event: string, handler: (payload?: unknown) => void) => void;
        emit: (event: string, payload?: unknown) => void;
      };
      loop: { sleep: () => void; wake: () => void };
    };
    tweens: unknown[];
    sprites: FakeGameObject[];
    createScene: (reducedMotion: boolean, states: AgentOfficeState[]) => Promise<{ scene: SceneLike }>;
  } {
    const tweens: unknown[] = [];
    const sprites: FakeGameObject[] = [];
    const registry = new Map<string, unknown>();
    const handlers = new Map<string, Set<(payload?: unknown) => void>>();
    const game = {
      registry,
      events: {
        on: (event: string, handler: (payload?: unknown) => void): void => {
          const set = handlers.get(event) ?? new Set();
          set.add(handler);
          handlers.set(event, set);
        },
        off: (event: string, handler: (payload?: unknown) => void): void => {
          handlers.get(event)?.delete(handler);
        },
        emit: (event: string, payload?: unknown): void => {
          for (const handler of handlers.get(event) ?? []) handler(payload);
        },
      },
      loop: { sleep: vi.fn(), wake: vi.fn() },
    };

    class GameObject implements FakeGameObject {
      x: number;
      y: number;
      frame: string;
      text = "";
      scale = 1;
      flipX = false;
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
      destroy = (): void => undefined;
    }

    let completeHandler: (() => void) | undefined;

    class Scene extends (Object as unknown as new () => object) {
      game = game;
      events = {
        once: (): void => undefined,
        on: (): void => undefined,
      };
      add = {
        image: (x: number, y: number, file: string, frame: string): FakeGameObject => {
          const object = new GameObject(x, y, frame);
          if (frame.startsWith("char-")) sprites.push(object);
          return object;
        },
        text: (x: number, y: number, text: string): FakeGameObject => {
          const object = new GameObject(x, y, "text");
          object.setText(text);
          return object;
        },
      };
      load = {
        image: vi.fn(),
        once: (event: string, handler: () => void): void => {
          if (event === "complete") completeHandler = handler;
        },
        start: (): void => {
          completeHandler?.();
        },
      };
      textures = { get: () => ({ add: vi.fn() }) };
      tweens = {
        add: (config: unknown): { stop: () => void } => {
          tweens.push(config);
          return { stop: vi.fn() };
        },
        killTweensOf: vi.fn(),
      };
      cameras = { main: { setZoom: vi.fn(), setBounds: vi.fn(), centerOn: vi.fn() } };
    }

    return {
      game,
      tweens,
      sprites,
      createScene: async (reducedMotion: boolean, states: AgentOfficeState[]) => {
        const factory = realScene.createOfficeScene(
          { AUTO: 0, Scene, Game: class {} } as never,
          { loadAssets: async () => ({ map: officeMap as never, manifest: manifest as never }) },
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
    const state: AgentOfficeState = {
      agentId: "a-1",
      name: "Scout",
      status: "working",
      action: "reading",
      desk: { x: 2, y: 4 },
    };
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
      {
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "working",
        desk: { x: 2, y: 4 },
      },
    ]);
    expect(harnessed.tweens.length).toBeGreaterThan(0);
  });

  it("does not restart the action animation for an unchanged snapshot", async () => {
    const harnessed = harness();
    const state: AgentOfficeState = {
      agentId: "a-1",
      name: "Scout",
      status: "working",
      action: "working",
      desk: { x: 2, y: 4 },
    };
    await harnessed.createScene(false, [state]);
    const started = harnessed.tweens.length;
    harnessed.game.events.emit(keys.OFFICE_STATES_EVENT, [state]);
    expect(harnessed.tweens).toHaveLength(started);
  });

  it("walks towards the destination one tile per 120 ms", async () => {
    const harnessed = harness();
    const { scene } = await harnessed.createScene(false, [
      {
        agentId: "a-1",
        name: "Scout",
        status: "working",
        action: "reading",
        desk: { x: 2, y: 4 },
      },
    ]);
    const sprite = harnessed.sprites[0];
    expect(sprite?.x).toBe(2 * 16 + 8);
    expect(sprite?.y).toBe(4 * 16 + 8);
    scene.update(0, 120);
    expect(sprite?.x === 2 * 16 + 8 && sprite?.y === 4 * 16 + 8).toBe(false);
  });
});
