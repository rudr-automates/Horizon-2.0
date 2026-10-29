/**
 * Cache policy for Supabase auth transitions.
 *
 * Private learner records are keyed by TanStack Query, not by user id, so a
 * cache must never survive a sign-out or an account switch. This helper keeps
 * the rule testable and out of the React effect.
 */
export type AuthEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED"
  | "PASSWORD_RECOVERY"
  | (string & {});

export type QueryCacheAction = "none" | "invalidate" | "clear";

export function queryCacheAction(
  event: AuthEvent,
  previousUserId: string | null,
  nextUserId: string | null,
): QueryCacheAction {
  if (event === "INITIAL_SESSION") return "none";
  if (event === "SIGNED_OUT") return "clear";
  // A session can also disappear without a SIGNED_OUT event (expired refresh,
  // revoked session). Treat any identity change as a full reset.
  if (previousUserId !== nextUserId) return "clear";
  if (event === "SIGNED_IN" || event === "USER_UPDATED") return "invalidate";
  return "none";
}
