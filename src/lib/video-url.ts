import { supabase } from "@/integrations/supabase/client";

/** A lesson that points at private storage instead of a public video host. */
const STORAGE_SCHEME = "storage://";

export function isStoredVideoUrl(url: string): boolean {
  return url.startsWith(STORAGE_SCHEME);
}

function parseStoredUrl(url: string): { bucket: string; path: string } {
  const rest = url.slice(STORAGE_SCHEME.length);
  const slash = rest.indexOf("/");
  if (slash < 1 || slash === rest.length - 1) {
    throw new Error("This stored video reference is invalid.");
  }
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/**
 * Turns a `storage://bucket/path` reference into a short-lived signed URL. The
 * bucket is private, so only the owner's session can sign a readable link; the
 * URL expires after an hour and is re-resolved the next time the lesson opens.
 */
export async function resolveVideoUrl(url: string): Promise<string> {
  if (!isStoredVideoUrl(url)) return url;
  const { bucket, path } = parseStoredUrl(url);
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3_600);
  if (error || !data?.signedUrl) {
    throw new Error("This private video could not be opened.");
  }
  return data.signedUrl;
}
