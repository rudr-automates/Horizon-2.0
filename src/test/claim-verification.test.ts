import { describe, expect, it } from "vitest";
import { factualSentences, parseClaimChecks } from "@/server/retrieval/claim-verification";

describe("claim verifier contract", () => {
  const evidence = new Set(["owned-covered", "owned-doc"]);

  it("accepts only exact, supported sentence verdicts citing supplied evidence", () => {
    const claims = [
      "An embedding represents meaning in a vector space.",
      "Cosine similarity compares vector direction.",
    ];
    const parsed = parseClaimChecks(
      JSON.stringify({
        claims: [
          { claim: claims[0], verdict: "supported", evidenceIds: ["owned-covered"] },
          { claim: claims[1], verdict: "supported", evidenceIds: ["owned-doc"] },
        ],
      }),
      claims,
      evidence,
    );
    expect(parsed?.map((row) => row.verdict)).toEqual(["supported", "supported"]);
    expect(
      parseClaimChecks(
        JSON.stringify({
          claims: [
            { claim: claims[0], verdict: "supported", evidenceIds: ["owned-covered"] },
            { claim: claims[1], verdict: "unsupported", evidenceIds: ["owned-doc"] },
          ],
        }),
        claims,
        evidence,
      )?.[1]?.verdict,
    ).toBe("unsupported");
  });

  it.each(["unsupported", "contradicted", "uncertain"] as const)(
    "preserves the %s refusal verdict",
    (verdict) => {
      const claim = "The source supports a claim.";
      expect(
        parseClaimChecks(
          JSON.stringify({ claims: [{ claim, verdict, evidenceIds: ["owned-covered"] }] }),
          [claim],
          evidence,
        )?.[0]?.verdict,
      ).toBe(verdict);
    },
  );

  it("fails closed on invented IDs, missing citations, wrong row count, and malformed output", () => {
    const claim = "The source supports a claim.";
    for (const output of [
      JSON.stringify({ claims: [{ claim, verdict: "supported", evidenceIds: ["invented"] }] }),
      JSON.stringify({ claims: [{ claim, verdict: "supported", evidenceIds: [] }] }),
      JSON.stringify({ claims: [] }),
      "not json",
    ])
      expect(parseClaimChecks(output, [claim], evidence)).toBeNull();
  });

  it("splits mixed answers into a bounded list of individual claims", () => {
    expect(factualSentences("Supported fact. Overstated conclusion!\nUnknown claim?")).toEqual([
      "Supported fact.",
      "Overstated conclusion!",
      "Unknown claim?",
    ]);
    expect(factualSentences(" ")).toEqual([]);
  });
});
