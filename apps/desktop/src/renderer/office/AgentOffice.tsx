import { useEffect, useRef, useState } from "react";
import type { AgentOfficeState } from "./mapper.js";
import type { PhaserModule } from "./scene.js";
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
import "./office.css";

/** What React keeps: a tiny handle, never a Phaser object. */
interface OfficeGameHandle {
  push(
    states: readonly AgentOfficeState[],
    selectedId: string | undefined,
    reducedMotion: boolean,
  ): void;
  destroy(): void;
}

/** The subset of `Phaser.Game` the host drives; the cast below is confined to construction. */
interface OfficeGame {
  registry: { set(key: string, value: unknown): void };
  events: {
    on(event: string, handler: (payload?: unknown) => void): void;
    off(event: string, handler: (payload?: unknown) => void): void;
    emit(event: string, payload?: unknown): void;
  };
  destroy(removeCanvas: boolean): void;
}

interface PhaserDefault {
  default: PhaserModule;
}

export interface AgentOfficeProps {
  states: readonly AgentOfficeState[];
  selectedId?: string | undefined;
  reducedMotion?: boolean | undefined;
  onSelect?: ((agentId: string) => void) | undefined;
  /** Phaser could not build a renderer: the host shows "Office unavailable" and keeps the roster. */
  onUnavailable?: (() => void) | undefined;
}

/**
 * Owns the single `Phaser.Game` for the office pane. Phaser and the scene load together through
 * dynamic imports, so the startup bundle never contains either; the game is destroyed on unmount.
 */
export function AgentOffice({
  states,
  selectedId,
  reducedMotion = false,
  onSelect,
  onUnavailable,
}: AgentOfficeProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<OfficeGameHandle | undefined>(undefined);
  // `data-office-ready` must mean "booted and holding the first roster paint", not "mounted".
  const [ready, setReady] = useState(false);
  // The mount effect runs once, so it reads the newest props through this ref instead of stale ones.
  const latest = useRef({ states, selectedId, reducedMotion, onSelect, onUnavailable });
  latest.current = { states, selectedId, reducedMotion, onSelect, onUnavailable };

  useEffect(() => {
    let cancelled = false;

    async function start(): Promise<void> {
      try {
        const [phaserModule, sceneModule] = await Promise.all([
          // Phaser ships `export = Phaser`, which the type system exposes as a namespace, not a
          // default export; the runtime ESM bundle has one.
          import("phaser") as unknown as Promise<PhaserDefault>,
          import("./scene.js"),
        ]);
        if (cancelled) return;
        const parent = host.current;
        if (parent === null) return;

        const Phaser = phaserModule.default;
        // Phaser's own `Game` type satisfies this narrow handle, so nothing is asserted: keeping
        // the type local keeps Phaser out of React state and out of the component's public surface.
        const game: OfficeGame = new Phaser.Game({
          type: Phaser.AUTO,
          parent,
          width: OFFICE_WIDTH,
          height: OFFICE_HEIGHT,
          backgroundColor: "#16161c",
          pixelArt: true,
          fps: { target: 30 },
          scene: [sceneModule.createOfficeScene(Phaser)],
        });

        const select = (agentId?: unknown): void => {
          if (typeof agentId === "string") latest.current.onSelect?.(agentId);
        };
        game.events.on(OFFICE_SELECT_EVENT, select);

        // The scene loads assets inside an un-awaited `create`, so its failure cannot be caught by
        // the `try` above; the scene reports it instead of leaving a silent blank canvas.
        const unavailable = (): void => {
          if (cancelled) return;
          setReady(false);
          latest.current.onUnavailable?.();
        };
        game.events.on(OFFICE_UNAVAILABLE_EVENT, unavailable);

        game.registry.set(OFFICE_STATES_KEY, latest.current.states);
        game.registry.set(OFFICE_SELECTED_KEY, latest.current.selectedId);
        game.registry.set(OFFICE_REDUCED_KEY, latest.current.reducedMotion);

        handle.current = {
          push: (nextStates, nextSelected, nextReduced) => {
            game.registry.set(OFFICE_STATES_KEY, nextStates);
            game.registry.set(OFFICE_SELECTED_KEY, nextSelected);
            game.registry.set(OFFICE_REDUCED_KEY, nextReduced);
            game.events.emit(OFFICE_STATES_EVENT, nextStates);
          },
          destroy: () => {
            game.events.off(OFFICE_SELECT_EVENT, select);
            game.events.off(OFFICE_UNAVAILABLE_EVENT, unavailable);
            game.destroy(true);
          },
        };
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) {
          setReady(false);
          latest.current.onUnavailable?.();
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = undefined;
    };
  }, []);

  useEffect(() => {
    handle.current?.push(states, selectedId, reducedMotion);
  }, [states, selectedId, reducedMotion]);

  // The E2E surface: what the scene was handed, plus the stable desk assignment it was derived from.
  // Nothing inside the canvas is focusable or announced; the roster is the accessible office.
  const desks = ready
    ? JSON.stringify(
        Object.fromEntries(
          [...states]
            .sort((left, right) => left.agentId.localeCompare(right.agentId))
            .map((state) => [state.agentId, state.deskIndex]),
        ),
      )
    : undefined;

  return (
    <div
      className="office-canvas"
      ref={host}
      aria-hidden="true"
      data-office-ready={ready ? "true" : undefined}
      data-office-count={ready ? states.length : 0}
      data-office-desks={desks}
      data-office-selected={ready ? selectedId : undefined}
    />
  );
}
