import type Phaser from "phaser";
import tilesUrl from "./assets/tiles.png?url";
import charactersUrl from "./assets/characters.png?url";
import { hashAgentId, type AgentOfficeState, type OfficeAction, type OfficePoint } from "./mapper.js";
import { findPath } from "./pathfinding.js";
import {
  OFFICE_HEIGHT,
  OFFICE_REDUCED_KEY,
  OFFICE_SELECT_EVENT,
  OFFICE_SELECTED_KEY,
  OFFICE_STATES_EVENT,
  OFFICE_STATES_KEY,
  OFFICE_UNAVAILABLE_EVENT,
  OFFICE_WIDTH,
} from "./keys.js";

/** One tile per 120 ms (spec §9.3). */
export const STEP_MS = 120;
/** Idle agents wander to the lounge after this long and return when the next action arrives. */
export const IDLE_WANDER_MS = 8_000;

const SELECTED_TINT = 0x9ad0ff;
/** Pixels above the character's feet, where the status glyph and the speech bubble sit. */
const MARKER_OFFSET = 10;
const BUBBLE_OFFSET = 20;

/** The committed art, hashed into the renderer bundle by Vite — never fetched from a URL. */
const ASSET_URLS: Record<string, string> = {
  "tiles.png": tilesUrl,
  "characters.png": charactersUrl,
};

interface FurniturePlacement {
  frame: string;
  x: number;
  y: number;
}

export interface OfficeMap {
  width: number;
  height: number;
  tile: number;
  wallFrame: string;
  windowFrame: string;
  windows: number[];
  floorLegend: Record<string, string>;
  floor: string[];
  collision: string[];
  furniture: FurniturePlacement[];
  zones: { shelf: OfficePoint[]; rack: OfficePoint[]; lounge: OfficePoint[] };
}

export interface AssetFrame {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AssetManifest {
  tile: number;
  files: string[];
  frames: Record<string, AssetFrame>;
}

export interface OfficeAssets {
  map: OfficeMap;
  manifest: AssetManifest;
}

export interface OfficeSceneOptions {
  /** Test seam: the committed map and manifest, so scene behaviour is provable without a canvas. */
  loadAssets?: () => Promise<OfficeAssets>;
}

/** The slice of the Phaser module the scene needs; keeps the module import out of the type graph. */
export interface PhaserModule {
  AUTO: number;
  Game: typeof Phaser.Game;
  Scene: typeof Phaser.Scene;
}

/**
 * The map and manifest stay out of the startup bundle: they are read when the lazy office chunk is
 * actually evaluated. The committed asset URLs are imported by Vite, so nothing is fetched at runtime.
 */
export async function loadOfficeAssets(): Promise<OfficeAssets> {
  const [map, manifest] = await Promise.all([import("./map.json"), import("./assets/manifest.json")]);
  return { map: map.default, manifest: manifest.default };
}

interface Mover {
  state: AgentOfficeState;
  sprite: Phaser.GameObjects.Image;
  marker: Phaser.GameObjects.Text;
  /** The `needs_you` speech bubble; hidden for every other state. */
  bubble: Phaser.GameObjects.Text;
  tile: OfficePoint;
  path: OfficePoint[];
  carry: number;
  step: number;
  arrivedAt: number;
  atLounge: boolean;
  actionTween: Phaser.Tweens.Tween | undefined;
}

/**
 * Builds the scene class from the freshly imported Phaser namespace, so this module never imports
 * Phaser at runtime and the initial renderer bundle is unaffected.
 */
export function createOfficeScene(
  Phaser: PhaserModule,
  options: OfficeSceneOptions = {},
): new () => Phaser.Scene {
  const loadAssets = options.loadAssets ?? loadOfficeAssets;

  class OfficeScene extends Phaser.Scene {
    private assets: OfficeAssets | undefined;
    private grid: boolean[][] = [];
    private characterFrames: string[] = [];
    private readonly movers = new Map<string, Mover>();
    private selectedId: string | undefined;
    private reducedMotion = false;
    /** Set by {@link teardown}: every awaited step checks it before touching a destroyed system. */
    private disposed = false;

    constructor() {
      super({ key: "OfficeScene" });
    }

    async create(): Promise<void> {
      // Registered before the first `await`: `game.destroy(true)` emits only `destroy`, never
      // `shutdown`, and it can land while the assets are still loading.
      this.events.once("shutdown", this.teardown);
      this.events.once("destroy", this.teardown);
      try {
        const assets = await loadAssets();
        if (this.disposed) return;
        this.assets = assets;
        this.grid = assets.map.collision.map((row) => [...row].map((cell) => cell !== "#"));
        await this.queueImages(assets.manifest);
        if (this.disposed) return;
        this.characterFrames = Object.keys(assets.manifest.frames)
          .filter((name) => name.startsWith("char-"))
          .sort((left, right) => Number(left.slice(5)) - Number(right.slice(5)));
        this.drawMap(assets);

        const { tile, width, height } = assets.map;
        const zoom = Math.max(
          1,
          Math.floor(Math.min(OFFICE_WIDTH / (width * tile), OFFICE_HEIGHT / (height * tile))),
        );
        this.cameras.main.setZoom(zoom);
        this.cameras.main.setBounds(0, 0, width * tile, height * tile);

        this.game.events.on(OFFICE_STATES_EVENT, this.handleStates);
        document.addEventListener("visibilitychange", this.onVisibility);
        this.handleStates(this.game.registry.get(OFFICE_STATES_KEY));
      } catch {
        // The loader rejects inside an `await`, so the host's synchronous `try` around
        // `new Phaser.Game(...)` can never see it: without this event the pane stays blank forever.
        const wasDisposed = this.disposed;
        this.teardown();
        if (!wasDisposed) this.game.events.emit(OFFICE_UNAVAILABLE_EVENT);
      }
    }

    update(time: number, delta: number): void {
      if (this.assets === undefined || this.reducedMotion) return;
      const { tile } = this.assets.map;
      for (const mover of this.movers.values()) {
        if (mover.path.length === 0) {
          this.maybeWander(mover, time);
          continue;
        }
        mover.carry += delta;
        while (mover.carry >= STEP_MS && mover.path.length > 0) {
          mover.carry -= STEP_MS;
          const next = mover.path.shift();
          if (next === undefined) break;
          mover.tile = next;
          mover.step += 1;
          const px = next.x * tile + tile / 2;
          const py = next.y * tile + tile / 2;
          mover.sprite.setPosition(px, py);
          mover.sprite.setFlipX(mover.step % 2 === 1);
          mover.marker.setPosition(px, py - MARKER_OFFSET);
          mover.bubble.setPosition(px, py - BUBBLE_OFFSET);
        }
        if (mover.path.length === 0) {
          mover.arrivedAt = time;
          mover.sprite.setFlipX(false);
          this.startAction(mover);
        }
      }
    }

    private drawMap(assets: OfficeAssets): void {
      const { map } = assets;
      const { tile } = map;
      for (let y = 0; y < map.height; y += 1) {
        const row = map.floor[y] ?? "";
        for (let x = 0; x < map.width; x += 1) {
          const frame = map.floorLegend[row[x] ?? "."] ?? "floor";
          this.addFrame(assets, frame, x * tile, y * tile, 0);
        }
      }
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          const border = x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1;
          if (!border) continue;
          const frame = y === 0 && map.windows.includes(x) ? map.windowFrame : map.wallFrame;
          this.addFrame(assets, frame, x * tile, y * tile, 1);
        }
      }
      for (const item of map.furniture) {
        this.addFrame(assets, item.frame, item.x * tile, item.y * tile, 2);
      }
    }

    private addFrame(assets: OfficeAssets, frame: string, x: number, y: number, depth: number): void {
      const file = assets.manifest.frames[frame]?.file;
      if (file === undefined) return;
      this.add.image(x, y, file, frame).setOrigin(0).setDepth(depth);
    }

    private async queueImages(manifest: AssetManifest): Promise<void> {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      // A destroy mid-load never emits `complete`, so the await would otherwise hold the scene forever.
      const settleOnDestroy = (): void => resolve();
      for (const file of manifest.files) {
        const url = ASSET_URLS[file];
        if (url !== undefined) this.load.image(file, url);
      }
      this.load.once("complete", () => resolve());
      this.load.once("loaderror", () => reject(new Error("office assets failed to load")));
      this.events.once("destroy", settleOnDestroy);
      this.load.start();
      await promise;
      this.events.off("destroy", settleOnDestroy);
      if (this.disposed) return;
      for (const [name, frame] of Object.entries(manifest.frames)) {
        this.textures.get(frame.file).add(name, 0, frame.x, frame.y, frame.w, frame.h);
      }
    }

    /** Registered on `game.events`, so the host pushes snapshots without touching the scene. */
    private readonly handleStates = (payload?: unknown): void => {
      if (this.disposed) return;
      const registry = this.game.registry;
      this.reducedMotion = registry.get(OFFICE_REDUCED_KEY) === true;
      const selected = registry.get(OFFICE_SELECTED_KEY);
      this.selectedId = typeof selected === "string" ? selected : undefined;

      const states = Array.isArray(payload) ? (payload as AgentOfficeState[]) : [];
      const seen = new Set<string>();
      for (const state of states) {
        if (this.assets === undefined) break;
        seen.add(state.agentId);
        const existing = this.movers.get(state.agentId);
        if (existing === undefined) this.spawn(state);
        else this.applyState(existing, state);
      }
      for (const [agentId, mover] of [...this.movers]) {
        if (seen.has(agentId)) continue;
        // The seated tween targets the sprite and repeats forever; stop it before the sprite dies.
        this.stopAction(mover);
        mover.sprite.destroy();
        mover.marker.destroy();
        mover.bubble.destroy();
        this.movers.delete(agentId);
      }
      for (const mover of this.movers.values()) this.applySelection(mover);
    };

    private spawn(state: AgentOfficeState): void {
      const assets = this.assets;
      if (assets === undefined) return;
      const { tile } = assets.map;
      const frame = this.characterFrames[hashAgentId(state.agentId) % this.characterFrames.length];
      const file = frame === undefined ? undefined : assets.manifest.frames[frame]?.file;
      if (frame === undefined || file === undefined) return;

      const px = state.desk.x * tile + tile / 2;
      const py = state.desk.y * tile + tile / 2;
      const sprite = this.add.image(px, py, file, frame).setDepth(3);
      const marker = this.add
        .text(px, py - MARKER_OFFSET, this.markerFor(state.action), {
          fontFamily: "monospace",
          fontSize: "8px",
          color: "#f6c95c",
        })
        .setOrigin(0.5, 1)
        .setDepth(4);
      // Spec §9.4: the approval title rides above the character; the roster row carries the same
      // text, so nothing here is the only copy.
      const bubble = this.add
        .text(px, py - BUBBLE_OFFSET, state.bubble ?? "", {
          fontFamily: "monospace",
          fontSize: "8px",
          color: "#16161c",
          backgroundColor: "#f6f0dc",
          padding: { x: 3, y: 1 },
          wordWrap: { width: 96 },
        })
        .setOrigin(0.5, 1)
        .setDepth(5)
        .setVisible(state.bubble !== null);

      sprite.setInteractive();
      sprite.on("pointerdown", () => {
        this.game.events.emit(OFFICE_SELECT_EVENT, state.agentId);
      });

      const mover: Mover = {
        state,
        sprite,
        marker,
        bubble,
        tile: { x: state.desk.x, y: state.desk.y },
        path: [],
        carry: 0,
        step: 0,
        arrivedAt: 0,
        atLounge: false,
        actionTween: undefined,
      };
      this.movers.set(state.agentId, mover);
      this.applyState(mover, state, true);
    }

    private applyState(mover: Mover, state: AgentOfficeState, fresh = false): void {
      const previous = mover.state;
      const changed =
        fresh ||
        previous.action !== state.action ||
        previous.desk.x !== state.desk.x ||
        previous.desk.y !== state.desk.y;
      mover.state = state;
      mover.marker.setText(this.markerFor(state.action));
      mover.bubble.setText(state.bubble ?? "");
      mover.bubble.setVisible(state.bubble !== null);

      if (this.reducedMotion) {
        if (!changed && mover.path.length === 0) return;
        mover.path = [];
        this.stopAction(mover);
        this.snap(mover, this.destinationFor(state));
        return;
      }
      if (!changed) {
        // Roster snapshots arrive every 250 ms; an unchanged agent must not restart its animation.
        if (mover.path.length === 0 && mover.actionTween === undefined) this.startAction(mover);
        return;
      }

      this.stopAction(mover);
      const destination = this.destinationFor(state);
      const path = findPath(this.grid, mover.tile, destination);
      if (path === null) {
        // No route to the station: the agent keeps its desk rather than floating through walls.
        mover.path = [];
        this.snap(mover, state.desk);
        this.startAction(mover);
        return;
      }
      mover.path = path;
      mover.carry = 0;
      mover.atLounge = false;
      if (path.length === 0) this.startAction(mover);
    }

    private destinationFor(state: AgentOfficeState): OfficePoint {
      const zones = this.assets?.map.zones;
      if (zones === undefined) return state.desk;
      const pick = (points: OfficePoint[]): OfficePoint | undefined =>
        points[hashAgentId(state.agentId) % points.length];
      if (state.action === "reading") return pick(zones.shelf) ?? state.desk;
      if (state.action === "shell") return pick(zones.rack) ?? state.desk;
      return state.desk;
    }

    private maybeWander(mover: Mover, time: number): void {
      const zones = this.assets?.map.zones;
      if (zones === undefined || mover.state.action !== "idle" || zones.lounge.length === 0) return;
      // `time` is the game clock, not zero-based per spawn: adopt it on the first idle frame so a new
      // agent idles for the full window instead of wandering the moment it appears.
      if (mover.arrivedAt === 0) mover.arrivedAt = time;
      if (time - mover.arrivedAt < IDLE_WANDER_MS) return;
      const target = mover.atLounge
        ? mover.state.desk
        : zones.lounge[hashAgentId(mover.state.agentId) % zones.lounge.length];
      if (target === undefined) return;
      const path = findPath(this.grid, mover.tile, target);
      if (path === null || path.length === 0) {
        mover.arrivedAt = time;
        return;
      }
      mover.path = path;
      mover.carry = 0;
      mover.atLounge = !mover.atLounge;
    }

    private snap(mover: Mover, tile: OfficePoint): void {
      const size = this.assets?.map.tile ?? 16;
      mover.tile = { x: tile.x, y: tile.y };
      const px = tile.x * size + size / 2;
      const py = tile.y * size + size / 2;
      mover.sprite.setPosition(px, py);
      mover.sprite.setFlipX(false);
      mover.marker.setPosition(px, py - MARKER_OFFSET);
      mover.bubble.setPosition(px, py - BUBBLE_OFFSET);
    }

    /** The seated action animation. Reduced motion reaches here only through the early return. */
    private startAction(mover: Mover): void {
      this.stopAction(mover);
      if (this.reducedMotion || mover.state.action === "idle") return;
      mover.actionTween = this.tweens.add({
        targets: mover.sprite,
        scaleY: { from: 1, to: 0.94 },
        duration: 520,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }

    private stopAction(mover: Mover): void {
      mover.actionTween?.stop();
      mover.actionTween = undefined;
      this.tweens.killTweensOf(mover.sprite);
      mover.sprite.setScale(1);
    }

    private applySelection(mover: Mover): void {
      if (mover.state.agentId === this.selectedId) mover.sprite.setTint(SELECTED_TINT);
      else mover.sprite.clearTint();
    }

    private markerFor(action: OfficeAction): string {
      switch (action) {
        case "blocked":
          return "!";
        case "error":
          return "×";
        case "idle":
          return "";
        default:
          return "•";
      }
    }

    private readonly onVisibility = (): void => {
      // A stale document listener must never touch a destroyed TimeStep (`game.loop.wake()` throws
      // once `raf` is null).
      if (this.disposed) return;
      if (document.visibilityState === "hidden") this.game.loop.sleep();
      else this.game.loop.wake();
    };

    /** Runs on both `shutdown` and `destroy`; safe to call twice because the flags are one-way. */
    private readonly teardown = (): void => {
      if (this.disposed) return;
      this.disposed = true;
      document.removeEventListener("visibilitychange", this.onVisibility);
      this.game.events.off(OFFICE_STATES_EVENT, this.handleStates);
    };
  }

  return OfficeScene;
}
