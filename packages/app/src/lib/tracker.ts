// Step state. Every state change comes from a real request or a real event. A step is
// "running" only while a request is in flight, and it has the time at which it started.

export type StepState = "pending" | "running" | "done" | "failed";

export interface StepRecord {
  readonly id: string;
  readonly label: string;
  readonly state: StepState;
  // Unix milliseconds of the start of the current attempt, or null if the step has not run.
  readonly startedAt: number | null;
  // Unix milliseconds of the end (done or failed), or null.
  readonly endedAt: number | null;
  // Short facts about the step, in order. Values are text from real responses.
  readonly detail: readonly string[];
  // The error code of a failure, in plain words. Empty if the step did not fail.
  readonly error: string;
}

export function pendingStep(id: string, label: string): StepRecord {
  return { id, label, state: "pending", startedAt: null, endedAt: null, detail: [], error: "" };
}

export function startStep(step: StepRecord, now: number, detail: readonly string[] = step.detail): StepRecord {
  return { ...step, state: "running", startedAt: now, endedAt: null, detail, error: "" };
}

export function finishStep(step: StepRecord, now: number, detail: readonly string[]): StepRecord {
  return { ...step, state: "done", startedAt: step.startedAt ?? now, endedAt: now, detail, error: "" };
}

export function failStep(step: StepRecord, now: number, error: string, detail: readonly string[] = step.detail): StepRecord {
  return { ...step, state: "failed", startedAt: step.startedAt ?? now, endedAt: now, detail, error };
}

// Add facts to a step without a state change (progress of a running step).
export function noteStep(step: StepRecord, detail: readonly string[]): StepRecord {
  return { ...step, detail };
}

// Replace one step of a list by ID.
export function replaceStep(steps: readonly StepRecord[], next: StepRecord): StepRecord[] {
  return steps.map((step) => (step.id === next.id ? next : step));
}

// Elapsed milliseconds of a step at `now`: the running time, or the total time of a finished step.
export function elapsedMs(step: StepRecord, now: number): number | null {
  if (step.startedAt === null) return null;
  return (step.endedAt ?? now) - step.startedAt;
}
