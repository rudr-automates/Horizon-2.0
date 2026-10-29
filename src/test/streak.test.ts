import { describe, expect, it } from "vitest";
import { computeStreak, remainingSeconds } from "@/lib/streak";

const d = (s: string) => new Date(s);

describe("streak", () => {
  it("counts consecutive days ending today", () => {
    expect(
      computeStreak(
        [d("2026-10-19T10:00Z"), d("2026-10-20T10:00Z"), d("2026-10-21T10:00Z")],
        d("2026-10-21T18:00Z"),
        "UTC",
      ),
    ).toBe(3);
  });
  it("keeps a streak alive if today has no activity yet", () => {
    expect(computeStreak([d("2026-10-20T10:00Z")], d("2026-10-21T08:00Z"), "UTC")).toBe(1);
  });
  it("breaks on a missed day", () => {
    expect(computeStreak([d("2026-10-18T10:00Z")], d("2026-10-21T08:00Z"), "UTC")).toBe(0);
  });
  it("uses the learner's timezone", () => {
    // 20:00 UTC on the 20th is already the 21st in Calcutta
    expect(computeStreak([d("2026-10-20T20:00Z")], d("2026-10-21T10:00Z"), "Asia/Kolkata")).toBe(1);
    expect(computeStreak([d("2026-10-20T20:00Z")], d("2026-10-22T10:00Z"), "Asia/Kolkata")).toBe(1);
  });
});

describe("timer", () => {
  it("uses the end timestamp, not ticks", () => {
    expect(remainingSeconds(25 * 60_000, 10 * 60_000)).toBe(900);
    expect(remainingSeconds(1000, 5000)).toBe(0);
  });
});
