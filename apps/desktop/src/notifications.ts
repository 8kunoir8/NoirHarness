import type { AgentEvent } from "@noir/protocol";

/** What shows a notification. Electron's `Notification` in the app, a recorder in the tests. */
export interface NotificationSink {
  show(title: string, body: string): void;
}

const MAX_BODY = 140;

function field(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  // A descriptor read keeps the value `unknown`: the payload came off a socket, not from a schema.
  const value = Object.getOwnPropertyDescriptor(payload, key)?.value;
  return typeof value === "string" ? value : undefined;
}

function truncate(text: string): string {
  return text.length <= MAX_BODY ? text : `${text.slice(0, MAX_BODY - 1)}…`;
}

/**
 * Watches the kernel's own event stream for scheduled turns and raises one notification per run.
 *
 * The window may not exist, so this lives in the app process and holds no view state: a session is
 * "scheduled" only because its `session.created` said so, and it is reported once however many
 * completion frames arrive (a reconnect can replay).
 */
export class ScheduleWatcher {
  private readonly scheduled: Record<string, true> = {};
  private readonly notified: Record<string, true> = {};
  private readonly titles: Record<string, string> = {};

  constructor(private readonly sink: NotificationSink) {}

  /** Sessions seen since launch that a schedule started. Sorted, for the tests and the log. */
  sessions(): string[] {
    return Object.keys(this.scheduled).sort();
  }

  observe(event: AgentEvent): void {
    if (event.type === "session.created") {
      if (field(event.payload, "scheduleId") !== undefined) this.scheduled[event.sessionId] = true;
      const title = field(event.payload, "title");
      if (title !== undefined && title !== "") this.titles[event.sessionId] = title;
      return;
    }
    if (event.type === "session.updated") {
      const title = field(event.payload, "title");
      if (title !== undefined && title !== "") this.titles[event.sessionId] = title;
      return;
    }
    if (event.type !== "turn.completed" && event.type !== "turn.failed") return;
    if (this.scheduled[event.sessionId] !== true) return;
    if (this.notified[event.sessionId] === true) return;
    this.notified[event.sessionId] = true;

    const title = this.titles[event.sessionId] ?? "Scheduled run";
    if (event.type === "turn.failed") {
      this.sink.show("Scheduled run failed", truncate(`${title} — ${field(event.payload, "message") ?? "no reason given"}`));
      return;
    }
    this.sink.show("Scheduled run finished", truncate(title));
  }
}
