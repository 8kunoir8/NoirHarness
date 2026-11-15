/**
 * Every timer in the renderer comes from here.
 *
 * A raw `setTimeout` hands back an id the caller has to remember to clear, and the one path that
 * forgets keeps a callback alive after its component is gone. These primitives hand back the
 * canceller instead, so a forgetting site cannot compile into a leak. `noir/no-bare-timer` rejects
 * the raw names everywhere else in the renderer.
 */

/** Stops the run it came from. Calling it twice is a no-op. */
export type Cancel = () => void;

/** A run that has been asked for but has not happened yet. */
export interface Deferred {
  /** Ask for the run. */
  schedule: () => void;
  /** Drop a pending run. */
  cancel: Cancel;
}

/** Run `run` once, `ms` from now. */
export function after(ms: number, run: () => void): Cancel {
  const id = window.setTimeout(run, ms);
  return () => {
    window.clearTimeout(id);
  };
}

/** Run `run` every `ms` until cancelled. */
export function every(ms: number, run: () => void): Cancel {
  const id = window.setInterval(run, ms);
  return () => {
    window.clearInterval(id);
  };
}

function trailing(ms: number, run: () => void, restart: boolean): Deferred {
  let stop: Cancel | undefined;
  const drop = (): void => {
    stop?.();
    stop = undefined;
  };
  return {
    schedule: () => {
      // Coalescing keeps the run already scheduled; debouncing pushes it back on every call.
      if (restart) drop();
      else if (stop !== undefined) return;
      stop = after(ms, () => {
        stop = undefined;
        run();
      });
    },
    cancel: drop,
  };
}

/** One run per burst: calls made while a run is pending are absorbed by it. */
export function coalesce(ms: number, run: () => void): Deferred {
  return trailing(ms, run, false);
}

/** One run after the burst ends: every call pushes the run back by `ms`. */
export function debounce(ms: number, run: () => void): Deferred {
  return trailing(ms, run, true);
}
