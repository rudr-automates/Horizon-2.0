import type { AiErrorCode } from "@/server/ai/types";
import type {
  EvidenceAvailability,
  EvidenceLocator,
  ResourceKind,
  RetrievalStrategy,
} from "@/server/retrieval/types";

export type TutorMode = "question" | "explain" | "summary";

export interface TutorHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TutorRequest {
  lessonId: string;
  positionSeconds: number;
  question: string;
  mode?: TutorMode;
  history?: TutorHistoryMessage[];
}

export interface TutorCitation {
  evidenceId: string;
  text: string;
  resourceKind: ResourceKind;
  locator: EvidenceLocator;
  availability: EvidenceAvailability;
  title?: string;
  sourceUrl?: string;
  quote?: string;
}

export type TutorErrorCode =
  | AiErrorCode
  | "lesson_not_found"
  | "invalid_scope"
  | "citation_invalid"
  | "retrieval_unavailable"
  | "unknown";

export interface TutorSuccess {
  status: "answered";
  exchangeId?: string;
  answer: string;
  citations: TutorCitation[];
  providerId: string;
  modelId: string;
  retrieval: RetrievalStrategy;
  fallbackUsed: boolean;
  latencyMs: number;
  correlationId: string;
  usage: { inputTokens?: number; outputTokens?: number; source: string };
}

export interface TutorRefusal {
  status: "insufficient_evidence";
  reason:
    "no_eligible_evidence" | "no_matching_evidence" | "context_budget_exceeded" | "unverified";
  message: string;
  eligibleCount: number;
  retrieval: RetrievalStrategy;
  correlationId?: string;
}

export interface TutorFailure {
  status: "error";
  code: TutorErrorCode;
  message: string;
  retryAfterSeconds?: number;
  correlationId?: string;
}

export type TutorResponse = TutorSuccess | TutorRefusal | TutorFailure;
