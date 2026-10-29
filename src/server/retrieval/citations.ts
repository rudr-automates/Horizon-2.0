import { EvidenceContractError } from "./errors";
import type {
  Citation,
  CitationIssue,
  CitationValidation,
  EvidenceChunk,
  GroundedAnswerDraft,
} from "./types";

export interface CitationValidationInput {
  /** Evidence that passed scope, ownership and timestamp checks. */
  eligible: EvidenceChunk[];
  /** All retrieved candidates, used to distinguish unknown from ineligible ids. */
  retrieved?: EvidenceChunk[];
}

/**
 * Drops repeated citations of the same evidence, keeping the first. A model
 * that cites one passage twice is a formatting slip, not a grounding failure:
 * every remaining citation is still checked for scope and a verbatim quote,
 * so nothing new can enter the answer through the copy.
 */
export function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const output: Citation[] = [];
  for (const citation of citations) {
    const id = typeof citation?.evidenceId === "string" ? citation.evidenceId.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(citation);
  }
  return output;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Validates a draft answer's citations against the evidence that was eligible
 * before generation. A citation label alone is never accepted: the id must
 * exist, be in scope, and an optional quote must occur in that evidence.
 *
 * Quote matching is a surface check, not a semantic entailment proof. It
 * catches invented quotations; a human or a later verifier still has to judge
 * whether the source supports the whole claim.
 */
export function validateGroundedAnswer(
  draft: GroundedAnswerDraft,
  input: CitationValidationInput,
): CitationValidation {
  if (typeof draft.text !== "string" || !draft.text.trim()) {
    throw new EvidenceContractError("invalid_evidence", "The draft answer has no text.");
  }

  const eligible = new Map(input.eligible.map((chunk) => [chunk.id, chunk]));
  const retrieved = new Map((input.retrieved ?? input.eligible).map((chunk) => [chunk.id, chunk]));
  const issues: CitationIssue[] = [];
  const verified: Citation[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(draft.citations) || draft.citations.length === 0) {
    issues.push({
      code: "missing_citation",
      detail: "The answer must cite at least one eligible source.",
    });
    return { ok: false, issues, verified };
  }

  for (const citation of draft.citations) {
    if (!citation || typeof citation.evidenceId !== "string" || !citation.evidenceId.trim()) {
      issues.push({
        code: "invalid_citation",
        detail: "Every citation needs a non-empty evidence id.",
      });
      continue;
    }
    const id = citation.evidenceId.trim();
    if (seen.has(id)) {
      issues.push({
        code: "duplicate_citation",
        evidenceId: id,
        detail: "The same evidence id is cited more than once.",
      });
      continue;
    }
    seen.add(id);

    const chunk = eligible.get(id);
    if (!chunk) {
      issues.push({
        code: retrieved.has(id) ? "ineligible_citation" : "unknown_citation",
        evidenceId: id,
        detail: retrieved.has(id)
          ? "The citation points to evidence outside the learner's permitted scope."
          : "The citation does not match any retrieved evidence.",
      });
      continue;
    }

    if (citation.quote !== undefined) {
      if (
        typeof citation.quote !== "string" ||
        !citation.quote.trim() ||
        citation.quote.length > 500
      ) {
        issues.push({
          code: "invalid_citation",
          evidenceId: id,
          detail: "A citation quote must be non-empty and at most 500 characters.",
        });
        continue;
      }
      if (!normalize(chunk.text).includes(normalize(citation.quote))) {
        issues.push({
          code: "quote_mismatch",
          evidenceId: id,
          detail: "The quoted words do not appear in the cited evidence.",
        });
        continue;
      }
    }

    verified.push({ ...citation, evidenceId: id });
  }

  return { ok: issues.length === 0 && verified.length > 0, issues, verified };
}

export function assertGroundedAnswer(
  draft: GroundedAnswerDraft,
  input: CitationValidationInput,
): Citation[] {
  const result = validateGroundedAnswer(draft, input);
  if (!result.ok) {
    throw new EvidenceContractError(
      "invalid_evidence",
      result.issues.map((issue) => issue.detail).join(" "),
    );
  }
  return result.verified;
}
