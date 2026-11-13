import { z } from "zod";

/** One automation: a prompt replayed against one agent in one workspace on a cadence. */
export const ScheduleView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  name: z.string(),
  prompt: z.string(),
  intervalMinutes: z.number().int().positive(),
  anchorMinutes: z.number().int().min(0).max(1439),
  enabled: z.boolean(),
  nextRunAt: z.number().int(),
  lastRunAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  /** Derived: the newest run is `fired` and its session has not finished. Never stored. */
  running: z.boolean(),
});
export type ScheduleView = z.infer<typeof ScheduleView>;

export const ScheduleRunStatus = z.enum(["fired", "skipped", "missed", "failed"]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatus>;

export const ScheduleRunView = z.object({
  id: z.string(),
  scheduleId: z.string(),
  status: ScheduleRunStatus,
  dueAt: z.number().int(),
  startedAt: z.number().int(),
  /** Null when the fire never reached session creation, or when the process died in between. */
  sessionId: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ScheduleRunView = z.infer<typeof ScheduleRunView>;

export const ScheduleListParams = z.object({ workspaceId: z.string().min(1).optional() });
export const ScheduleListResult = z.object({ schedules: z.array(ScheduleView) });
export type ScheduleListResult = z.infer<typeof ScheduleListResult>;

export const ScheduleCreateParams = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1),
  intervalMinutes: z.number().int().min(1).max(525_600),
  anchorMinutes: z.number().int().min(0).max(1439).default(0),
  enabled: z.boolean().default(true),
});
export type ScheduleCreateParams = z.infer<typeof ScheduleCreateParams>;

export const ScheduleUpdateParams = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    prompt: z.string().trim().min(1).optional(),
    intervalMinutes: z.number().int().min(1).max(525_600).optional(),
    anchorMinutes: z.number().int().min(0).max(1439).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 1, { message: "Provide at least one field to update" });
export type ScheduleUpdateParams = z.infer<typeof ScheduleUpdateParams>;

export const ScheduleDeleteParams = z.object({ id: z.string().min(1) });
export const ScheduleDeleteResult = z.object({ ok: z.literal(true) });
export type ScheduleDeleteResult = z.infer<typeof ScheduleDeleteResult>;

export const ScheduleRunNowParams = z.object({ id: z.string().min(1) });

export const ScheduleRunsParams = z.object({
  id: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  before: z.number().int().optional(),
});
export type ScheduleRunsParams = z.infer<typeof ScheduleRunsParams>;

export const ScheduleRunsResult = z.object({
  runs: z.array(ScheduleRunView),
  /** The `dueAt` to pass back for the next page; null when this page is the last. */
  nextBefore: z.number().int().nullable(),
});
export type ScheduleRunsResult = z.infer<typeof ScheduleRunsResult>;
