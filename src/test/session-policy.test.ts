import { describe, expect, it } from "vitest";
import { queryCacheAction } from "@/lib/session-policy";

describe("query cache isolation policy", () => {
  it("does not churn caches on the initial session event", () => {
    expect(queryCacheAction("INITIAL_SESSION", null, "user-a")).toBe("none");
  });

  it("clears every private record on sign-out", () => {
    expect(queryCacheAction("SIGNED_OUT", "user-a", null)).toBe("clear");
  });

  it("clears when a different account signs in without a full reload", () => {
    expect(queryCacheAction("SIGNED_IN", "user-a", "user-b")).toBe("clear");
  });

  it("clears when a session disappears without a SIGNED_OUT event", () => {
    expect(queryCacheAction("TOKEN_REFRESHED", "user-a", null)).toBe("clear");
  });

  it("invalidates, but does not clear, when the same user signs in again", () => {
    expect(queryCacheAction("SIGNED_IN", "user-a", "user-a")).toBe("invalidate");
  });

  it("leaves cache alone for a token refresh of the same user", () => {
    expect(queryCacheAction("TOKEN_REFRESHED", "user-a", "user-a")).toBe("none");
  });
});
