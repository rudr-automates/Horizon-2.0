import { describe, expect, it } from "vitest";
import { expandConceptLinks, expandContextGraph } from "@/server/retrieval/graph";
import { selectEligibleEvidence } from "@/server/retrieval/scope";
import type { EvidenceChunk, RetrievalMatch } from "@/server/retrieval/types";

function chunk(id: string, start: number, end: number): EvidenceChunk {
  return {
    id,
    resourceId: "lesson",
    resourceKind: "video_transcript",
    isDemo: true,
    ownerId: null,
    courseId: "course",
    lessonId: "lesson",
    status: "ready",
    text: id,
    locator: { kind: "video", lessonId: "lesson", startSeconds: start, endSeconds: end },
  };
}

describe("context graph expansion", () => {
  const a = chunk("a", 0, 10);
  const b = chunk("b", 12, 22);
  const c = chunk("c", 24, 34);
  const d = chunk("d", 80, 90);

  it("adds immediate eligible neighbours without duplicates", () => {
    const matches: RetrievalMatch[] = [{ chunk: c, score: 1 }];
    const expanded = expandContextGraph(matches, [a, b, c, d], { maxExtra: 2 });
    // d is 46 seconds away, so it is outside the default neighbour distance.
    expect(expanded.map((match) => match.chunk.id)).toEqual(["c", "b"]);
  });

  it("respects the expansion budget and distance cap", () => {
    const matches: RetrievalMatch[] = [{ chunk: c, score: 1 }];
    expect(
      expandContextGraph(matches, [a, b, c, d], { maxExtra: 1 }).map((match) => match.chunk.id),
    ).toEqual(["c", "b"]);
    expect(
      expandContextGraph(matches, [a, b, c, d], { maxExtra: 2, maxGapSeconds: 2 }).map(
        (match) => match.chunk.id,
      ),
    ).toEqual(["c", "b"]);
  });

  it("does not add a neighbour that is not in the eligible set", () => {
    const matches: RetrievalMatch[] = [{ chunk: b, score: 1 }];
    expect(
      expandContextGraph(matches, [b, c], { maxExtra: 2 }).map((match) => match.chunk.id),
    ).toEqual(["b", "c"]);
  });
});

function spoken(
  id: string,
  start: number,
  end: number,
  text: string,
  overrides: Partial<EvidenceChunk> = {},
): EvidenceChunk {
  const { courseId: _courseId, ...base } = chunk(id, start, end);
  return { ...base, text, isDemo: false, ownerId: "learner-1", ...overrides };
}

function document(id: string, text: string, overrides: Partial<EvidenceChunk> = {}): EvidenceChunk {
  return {
    id,
    resourceId: `resource-${id}`,
    resourceKind: "pdf",
    isDemo: false,
    ownerId: "learner-1",
    lessonId: "lesson",
    status: "ready",
    text,
    locator: { kind: "page", pageNumber: 3 },
    ...overrides,
  };
}

describe("concept graph expansion", () => {
  const anchor = spoken(
    "v-anchor",
    0,
    10,
    "Expanding intervals and retrieval practice protect memory when you review the same card again.",
  );
  const related = document(
    "p-related",
    "Retrieval practice with expanding intervals: a review schedule that protects memory across weeks.",
  );
  const unrelated = document(
    "p-unrelated",
    "Photosynthesis converts sunlight into chemical energy inside every green leaf of the plant.",
  );

  it("links a retrieved passage to the document discussing the same concepts", () => {
    const matches: RetrievalMatch[] = [{ chunk: anchor, score: 1 }];
    const expanded = expandConceptLinks(matches, [anchor, related, unrelated], {
      maxExtra: 2,
      minSharedTerms: 3,
    });
    expect(expanded.map((match) => match.chunk.id)).toEqual(["v-anchor", "p-related"]);
  });

  it("ignores documents that share too few concepts and respects the budget", () => {
    const matches: RetrievalMatch[] = [{ chunk: anchor, score: 1 }];
    expect(
      expandConceptLinks(matches, [anchor, unrelated], { maxExtra: 2, minSharedTerms: 3 }).map(
        (match) => match.chunk.id,
      ),
    ).toEqual(["v-anchor"]);
    expect(
      expandConceptLinks(matches, [anchor, related, unrelated], {
        maxExtra: 1,
        minSharedTerms: 3,
      }),
    ).toHaveLength(2);
  });

  it("never links evidence that failed scope or timestamp eligibility", () => {
    const scope = {
      userId: "learner-1",
      lessonId: "lesson",
      lessonOwnerId: "learner-1",
      lessonIsDemo: false,
      lessonDurationSeconds: 30,
      positionSeconds: 10,
    };
    const covered = spoken(
      "v-covered",
      0,
      10,
      "Expanding intervals and retrieval practice protect memory when you review the same card again.",
    );
    const future = spoken(
      "v-future",
      40,
      50,
      "Expanding intervals and retrieval practice protect memory when you review the same card again.",
    );
    const foreign = spoken("v-foreign", 4, 9, "private material of another learner", {
      ownerId: "learner-2",
    });

    const eligible = selectEligibleEvidence(scope, [covered, future, foreign]);
    expect(eligible.map((item) => item.id)).toEqual(["v-covered"]);

    const seed: RetrievalMatch[] = [{ chunk: covered, score: 1 }];
    const sequenceIds = expandContextGraph(seed, eligible, { maxExtra: 3 }).map(
      (match) => match.chunk.id,
    );
    const conceptIds = expandConceptLinks(seed, eligible, {
      maxExtra: 3,
      minSharedTerms: 1,
    }).map((match) => match.chunk.id);
    // Neither edge type may add anything beyond the eligible passage itself.
    expect(sequenceIds).toEqual(["v-covered"]);
    expect(conceptIds).toEqual(["v-covered"]);
    expect([...sequenceIds, ...conceptIds]).not.toContain("v-future");
    expect([...sequenceIds, ...conceptIds]).not.toContain("v-foreign");
  });
});
