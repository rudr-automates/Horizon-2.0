import { describe, expect, it } from "vitest";
import { AiError } from "@/server/ai/errors";
import { dedupeCitations, validateGroundedAnswer } from "@/server/retrieval/citations";
import { EvidenceContractError } from "@/server/retrieval/errors";
import { keywordRetrieve } from "@/server/retrieval/keyword";
import { prepareGroundedRequest, verifyDraftCitations } from "@/server/retrieval/pipeline";
import {
  buildGroundedContext,
  selectEligibleEvidence,
  validateLearnerPosition,
  validateScope,
} from "@/server/retrieval/scope";
import type { EvidenceChunk, EvidenceScope } from "@/server/retrieval/types";

const SCOPE: EvidenceScope = {
  userId: "user-1",
  courseId: "course-1",
  lessonId: "lesson-1",
  lessonOwnerId: "user-1",
  lessonIsDemo: false,
  lessonDurationSeconds: 60,
  positionSeconds: 30,
};

function chunk(id: string, overrides: Partial<Omit<EvidenceChunk, "id">> = {}): EvidenceChunk {
  return {
    id,
    resourceId: `resource-${id}`,
    resourceKind: "video_transcript",
    isDemo: false,
    ownerId: "user-1",
    courseId: "course-1",
    lessonId: "lesson-1",
    status: "ready",
    text: "An embedding represents meaning in a vector space.",
    locator: {
      kind: "video",
      lessonId: "lesson-1",
      startSeconds: 0,
      endSeconds: 20,
    },
    ...overrides,
  };
}

const covered = chunk("covered");
const current = chunk("current", {
  text: "Currently spoken material about embeddings that is not finished yet.",
  locator: { kind: "video", lessonId: "lesson-1", startSeconds: 25, endSeconds: 40 },
});
const future = chunk("future", {
  text: "Future material about reranking and cross-encoders.",
  locator: { kind: "video", lessonId: "lesson-1", startSeconds: 40, endSeconds: 60 },
});
const pdf = chunk("pdf", {
  resourceKind: "pdf",
  text: "Cosine similarity compares the direction of normalised vectors.",
  locator: { kind: "page", pageNumber: 4 },
  provenance: { title: "Vector Search Basics.pdf" },
  availability: "always",
});
const slides = chunk("slides", {
  resourceKind: "slides",
  text: "Slide notes explain cosine similarity and vector direction.",
  locator: { kind: "slide", slideNumber: 2 },
  availability: "always",
});
const foreign = chunk("foreign", {
  ownerId: "user-2",
  text: "Another learner's private embeddings note.",
});
const crossCourse = chunk("cross-course", {
  courseId: "course-2",
  text: "A private embeddings note in another course.",
});
const otherLessonVideo = chunk("other-lesson", {
  lessonId: "lesson-2",
  text: "Embeddings explained in a different lesson.",
  locator: { kind: "video", lessonId: "lesson-2", startSeconds: 0, endSeconds: 20 },
});
const demoPdf = chunk("demo-pdf", {
  isDemo: true,
  ownerId: null,
  resourceKind: "pdf",
  text: "The public sample PDF explains embeddings and cosine similarity.",
  locator: { kind: "page", pageNumber: 1 },
  availability: "always",
});
const failed = chunk("failed", { status: "failed", text: "Embeddings that failed processing." });
const overrun = chunk("overrun", {
  text: "Embeddings in an invalid time range.",
  locator: { kind: "video", lessonId: "lesson-1", startSeconds: 50, endSeconds: 61 },
});

const ALL = [
  covered,
  current,
  future,
  pdf,
  slides,
  foreign,
  crossCourse,
  otherLessonVideo,
  demoPdf,
  failed,
  overrun,
];

function failureCode(action: () => unknown): string {
  try {
    action();
    return "none";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "unknown";
  }
}

describe("evidence scope and timestamp eligibility", () => {
  it("includes covered video and permitted documents but never future or current speech", () => {
    const ids = selectEligibleEvidence(SCOPE, ALL).map((item) => item.id);
    expect(ids).toContain("covered");
    expect(ids).toContain("pdf");
    expect(ids).toContain("slides");
    expect(ids).toContain("demo-pdf");
    expect(ids).not.toContain("current");
    expect(ids).not.toContain("future");
    expect(ids).not.toContain("foreign");
    expect(ids).not.toContain("cross-course");
    expect(ids).not.toContain("other-lesson");
    expect(ids).not.toContain("failed");
    expect(ids).not.toContain("overrun");
  });

  it("allows a permitted PDF or slide even before the video has started", () => {
    const early = { ...SCOPE, positionSeconds: 0 };
    const ids = selectEligibleEvidence(early, ALL).map((item) => item.id);
    expect(ids).toContain("pdf");
    expect(ids).toContain("slides");
    expect(ids).not.toContain("covered");
  });

  it("rejects invalid positions, unknown durations and forged private scopes", () => {
    expect(failureCode(() => validateLearnerPosition(Number.NaN, 60))).toBe("invalid_position");
    expect(failureCode(() => validateLearnerPosition(-1, 60))).toBe("position_out_of_range");
    expect(failureCode(() => validateLearnerPosition(61, 60))).toBe("position_out_of_range");
    expect(failureCode(() => validateLearnerPosition(0, 0))).toBe("lesson_duration_unknown");
    expect(failureCode(() => validateScope({ ...SCOPE, lessonOwnerId: "user-2" }))).toBe(
      "unauthorized_scope",
    );
    expect(
      failureCode(() => validateScope({ ...SCOPE, lessonIsDemo: true, lessonOwnerId: "user-1" })),
    ).toBe("invalid_scope");
    expect(validateLearnerPosition(60, 60)).toBe(60);
  });

  it("requires explicit policy for document evidence and gates timeline ranges by their end", () => {
    const glossary = chunk("glossary", {
      resourceKind: "pdf",
      locator: { kind: "page", pageNumber: 1 },
      availability: "always",
    });
    const laterPdf = chunk("later-pdf", {
      resourceKind: "pdf",
      locator: { kind: "page", pageNumber: 9 },
      availability: "timeline",
      alignmentStartSeconds: 1_000,
      alignmentEndSeconds: 1_200,
    });
    const laterSlide = chunk("later-slide", {
      resourceKind: "slides",
      locator: { kind: "slide", slideNumber: 8 },
      availability: "timeline",
      alignmentStartSeconds: 1_000,
      alignmentEndSeconds: 1_200,
    });
    const unknown = chunk("unknown-doc", {
      resourceKind: "pdf",
      locator: { kind: "page", pageNumber: 3 },
    });
    expect(
      selectEligibleEvidence(SCOPE, [glossary, laterPdf, laterSlide, unknown]).map(
        (item) => item.id,
      ),
    ).toEqual(["glossary"]);
    expect(
      selectEligibleEvidence({ ...SCOPE, lessonDurationSeconds: 1_300, positionSeconds: 1_200 }, [
        laterPdf,
        laterSlide,
      ]).map((item) => item.id),
    ).toEqual(["later-pdf", "later-slide"]);
    expect(
      selectEligibleEvidence({ ...SCOPE, allowUnknownReferences: true }, [unknown]).map(
        (item) => item.id,
      ),
    ).toEqual(["unknown-doc"]);
  });

  it("rejects malformed alignment and alignment assigned to another lesson", () => {
    const invalid = chunk("bad-range", {
      resourceKind: "pdf",
      locator: { kind: "page", pageNumber: 2 },
      availability: "timeline",
      alignmentStartSeconds: 50,
      alignmentEndSeconds: 61,
    });
    const crossLesson = chunk("other-doc", {
      lessonId: "lesson-2",
      resourceKind: "pdf",
      locator: { kind: "page", pageNumber: 2 },
      availability: "timeline",
      alignmentStartSeconds: 1,
      alignmentEndSeconds: 20,
    });
    expect(selectEligibleEvidence(SCOPE, [invalid, crossLesson])).toEqual([]);
  });
});

describe("grounded evidence preparation", () => {
  it("returns only eligible evidence for a question covered by the lesson", () => {
    const result = prepareGroundedRequest(SCOPE, "embedding vector meaning", ALL);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const ids = result.context.evidence.map((item) => item.id);
    expect(ids).toContain("covered");
    expect(ids).not.toContain("current");
    expect(ids).not.toContain("future");
    expect(result.context.retrieval).toBe("keyword");
  });

  it("uses a permitted document to answer a question not covered by the transcript yet", () => {
    const result = prepareGroundedRequest(
      { ...SCOPE, positionSeconds: 0 },
      "cosine similarity direction",
      ALL,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.context.evidence.some((item) => item.id === "pdf")).toBe(true);
  });

  it("reports insufficient evidence for future-only material", () => {
    const result = prepareGroundedRequest(SCOPE, "reranking cross-encoders", ALL);
    expect(result).toEqual({
      status: "insufficient_evidence",
      reason: "no_matching_evidence",
      eligibleCount: expect.any(Number),
    });
    const early = prepareGroundedRequest({ ...SCOPE, positionSeconds: 0 }, "embedding", [
      covered,
      future,
    ]);
    expect(early).toEqual({
      status: "insufficient_evidence",
      reason: "no_eligible_evidence",
      eligibleCount: 0,
    });
  });

  it("reports insufficient evidence for a question absent from all resources", () => {
    const result = prepareGroundedRequest(SCOPE, "photosynthesis chlorophyll", ALL);
    expect(result.status).toBe("insufficient_evidence");
    if (result.status !== "insufficient_evidence") return;
    expect(result.reason).toBe("no_matching_evidence");
  });

  it("never retrieves another learner's or another course's evidence", () => {
    const result = prepareGroundedRequest(
      { ...SCOPE, userId: "user-3", lessonOwnerId: "user-3" },
      "embeddings note",
      [foreign, crossCourse],
    );
    expect(result).toEqual({
      status: "insufficient_evidence",
      reason: "no_eligible_evidence",
      eligibleCount: 0,
    });
  });

  it("omits a chunk that does not fit the context budget instead of truncating it", () => {
    const first = chunk("long-a", {
      text: "A".repeat(60),
      locator: { kind: "page", pageNumber: 1 },
      resourceKind: "pdf",
      availability: "always",
    });
    const second = chunk("long-b", {
      text: "B".repeat(60),
      locator: { kind: "page", pageNumber: 2 },
      resourceKind: "pdf",
      availability: "always",
    });

    const context = buildGroundedContext(SCOPE, [first, second], {
      maxTotalChars: 70,
      maxChunks: 8,
    });

    expect(context.evidence).toHaveLength(1);
    expect(context.evidence[0]?.id).toBe("long-a");
    expect(context.evidence[0]?.text).toHaveLength(60);
    expect(context.evidence[0]).not.toHaveProperty("ownerId");
  });
});

describe("keyword retrieval", () => {
  it("ranks matching evidence deterministically and returns no fabricated matches", () => {
    const first = keywordRetrieve("cosine similarity", [covered, pdf, slides]);
    const second = keywordRetrieve("cosine similarity", [covered, pdf, slides]);

    expect(first.map((match) => match.chunk.id)).toEqual(second.map((match) => match.chunk.id));
    expect(first.map((match) => match.chunk.id).sort()).toEqual(["pdf", "slides"]);
    expect(first.every((match) => match.score > 0)).toBe(true);
    expect(keywordRetrieve("photosynthesis", [covered, pdf])).toEqual([]);
    expect(keywordRetrieve("the and of", [covered])).toEqual([]);
  });
});

describe("citation verification", () => {
  const eligible = selectEligibleEvidence(SCOPE, ALL);

  it("accepts a citation whose id is eligible and whose quote appears in the source", () => {
    const result = validateGroundedAnswer(
      {
        text: "Embeddings map meaning into a vector space.",
        citations: [{ evidenceId: "covered", quote: "An embedding represents meaning" }],
      },
      { eligible },
    );

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.verified).toHaveLength(1);
  });

  it("rejects an answer with no citations", () => {
    const result = validateGroundedAnswer({ text: "An answer.", citations: [] }, { eligible });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("missing_citation");
  });

  it("rejects unknown, ineligible, duplicate and malformed citations", () => {
    const unknown = validateGroundedAnswer(
      { text: "An answer.", citations: [{ evidenceId: "made-up" }] },
      { eligible, retrieved: ALL },
    );
    expect(unknown.issues[0]?.code).toBe("unknown_citation");

    const ineligible = validateGroundedAnswer(
      { text: "A future claim.", citations: [{ evidenceId: "future" }] },
      { eligible, retrieved: ALL },
    );
    expect(ineligible.issues[0]?.code).toBe("ineligible_citation");

    const duplicate = validateGroundedAnswer(
      {
        text: "An answer.",
        citations: [{ evidenceId: "covered" }, { evidenceId: "covered" }],
      },
      { eligible },
    );
    expect(duplicate.issues.some((issue) => issue.code === "duplicate_citation")).toBe(true);

    const malformed = validateGroundedAnswer(
      { text: "An answer.", citations: [{ evidenceId: "  " }] },
      { eligible },
    );
    expect(malformed.issues[0]?.code).toBe("invalid_citation");
  });

  it("removes repeated citations before validation without weakening the checks", () => {
    const repeated = [
      { evidenceId: "covered", quote: "An embedding represents meaning" },
      { evidenceId: "covered", quote: "An embedding represents meaning" },
    ];
    const deduped = dedupeCitations(repeated);
    expect(deduped).toHaveLength(1);
    expect(
      validateGroundedAnswer({ text: "An answer.", citations: deduped }, { eligible }).ok,
    ).toBe(true);

    // A duplicate of an ineligible source is still ineligible after de-duplication.
    const mixed = dedupeCitations([{ evidenceId: "future" }, { evidenceId: "future" }]);
    expect(mixed).toHaveLength(1);
    expect(
      validateGroundedAnswer({ text: "An answer.", citations: mixed }, { eligible, retrieved: ALL })
        .ok,
    ).toBe(false);
  });

  it("rejects a quote that does not appear in the cited evidence", () => {
    const result = validateGroundedAnswer(
      {
        text: "A fabricated quotation.",
        citations: [{ evidenceId: "covered", quote: "Embeddings guarantee correctness." }],
      },
      { eligible },
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("quote_mismatch");
  });

  it("re-checks citations against the learner's scope after generation", () => {
    const futureClaim = verifyDraftCitations(
      { text: "Cross-encoders rerank.", citations: [{ evidenceId: "future" }] },
      SCOPE,
      ALL,
    );
    expect(futureClaim.ok).toBe(false);
    expect(futureClaim.issues[0]?.code).toBe("ineligible_citation");

    const valid = verifyDraftCitations(
      { text: "Embeddings are vectors.", citations: [{ evidenceId: "covered" }] },
      SCOPE,
      ALL,
    );
    expect(valid.ok).toBe(true);
  });

  it("keeps evidence-quality failures distinct from provider failures", () => {
    expect(new EvidenceContractError("insufficient_evidence", "none")).not.toBeInstanceOf(AiError);
  });
});
