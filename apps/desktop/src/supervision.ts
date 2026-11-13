export interface SupervisionDeps {
  /** `true` while the kernel on the recorded port answers as itself. */
  probe(): Promise<boolean>;
  /** Attach-or-spawn, the same path a launch takes. */
  respawn(): Promise<void>;
  onState?(state: SupervisionState): void;
  now?(): number;
  intervalMs?: number;
  /** Consecutive misses before acting; one busy machine is not a dead one. */
  misses?: number;
  /** Floor between two respawns, so a crash loop cannot become a spawn loop. */
  cooldownMs?: number;
}

export interface SupervisionState {
  alive: boolean;
  misses: number;
  /** Set when the last attempt to bring the kernel back failed. */
  error?: string;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MISSES = 2;
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Watches the daemon the app is supposed to be talking to. The kernel outlives the window, which is
 * exactly why nobody notices when it stops answering: the tray keeps looking fine.
 */
export class Supervision {
  private timer: ReturnType<typeof setInterval> | undefined;
  private misses = 0;
  private lastRespawnAt = 0;
  private running = false;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(private readonly deps: SupervisionDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.threshold = deps.misses ?? DEFAULT_MISSES;
    this.cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll. Public so the tests drive it without a clock. */
  async tick(): Promise<void> {
    // A slow health check must not stack: the next interval waits for this one.
    if (this.running) return;
    this.running = true;
    try {
      await this.check();
    } finally {
      this.running = false;
    }
  }

  private async check(): Promise<void> {
    if (await this.deps.probe()) {
      this.misses = 0;
      this.deps.onState?.({ alive: true, misses: 0 });
      return;
    }
    this.misses += 1;
    if (this.misses < this.threshold) {
      this.deps.onState?.({ alive: false, misses: this.misses });
      return;
    }
    if (this.now() - this.lastRespawnAt < this.cooldownMs) {
      // Still inside the window: report, do not hammer. The next tick after the window tries again.
      this.deps.onState?.({ alive: false, misses: this.misses, error: "restarting too often; waiting" });
      return;
    }
    this.lastRespawnAt = this.now();
    try {
      await this.deps.respawn();
      this.misses = 0;
      this.deps.onState?.({ alive: true, misses: 0 });
    } catch (error) {
      this.deps.onState?.({
        alive: false,
        misses: this.misses,
        error: error instanceof Error ? error.message : "could not restart the kernel",
      });
    }
  }
}
