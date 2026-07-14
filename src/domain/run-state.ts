export const RUN_STATES = [
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

const transitions: Readonly<Record<RunState, readonly RunState[]>> = {
  QUEUED: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: ["WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function assertRunTransition(from: RunState, to: RunState): void {
  if (!transitions[from].includes(to)) {
    throw new Error(`invalid run transition: ${from} -> ${to}`);
  }
}
