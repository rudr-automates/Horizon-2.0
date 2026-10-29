export interface AiLogFields {
  correlationId?: string;
  providerId?: string;
  modelId?: string;
  attempt?: number;
  errorCode?: string;
  durationMs?: number;
  candidates?: number;
  reason?: string;
  fallback?: boolean;
  inputChars?: number;
  outputTokens?: number;
}

export interface AiLogger {
  info(event: string, fields?: AiLogFields): void;
  warn(event: string, fields?: AiLogFields): void;
  error(event: string, fields?: AiLogFields): void;
}

const ALLOWED_FIELDS: ReadonlyArray<keyof AiLogFields> = [
  "correlationId",
  "providerId",
  "modelId",
  "attempt",
  "errorCode",
  "durationMs",
  "candidates",
  "reason",
  "fallback",
  "inputChars",
  "outputTokens",
];

const MAX_STRING = 80;

/** Whitelist-based scrubber: unknown keys, content and secrets never get through. */
export function sanitizeLogFields(
  fields: AiLogFields = {},
): Record<string, string | number | boolean> {
  const clean: Record<string, string | number | boolean> = {};
  for (const key of ALLOWED_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value === "string") {
      clean[key] = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    } else if (typeof value === "number") {
      clean[key] = Number.isFinite(value) ? value : 0;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    }
  }
  return clean;
}

export function createAiLogger(sink: Pick<Console, "info" | "warn" | "error"> = console): AiLogger {
  const write = (level: "info" | "warn" | "error", event: string, fields?: AiLogFields): void => {
    const payload = { event, ...sanitizeLogFields(fields) };
    try {
      sink[level](JSON.stringify(payload));
    } catch {
      // Logging must never break a learner request.
    }
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

export function silentLogger(): AiLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
