import { EvidenceContractError } from "./errors";
import { validateGroundedAnswer, type CitationValidationInput } from "./citations";
import { keywordRetrieve } from "./keyword";
import {
  buildGroundedContext,
  selectEligibleEvidence,
  validateScope,
  type ContextOptions,
} from "./scope";
import type {
  CitationValidation,
  EvidenceChunk,
  EvidenceScope,
  GroundedAnswerDraft,
  GroundedPreparation,
} from "./types";

/**
 * Prepares the evidence portion of a grounded answer. It performs authorization
 * and timestamp filtering before retrieval, then returns a context that a future
 * model call may use. It deliberately does not call a model or write an answer.
 */
export function prepareGroundedRequest(
  scope: EvidenceScope,
  query: string,
  chunks: EvidenceChunk[],
  options: { limit?: number; context?: ContextOptions } = {},
): GroundedPreparation {
  validateScope(scope);
  if (typeof query !== "string" || !query.trim()) {
    throw new EvidenceContractError("invalid_evidence", "The learner question is empty.");
  }

  const eligible = selectEligibleEvidence(scope, chunks);
  if (!eligible.length) {
    return { status: "insufficient_evidence", reason: "no_eligible_evidence", eligibleCount: 0 };
  }

  const matches = keywordRetrieve(query, eligible, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  if (!matches.length) {
    return {
      status: "insufficient_evidence",
      reason: "no_matching_evidence",
      eligibleCount: eligible.length,
    };
  }

  try {
    const context = buildGroundedContext(
      scope,
      matches.map((match) => match.chunk),
      options.context,
    );
    return { status: "ready", context, matches };
  } catch (error) {
    if (error instanceof EvidenceContractError && error.code === "insufficient_evidence") {
      return {
        status: "insufficient_evidence",
        reason: "context_budget_exceeded",
        eligibleCount: eligible.length,
      };
    }
    throw error;
  }
}

/** Re-checks a draft's citations after an answer is generated. */
export function verifyDraftCitations(
  draft: GroundedAnswerDraft,
  scope: EvidenceScope,
  retrieved: EvidenceChunk[],
): CitationValidation {
  validateScope(scope);
  const eligible = selectEligibleEvidence(scope, retrieved);
  return validateGroundedAnswer(draft, { eligible, retrieved } satisfies CitationValidationInput);
}
