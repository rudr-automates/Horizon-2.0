import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * Server helpers for the two-step upload used by lesson resources and videos.
 *
 * Vercel Functions reject request bodies above 4.5 MB, while the product allows
 * 10 MB documents and 200 MB videos. A browser therefore never posts file bytes
 * to a route handler: it asks the server for a signed upload URL scoped to its
 * own storage folder, uploads straight to Supabase Storage, and then asks the
 * server to verify and index the object. Every step re-checks ownership, so a
 * signed path from one learner is useless to another.
 */

export interface SignedUpload {
  bucket: string;
  path: string;
  token: string;
}

export type SignedUploadResult =
  { ok: true; upload: SignedUpload } | { ok: false; message: string };

/** Creates a single-use upload grant for exactly one object path. */
export async function createSignedUpload(
  supabase: SupabaseClient<Database>,
  bucket: string,
  path: string,
): Promise<SignedUploadResult> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data?.token) {
    return {
      ok: false,
      message:
        "The private file store did not authorise this upload. Check that the storage migration is applied and try again.",
    };
  }
  return { ok: true, upload: { bucket, path, token: data.token } };
}

/** Object paths are always "<auth.uid()>/<name>"; anything else is rejected. */
export function isOwnedPath(userId: string, path: string): boolean {
  if (!userId) return false;
  if (!path.startsWith(`${userId}/`)) return false;
  if (path.includes("..") || path.includes("\\") || path.length > 512) return false;
  return !path.endsWith("/");
}

export async function removeObject(
  supabase: SupabaseClient<Database>,
  bucket: string,
  path: string,
): Promise<void> {
  await supabase.storage
    .from(bucket)
    .remove([path])
    .catch(() => null);
}

export interface ObjectInspection {
  /** Total object size in bytes, as reported by storage rather than the browser. */
  size: number;
  contentType: string;
  /** First bytes of the object, used for container-signature checks. */
  head: Uint8Array;
}

/**
 * Reads the object's real size and first bytes without downloading it whole.
 * A 200 MB video is inspected with a single ranged GET, which keeps the check
 * inside the function's memory and time budget.
 */
export async function inspectObject(
  supabase: SupabaseClient<Database>,
  bucket: string,
  path: string,
  headBytes = 32,
): Promise<ObjectInspection | null> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return null;
  const response = await fetch(data.signedUrl, {
    headers: { Range: `bytes=0-${headBytes - 1}` },
  });
  if (!response.ok) return null;
  if (response.status !== 206) {
    // Storage did not honour the range, so the body could be the whole object.
    await response.body?.cancel();
    return null;
  }
  const total = Number(response.headers.get("content-range")?.split("/")[1] ?? "0");
  const head = new Uint8Array(await response.arrayBuffer());
  if (!Number.isFinite(total) || total <= 0 || head.byteLength === 0) return null;
  return {
    size: total,
    contentType: response.headers.get("content-type") ?? "",
    head,
  };
}

/** JSON body reader that never throws on malformed input. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Removes directory components and control characters from a client filename. */
export function safeFilename(value: unknown): string {
  if (typeof value !== "string") return "";
  const withoutSeparators = value.replace(/[\\/]/g, "_");
  // Control characters are dropped by code point; a literal regex range for
  // them trips the no-control-regex rule without adding any clarity.
  const printable = Array.from(withoutSeparators)
    .filter((character) => character.charCodeAt(0) > 31)
    .join("");
  return printable.trim().slice(-200);
}

export function extensionOf(filename: string): string {
  return filename.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
}
