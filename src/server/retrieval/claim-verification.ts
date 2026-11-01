export type ClaimVerdict = "supported" | "unsupported" | "contradicted" | "uncertain";

export interface ClaimCheck {
  claim: string;
  verdict: ClaimVerdict;
  evidenceIds: string[];
}

/** Parse and validate the bounded verifier response. Any ambiguity fails closed. */
export function parseClaimChecks(
  text: string,
  expectedClaims: string[],
  allowedEvidenceIds: Set<string>,
): ClaimCheck[] | null {
  let payload: unknown;
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    payload = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { claims?: unknown }).claims)
  )
    return null;
  const rows = (payload as { claims: unknown[] }).claims;
  if (rows.length !== expectedClaims.length) return null;
  const result: ClaimCheck[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (typeof row !== "object" || row === null) return null;
    const record = row as Record<string, unknown>;
    const verdict = record["verdict"];
    const claim = record["claim"];
    const evidenceIds = record["evidenceIds"];
    if (
      typeof claim !== "string" ||
      claim !== expectedClaims[index] ||
      !["supported", "unsupported", "contradicted", "uncertain"].includes(String(verdict)) ||
      !Array.isArray(evidenceIds) ||
      evidenceIds.length === 0 ||
      !evidenceIds.every((id) => typeof id === "string" && allowedEvidenceIds.has(id))
    )
      return null;
    result.push({
      claim,
      verdict: verdict as ClaimVerdict,
      evidenceIds: [...new Set(evidenceIds as string[])],
    });
  }
  return result;
}

/** Sentence-level checks keep a mixed supported/unsupported answer from passing as one unit. */
export function factualSentences(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 8);
}
