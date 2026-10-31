import { EvidenceContractError } from "./errors";
import type {
  EvidenceChunk,
  EvidenceScope,
  GroundedContext,
  GroundedEvidence,
  ResourceKind,
  RetrievalStrategy,
} from "./types";

const POSITION_EPSILON = 1e-6;

export interface ContextOptions {
  maxChunks?: number;
  maxTotalChars?: number;
  retrieval?: RetrievalStrategy;
}

export const DEFAULT_CONTEXT_OPTIONS: Required<ContextOptions> = {
  maxChunks: 8,
  maxTotalChars: 8_000,
  retrieval: "keyword",
};

/**
 * The playback position is caller-supplied, so it is validated against the real
 * lesson duration before any evidence selection. Callers must load the duration
 * from the lesson record, not trust a client value.
 */
export function validateLearnerPosition(position: number, duration: number): number {
  if (!Number.isFinite(position)) {
    throw new EvidenceContractError("invalid_position", "The playback position is not a number.");
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new EvidenceContractError(
      "lesson_duration_unknown",
      "The lesson duration is unknown, so position-aware evidence cannot be selected.",
    );
  }
  if (position < 0) {
    throw new EvidenceContractError("position_out_of_range", "The playback position is negative.");
  }
  if (position > duration + POSITION_EPSILON) {
    throw new EvidenceContractError(
      "position_out_of_range",
      "The playback position is beyond the lesson duration.",
    );
  }
  return position;
}

export function validateScope(scope: EvidenceScope): EvidenceScope {
  if (!scope.userId.trim() || !scope.lessonId.trim()) {
    throw new EvidenceContractError("invalid_scope", "The learner and lesson must be identified.");
  }
  if (scope.lessonIsDemo && scope.lessonOwnerId !== null) {
    throw new EvidenceContractError("invalid_scope", "A demo lesson cannot have a private owner.");
  }
  if (!scope.lessonIsDemo && scope.lessonOwnerId !== scope.userId) {
    throw new EvidenceContractError(
      "unauthorized_scope",
      "The learner does not own this private lesson.",
    );
  }
  validateLearnerPosition(scope.positionSeconds, scope.lessonDurationSeconds);
  return scope;
}

function locatorMatchesKind(chunk: EvidenceChunk): boolean {
  const expected: Record<ResourceKind, EvidenceChunk["locator"]["kind"]> = {
    video_transcript: "video",
    pdf: "page",
    slides: "slide",
    markdown: "text",
    text: "text",
    code: "text",
  };
  return expected[chunk.resourceKind] === chunk.locator.kind;
}

function validLocator(scope: EvidenceScope, chunk: EvidenceChunk): boolean {
  if (!locatorMatchesKind(chunk)) return false;
  const locator = chunk.locator;
  if (locator.kind === "video") {
    if (locator.lessonId !== scope.lessonId) return false;
    if (chunk.lessonId !== undefined && chunk.lessonId !== scope.lessonId) return false;
    return (
      Number.isFinite(locator.startSeconds) &&
      Number.isFinite(locator.endSeconds) &&
      locator.startSeconds >= 0 &&
      locator.endSeconds > locator.startSeconds &&
      locator.endSeconds <= scope.lessonDurationSeconds + POSITION_EPSILON
    );
  }
  if (locator.kind === "page") {
    if (!(Number.isInteger(locator.pageNumber) && locator.pageNumber > 0)) return false;
    return validAlignment(scope, chunk);
  }
  if (locator.kind === "slide") {
    if (!(Number.isInteger(locator.slideNumber) && locator.slideNumber > 0)) return false;
    return validAlignment(scope, chunk);
  }
  return validAlignment(scope, chunk);
}

function availabilityOf(chunk: EvidenceChunk): "always" | "timeline" | "unknown" {
  if (chunk.locator.kind === "video") return "timeline";
  return chunk.availability ?? "unknown";
}

function validAlignment(scope: EvidenceScope, chunk: EvidenceChunk): boolean {
  const policy = availabilityOf(chunk);
  if (policy === "always" || policy === "unknown") return true;
  return (
    policy === "timeline" &&
    Number.isFinite(chunk.alignmentStartSeconds) &&
    Number.isFinite(chunk.alignmentEndSeconds) &&
    (chunk.alignmentStartSeconds ?? -1) >= 0 &&
    (chunk.alignmentEndSeconds ?? 0) > (chunk.alignmentStartSeconds ?? 0) &&
    (chunk.alignmentEndSeconds ?? Infinity) <= scope.lessonDurationSeconds + POSITION_EPSILON &&
    chunk.lessonId === scope.lessonId
  );
}

/**
 * Demo resources are public. Private resources belong to exactly one learner,
 * and a lesson-scoped resource cannot be borrowed from another lesson.
 */
export function isAuthorizedEvidence(scope: EvidenceScope, chunk: EvidenceChunk): boolean {
  if (chunk.status !== "ready") return false;
  if (!chunk.id.trim() || !chunk.text.trim()) return false;

  if (chunk.isDemo) {
    if (chunk.ownerId !== null) return false;
  } else {
    if (chunk.ownerId !== scope.userId) return false;
    if (
      chunk.courseId !== undefined &&
      scope.courseId !== undefined &&
      chunk.courseId !== scope.courseId
    ) {
      return false;
    }
  }
  if (!validLocator(scope, chunk)) return false;

  // Video transcripts are strictly lesson-scoped so a future lesson's spoken
  // content cannot leak into an earlier lesson. Documents may be course-level.
  if (
    chunk.resourceKind === "video_transcript" &&
    chunk.lessonId !== undefined &&
    chunk.lessonId !== scope.lessonId
  ) {
    return false;
  }
  return true;
}

/** Video evidence is eligible only once the learner has passed its end time. */
export function isEligibleAtPosition(scope: EvidenceScope, chunk: EvidenceChunk): boolean {
  if (chunk.locator.kind === "video") {
    return chunk.locator.endSeconds <= scope.positionSeconds + POSITION_EPSILON;
  }
  const availability = availabilityOf(chunk);
  if (availability === "always") return true;
  if (availability === "unknown") return scope.allowUnknownReferences === true;
  return (
    availability === "timeline" &&
    Number.isFinite(chunk.alignmentEndSeconds) &&
    (chunk.alignmentEndSeconds ?? Infinity) <= scope.positionSeconds + POSITION_EPSILON
  );
}

export function isEligibleEvidence(scope: EvidenceScope, chunk: EvidenceChunk): boolean {
  return isAuthorizedEvidence(scope, chunk) && isEligibleAtPosition(scope, chunk);
}

export function selectEligibleEvidence(
  scope: EvidenceScope,
  chunks: EvidenceChunk[],
): EvidenceChunk[] {
  validateScope(scope);
  const seen = new Set<string>();
  const selected: EvidenceChunk[] = [];
  for (const chunk of chunks) {
    if (!isEligibleEvidence(scope, chunk)) continue;
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    selected.push(chunk);
  }
  return selected;
}

function toModelEvidence(chunk: EvidenceChunk): GroundedEvidence {
  return {
    id: chunk.id,
    text: chunk.text,
    resourceKind: chunk.resourceKind,
    locator: chunk.locator,
    availability: availabilityOf(chunk),
    ...(chunk.provenance === undefined ? {} : { provenance: chunk.provenance }),
  };
}

/**
 * Builds the only evidence that may be handed to a model. It selects before
 * generation and never truncates a chunk: a chunk that does not fit the budget
 * is omitted, so the model cannot see half a sentence presented as complete.
 */
export function buildGroundedContext(
  scope: EvidenceScope,
  chunks: EvidenceChunk[],
  options: ContextOptions = {},
): GroundedContext {
  const limits = { ...DEFAULT_CONTEXT_OPTIONS, ...options };
  if (!Number.isInteger(limits.maxChunks) || limits.maxChunks < 1) {
    throw new EvidenceContractError("invalid_scope", "maxChunks must be a positive integer.");
  }
  if (!Number.isInteger(limits.maxTotalChars) || limits.maxTotalChars < 1) {
    throw new EvidenceContractError("invalid_scope", "maxTotalChars must be a positive integer.");
  }

  const selected = selectEligibleEvidence(scope, chunks);
  const evidence: GroundedEvidence[] = [];
  let chars = 0;
  for (const chunk of selected) {
    if (evidence.length >= limits.maxChunks) break;
    if (chunk.text.length > limits.maxTotalChars - chars) continue;
    evidence.push(toModelEvidence(chunk));
    chars += chunk.text.length;
  }

  if (!evidence.length) {
    throw new EvidenceContractError(
      "insufficient_evidence",
      "No eligible evidence is available within the requested scope.",
    );
  }

  return { scope, evidence, retrieval: options.retrieval ?? "keyword" };
}
