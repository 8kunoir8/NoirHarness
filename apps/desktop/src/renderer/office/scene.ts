import type Phaser from "phaser";
import tilesUrl from "./assets/tiles.png?url";
import roomUrl from "./assets/room.png?url";
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

/** The agent behind the open chat: tint, foot ring and nameplate all use this one accent. */
const SELECTED_TINT = 0x9ad0ff;
const SELECTED_ACCENT = "#9ad0ff";
/** Text stays on a fixed layer: y-sorting glyphs would let a far agent's bubble cover a near one. */
const MARKER_DEPTH = 1_000;
const BUBBLE_DEPTH = 1_001;
/** Pixels above the top of the character's art, where the status glyph and the bubble sit. */
const MARKER_GAP = 2;
const BUBBLE_GAP = 12;
/** The selected character's ring: a flat ellipse at the feet, so it never covers the sprite. */
const RING_WIDTH = 14;
const RING_HEIGHT = 5;

/** The three drawn facings. `left` has no row of its own, so it reuses `right` mirrored. */
export type Direction = "down" | "up" | "right";
/** A looping clip from the manifest, plus the still pose an idle agent holds. */
export type CharacterClip = "walk" | "type" | "read" | "seated";
export type Pose = CharacterClip | "stand";

/** Milliseconds per frame. Walk frames are driven by tile steps instead, so they never drift. */
const POSE_MS: Record<Pose, number> = {
  walk: STEP_MS,
  type: 300,
  read: 300,
  seated: 300,
  stand: 300,
};

/** The committed art, hashed into the renderer bundle by Vite — never fetched from a URL. */
const ASSET_URLS: Record<string, string> = {
  "tiles.png": tilesUrl,
  "room.png": roomUrl,
  "characters.png": charactersUrl,
};

interface FurniturePlacement {
  frame: string;
  x: number;
  y: number;
  /**
   * Rests on top of whatever furniture it overlaps (a monitor on a desk, a coffee machine on a
   * table) instead of on the floor, so it sorts half a pixel in front of that piece.
   */
  surface?: boolean;
}

export interface OfficeMap {
  width: number;
  height: number;
  tile: number;
  /** Rows of wall at the top of the map; wall art hangs across them. */
  wallRows: number;
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

/** The cast atlas: `count` characters, `columns` frames each, one row per drawn direction. */
export interface CharacterSheet {
  file: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  count: number;
  directions: Direction[];
  clips: Record<CharacterClip, number[]>;
}

export interface AssetManifest {
  tile: number;
  files: string[];
  frames: Record<string, AssetFrame>;
  characters: CharacterSheet;
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
  // A JSON import widens `directions` and every clip list to `string[]`/`number[]`; the manifest is
  // the contract, so it is asserted once here rather than at every read.
  return { map: map.default, manifest: manifest.default as unknown as AssetManifest };
}

interface Mover {
  state: AgentOfficeState;
  sprite: Phaser.GameObjects.Image;
  marker: Phaser.GameObjects.Text;
  /** What the character says: the approval it waits on, or the word for its action. */
  bubble: Phaser.GameObjects.Text;
  /** Drawn only while this agent is the one behind the open chat. */
  ring: Phaser.GameObjects.Ellipse;
  nameplate: Phaser.GameObjects.Text;
  tile: OfficePoint;
  path: OfficePoint[];
  carry: number;
  step: number;
  arrivedAt: number;
  atLounge: boolean;
  /** Index into the cast atlas: fixed per agent, so a re-spawn keeps the same character. */
  character: number;
  direction: Direction;
  flipX: boolean;
  /** `undefined` until the first pose is chosen, which is what makes the first paint happen. */
  pose: Pose | undefined;
  poseElapsed: number;
  poseFrame: number;
  /** The agent's monitor on its desk: lit while it works, dark otherwise. */
  screen: Phaser.GameObjects.Image;
  screenFrame: number;
}

/**
 * Which atlas row a step uses, and whether it is mirrored. Movement picks a facing from the tile
 * delta, so a sprite never turns mid-tile; a pure vertical step decides up from down.
 */
export function directionBetween(
  from: OfficePoint,
  to: OfficePoint,
): { direction: Direction; flipX: boolean } {
  const dx = to.x - from.x;
  if (dx !== 0) return { direction: "right", flipX: dx < 0 };
  return { direction: to.y < from.y ? "up" : "down", flipX: false };
}

/** Which clip an office action holds. Agents work and read at their station, and sit out a block. */
function poseFor(action: OfficeAction): Pose {
  switch (action) {
    case "working":
    case "shell":
      return "type";
    case "reading":
      return "read";
    case "blocked":
    case "error":
      return "seated";
    default:
      return "stand";
  }
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
      for (const mover of this.movers.values()) {
        if (mover.path.length === 0) {
          this.tickPose(mover, delta);
          this.maybeWander(mover, time);
          continue;
        }
        mover.carry += delta;
        while (mover.carry >= STEP_MS && mover.path.length > 0) {
          mover.carry -= STEP_MS;
          const next = mover.path.shift();
          if (next === undefined) break;
          const facing = directionBetween(mover.tile, next);
          mover.tile = next;
          mover.step += 1;
          mover.pose = "walk";
          mover.direction = facing.direction;
          mover.flipX = facing.flipX;
          // Walk frames advance with the tile, so the cycle can never drift from the distance.
          mover.poseFrame = mover.step % this.framesFor("walk").length;
          this.place(mover);
          this.paint(mover);
        }
        if (mover.path.length === 0) {
          mover.arrivedAt = time;
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
          const edge = x === 0 || x === map.width - 1 || y === map.height - 1;
          if (!edge && y >= map.wallRows) continue;
          const frame = y === 0 && map.windows.includes(x) ? map.windowFrame : map.wallFrame;
          this.addFrame(assets, frame, x * tile, y * tile, 1);
        }
      }
      // Furniture sorts by the bottom of its art, so an agent standing on the row below a desk draws
      // in front of it — the rule the reference office uses. A surface item then sorts half a pixel
      // in front of the piece whose tiles it covers, and the character in front of both.
      const bottoms = map.furniture.map(
        (item) => item.y * tile + (assets.manifest.frames[item.frame]?.h ?? tile),
      );
      map.furniture.forEach((item, index) => {
        let depth = bottoms[index] ?? 0;
        if (item.surface === true) {
          let support = 0;
          map.furniture.forEach((other, otherIndex) => {
            if (otherIndex === index || other.surface === true) return;
            const frame = assets.manifest.frames[other.frame];
            const covers =
              item.x >= other.x &&
              item.x < other.x + (frame?.w ?? tile) / tile &&
              item.y >= other.y &&
              item.y < other.y + (frame?.h ?? tile) / tile;
            const bottom = bottoms[otherIndex] ?? 0;
            if (covers && bottom > support) support = bottom;
          });
          if (support > 0) depth = support + 0.5;
        }
        this.addFrame(assets, item.frame, item.x * tile, item.y * tile, depth);
      });
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
      for (const file of manifest.files) {
        // A blocked or broken load still leaves a texture key behind, and painting one shows the
        // missing-texture tile instead of a failure. A decoded source is the only proof of success.
        const source = this.textures.get(file).getSourceImage() as { width: number };
        if (source.width === 0) throw new Error("office asset failed to decode: " + file);
      }
      for (const [name, frame] of Object.entries(manifest.frames)) {
        this.textures.get(frame.file).add(name, 0, frame.x, frame.y, frame.w, frame.h);
      }
      // One named frame per character, direction and column, so a pose is a name and not an index.
      const sheet = manifest.characters;
      const stride = sheet.columns * sheet.frameWidth;
      for (let character = 0; character < sheet.count; character += 1) {
        sheet.directions.forEach((direction, row) => {
          for (let column = 0; column < sheet.columns; column += 1) {
            this.textures
              .get(sheet.file)
              .add(
                `char-${character}-${direction}-${column}`,
                0,
                character * stride + column * sheet.frameWidth,
                row * sheet.frameHeight,
                sheet.frameWidth,
                sheet.frameHeight,
              );
          }
        });
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
        // A removed agent keeps no reference alive: its three objects die with the roster entry.
        mover.sprite.destroy();
        mover.marker.destroy();
        mover.bubble.destroy();
        mover.screen.destroy();
        mover.ring.destroy();
        mover.nameplate.destroy();
        this.movers.delete(agentId);
      }
      for (const mover of this.movers.values()) this.applySelection(mover);
    };

    /**
     * Stands an agent's monitor on the desk above its seat. The desk's art covers the two rows above
     * the seat and its surface starts eleven pixels into that box; a half pixel puts the monitor in
     * front of the desk and behind the agent, whose depth is its feet.
     */
    private standMonitor(mover: Mover): void {
      const assets = this.assets;
      if (assets === undefined) return;
      const { tile } = assets.map;
      const top = (mover.state.desk.y - 2) * tile;
      const left = mover.state.desk.x * tile + tile / 2;
      mover.screen.setPosition(left, top).setDepth(top + tile * 2 + 0.5);
    }

    private spawn(state: AgentOfficeState): void {
      const assets = this.assets;
      if (assets === undefined) return;
      const { tile } = assets.map;
      const sheet = assets.manifest.characters;
      const character = hashAgentId(state.agentId) % sheet.count;

      // Feet on the tile's bottom edge: the art is two tiles tall, so its upper half covers the row
      // above and the furniture there hides the agent's legs instead of its head.
      const px = state.desk.x * tile + tile / 2;
      const py = (state.desk.y + 1) * tile;
      const sprite = this.add
        .image(px, py, sheet.file, `char-${character}-down-0`)
        .setOrigin(0.5, 1)
        .setDepth(py);
      const marker = this.add
        .text(px, py - sheet.frameHeight - MARKER_GAP, this.markerFor(state.action), {
          fontFamily: "monospace",
          fontSize: "8px",
          color: "#f6c95c",
        })
        .setOrigin(0.5, 1)
        .setDepth(MARKER_DEPTH);
      // Spec §9.4: the approval title rides above the character; the roster row carries the same
      // text, so nothing here is the only copy.
      const bubble = this.add
        .text(px, py - sheet.frameHeight - MARKER_GAP - BUBBLE_GAP, state.bubble ?? "", {
          fontFamily: "monospace",
          fontSize: "8px",
          color: "#16161c",
          backgroundColor: "#f6f0dc",
          padding: { x: 3, y: 1 },
          wordWrap: { width: 96 },
        })
        .setOrigin(0.5, 1)
        .setDepth(BUBBLE_DEPTH)
        .setVisible(state.bubble !== null);

      const screen = this.add.image(0, 0, "room.png", "pc-off").setOrigin(0.5, 0);
      // A nameplate under the feet and a ring around them, both hidden until this agent is selected:
      // the sprite is 16 pixels wide, so a tint alone is hard to find in a room of twelve.
      const ring = this.add
        .ellipse(px, py - RING_HEIGHT / 2, RING_WIDTH, RING_HEIGHT, SELECTED_TINT, 0.55)
        .setDepth(py - 0.5)
        .setVisible(false);
      const nameplate = this.add
        .text(px, py + 1, state.name, {
          fontFamily: "monospace",
          fontSize: "8px",
          color: "#16161c",
          backgroundColor: SELECTED_ACCENT,
          padding: { x: 3, y: 1 },
        })
        .setOrigin(0.5, 0)
        .setDepth(MARKER_DEPTH)
        .setVisible(false);

      sprite.setInteractive();
      sprite.on("pointerdown", () => {
        this.game.events.emit(OFFICE_SELECT_EVENT, state.agentId);
      });

      const mover: Mover = {
        state,
        sprite,
        marker,
        bubble,
        ring,
        nameplate,
        tile: { x: state.desk.x, y: state.desk.y },
        path: [],
        carry: 0,
        step: 0,
        arrivedAt: 0,
        atLounge: false,
        character,
        direction: "down",
        flipX: false,
        pose: undefined,
        poseElapsed: 0,
        poseFrame: 0,
        screen,
        screenFrame: 0,
      };
      this.movers.set(state.agentId, mover);
      this.standMonitor(mover);
      this.applyState(mover, state, true);
    }

    private applyState(mover: Mover, state: AgentOfficeState, fresh = false): void {
      const previous = mover.state;
      const changed =
        fresh ||
        previous.action !== state.action ||
        previous.desk.x !== state.desk.x ||
        previous.desk.y !== state.desk.y;
      const moved = previous.desk.x !== state.desk.x || previous.desk.y !== state.desk.y;
      mover.state = state;
      // A desk can be re-assigned when two agents collide, and the monitor belongs to the desk.
      if (moved) this.standMonitor(mover);
      mover.marker.setText(this.markerFor(state.action));
      mover.bubble.setText(state.bubble ?? "");
      mover.bubble.setVisible(state.bubble !== null);

      if (this.reducedMotion) {
        if (!changed && mover.path.length === 0) return;
        mover.path = [];
        this.snap(mover, this.destinationFor(state));
        this.startAction(mover);
        return;
      }
      if (!changed) {
        // Roster snapshots arrive every 250 ms; an unchanged agent must not restart its animation.
        if (mover.path.length === 0) this.startAction(mover);
        return;
      }

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
      else this.startWalk(mover);
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
      this.startWalk(mover);
    }

    private snap(mover: Mover, tile: OfficePoint): void {
      mover.tile = { x: tile.x, y: tile.y };
      this.place(mover);
    }

    /** Positions the sprite, marker and bubble from the mover's tile, feet on the tile's bottom. */
    private place(mover: Mover): void {
      const assets = this.assets;
      if (assets === undefined) return;
      const { tile } = assets.map;
      const { frameHeight } = assets.manifest.characters;
      const px = mover.tile.x * tile + tile / 2;
      const py = (mover.tile.y + 1) * tile;
      mover.sprite.setPosition(px, py).setDepth(py);
      mover.marker.setPosition(px, py - frameHeight - MARKER_GAP);
      mover.bubble.setPosition(px, py - frameHeight - MARKER_GAP - BUBBLE_GAP);
      mover.ring.setPosition(px, py - RING_HEIGHT / 2);
      mover.nameplate.setPosition(px, py + 1);
    }

    /** The frame list a pose cycles through; a still pose is a single element, never a special case. */
    private framesFor(pose: Pose): number[] {
      if (pose === "stand") return [0];
      const frames = this.assets?.manifest.characters.clips[pose];
      return frames === undefined || frames.length === 0 ? [0] : frames;
    }

    /** Applies the current frame; the only place a cast frame name is ever built. */
    private paint(mover: Mover): void {
      if (mover.pose === undefined) return;
      const frames = this.framesFor(mover.pose);
      const column = frames[mover.poseFrame % frames.length] ?? 0;
      mover.sprite.setFrame(`char-${mover.character}-${mover.direction}-${column}`);
      mover.sprite.setFlipX(mover.flipX);
      // A working agent's screen flickers; every other pose leaves it dark.
      mover.screen.setFrame(
        mover.pose === "type" ? `pc-on-${1 + (mover.screenFrame % 3)}` : "pc-off",
      );
    }

    /** Advances a looping clip on the game clock; walk is excluded because tile steps drive it. */
    private tickPose(mover: Mover, delta: number): void {
      if (mover.pose === undefined) return;
      const frames = this.framesFor(mover.pose);
      if (frames.length < 2) return;
      mover.poseElapsed += delta;
      const interval = POSE_MS[mover.pose];
      if (mover.poseElapsed < interval) return;
      mover.poseElapsed -= interval;
      mover.poseFrame = (mover.poseFrame + 1) % frames.length;
      mover.screenFrame += 1;
      this.paint(mover);
    }

    /**
     * The still-or-looping pose an agent holds at its station. Idempotent, so the 250 ms roster
     * snapshots cannot restart a clip mid-cycle.
     */
    private startAction(mover: Mover): void {
      const pose = poseFor(mover.state.action);
      // Every station's art sits on its own row, so the agent faces the row above it.
      if (mover.pose === pose && mover.direction === "up" && !mover.flipX) return;
      if (mover.pose !== pose) {
        mover.poseElapsed = 0;
        mover.poseFrame = 0;
        mover.screenFrame = 0;
      }
      mover.pose = pose;
      mover.direction = "up";
      mover.flipX = false;
      this.paint(mover);
    }

    /** Switches to the walk clip before the first tile lands, so the very first step is animated. */
    private startWalk(mover: Mover): void {
      const next = mover.path[0];
      if (next === undefined) return;
      const facing = directionBetween(mover.tile, next);
      mover.pose = "walk";
      mover.direction = facing.direction;
      mover.flipX = facing.flipX;
      mover.poseElapsed = 0;
      mover.poseFrame = 0;
      this.paint(mover);
    }

    private applySelection(mover: Mover): void {
      const selected = mover.state.agentId === this.selectedId;
      if (selected) mover.sprite.setTint(SELECTED_TINT);
      else mover.sprite.clearTint();
      mover.ring.setVisible(selected);
      mover.nameplate.setVisible(selected);
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
