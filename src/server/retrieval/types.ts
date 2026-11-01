import type { EmbeddingSpace } from "../ai/embeddings/types";

export type ResourceKind = "video_transcript" | "pdf" | "slides" | "markdown" | "text" | "code";

export type ProcessingStatus = "pending" | "processing" | "ready" | "failed";

export type EvidenceLocator =
  | {
      kind: "video";
      lessonId: string;
      startSeconds: number;
      endSeconds: number;
    }
  | { kind: "page"; pageNumber: number }
  | { kind: "slide"; slideNumber: number }
  | { kind: "text"; section?: string };

export interface EvidenceProvenance {
  title?: string;
  /** Public source URL. Never a signed/private storage URL. */
  sourceUrl?: string;
}

export type EvidenceAvailability = "always" | "timeline" | "unknown";

/**
 * One retrievable unit. `ownerId` is null only for demo resources; a private
 * resource without an owner is invalid and is never returned to a learner.
 */
export interface EvidenceChunk {
  id: string;
  resourceId: string;
  resourceKind: ResourceKind;
  isDemo: boolean;
  ownerId: string | null;
  courseId?: string;
  lessonId?: string;
  status: ProcessingStatus;
  text: string;
  locator: EvidenceLocator;
  provenance?: EvidenceProvenance;
  /** Explicit resource policy. Missing historical metadata is treated as unknown. */
  availability?: EvidenceAvailability;
  /** Timeline alignment for non-video resources, in lesson seconds. */
  alignmentStartSeconds?: number;
  alignmentEndSeconds?: number;
  /** The exact embedding space that produced this vector, if any. */
  embeddingSpace?: EmbeddingSpace;
  /** A vector already stored by ingestion, only when its space matches. */
  embedding?: number[];
  embeddingSpaceKey?: string;
}

export interface EvidenceScope {
  userId: string;
  courseId?: string;
  lessonId: string;
  lessonOwnerId: string | null;
  lessonIsDemo: boolean;
  lessonDurationSeconds: number;
  /** Learner's current playback position. Validated by the server. */
  positionSeconds: number;
  /** Unknown-alignment sources may be consulted as references only on request. */
  allowUnknownReferences?: boolean;
}

export interface GroundedEvidence {
  id: string;
  text: string;
  resourceKind: ResourceKind;
  locator: EvidenceLocator;
  provenance?: EvidenceProvenance;
  availability: EvidenceAvailability;
}

export type RetrievalStrategy = "keyword" | "semantic" | "hybrid" | "summary";

export interface GroundedContext {
  scope: EvidenceScope;
  evidence: GroundedEvidence[];
  retrieval: RetrievalStrategy;
}

export interface RetrievalMatch {
  chunk: EvidenceChunk;
  score: number;
}

export interface Citation {
  evidenceId: string;
  /** Optional short quote. Checked against the retrieved evidence text. */
  quote?: string;
}

export interface GroundedAnswerDraft {
  text: string;
  citations: Citation[];
}

export interface CitationIssue {
  code:
    | "missing_citation"
    | "invalid_citation"
    | "unknown_citation"
    | "ineligible_citation"
    | "duplicate_citation"
    | "quote_mismatch";
  evidenceId?: string;
  detail: string;
}

export interface CitationValidation {
  ok: boolean;
  issues: CitationIssue[];
  verified: Citation[];
}

export type EvidenceFailureCode =
  | "invalid_scope"
  | "invalid_position"
  | "lesson_duration_unknown"
  | "position_out_of_range"
  | "unauthorized_scope"
  | "invalid_evidence"
  | "insufficient_evidence";

export type InsufficientReason =
  "no_eligible_evidence" | "no_matching_evidence" | "context_budget_exceeded";

export type GroundedPreparation =
  | {
      status: "ready";
      context: GroundedContext;
      matches: RetrievalMatch[];
    }
  | {
      status: "insufficient_evidence";
      reason: InsufficientReason;
      eligibleCount: number;
    };
