/** Shared (client + server) shape of automatic video processing state. */

export type IngestionState =
  "none" | "queued" | "processing" | "ready" | "needs_captions" | "failed";

export interface IngestionStatus {
  lessonId: string;
  state: IngestionState;
  /** Short, learner-facing stage name, e.g. "Transcribing audio". */
  stage: string;
  message: string;
  /** 0-100 while a measurable upload is in progress. */
  percent?: number;
  errorCode?: string;
  canRetry: boolean;
  pollAfterMs?: number;
}

/** True while the pipeline is still doing work the browser should poll for. */
export function isIngestionActive(state: IngestionState): boolean {
  return state === "queued" || state === "processing";
}

/** True when the learner may ask the tutor or generate a quiz. */
export function isIngestionReady(state: IngestionState | undefined): boolean {
  return state === "ready";
}
