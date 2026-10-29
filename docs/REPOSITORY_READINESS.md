# Repository readiness — Phase 1 audit

> Historical audit. The application, schema, provider integrations and test
> results have moved on; use the [Phase 2 report](HORIZON_2_PHASE_2_REPORT.md)
> for current status. Statements below describe the pre-implementation baseline.

Date: 2026-10-25
Scope: codebase readiness for multi-provider AI, embeddings, ingestion and
evidence-grounded answering. No external AI provider was connected.

This document separates **observed facts** from **assumptions** and from
**planned work**. Baseline results are the state before any Phase 1 edit; current
results are after the changes described at the end.

## 1. Repository and Git state

**Observed:** The workspace is
`D:\Asmi\Hackathon\AHGV NSUT Hackathon\warm-page-learning-studio-main`. There is no
`.git` directory. `git status` and `git log` fail with
`fatal: not a git repository`.

Consequences:

- Branch, latest commit, remotes and uncommitted changes could not be verified.
- Environment-file tracking in Git could not be inspected or changed. The
  provided GitHub repository URL was not cloned or pushed to.
- All Phase 1 work is in the working tree only. No commit, push, deployment,
  production secret change or database migration was performed.

**Assumption (not verified):** a previous inspection reported a tracked root
`.env` in the remote repository. This workspace copy has `.env`, and the original
`.gitignore` did not ignore `.env`. If the remote contains that file, a human with
the clone must run `git rm --cached .env` after pulling this `.gitignore` change.
The file must remain on disk locally.

## 2. Architecture observed

- TanStack Start 1.168 with file-based routing, React 19, TypeScript 5.8,
  Tailwind CSS 4, TanStack Query 5, Supabase JS 2.118 and Vitest 4.
- SSR entry is `src/server.ts`, wrapping the TanStack server entry with an error
  page. `vite.config.ts` delegates to the Lovable TanStack config, which targets
  Nitro/Cloudflare on build.
- Signed-in routes live under `src/routes/_authenticated`. That layout has
  `ssr: false` and a `beforeLoad` gate using `supabase.auth.getUser()`.
- There are no application server functions, API routes, upload endpoints or
  service-role calls. All current learner CRUD goes from the browser Supabase
  client through RLS.
- Learning state: `courses`, `lessons` (demo and user-imported), `lesson_progress`,
  `lesson_notes`, `lesson_bookmarks`. Personal workspace state: `profiles`,
  `tasks`, `events`, `focus_sessions`.
- Demo media and downloadable resources are Lovable-hosted
  `/__l5e/assets-v1/…` URLs plus copies under `public/sample`. The transcript in
  `lessons.transcript` is the only structured educational text currently in the
  database.
- `src/integrations/supabase/client.server.ts` can create a service-role client
  but nothing imports it.

## 3. Verified working features (code-level and checks)

- Public landing, sign-in, sign-up, forgot/reset password routes exist and
  type-check/build. Sign-up has client-side password validation; auth errors are
  surfaced via toast.
- Course catalogue, course outline, library, lesson player, synced transcript,
  notes/bookmarks, progress checkpoints and explicit completion are implemented.
- Imported YouTube/Vimeo/HTTPS MP4/WebM lessons are validated by
  `parseVideoUrl` (HTTPS only, known hosts or direct media, no local addresses).
  Captions are parsed from supplied SRT/VTT; no scraping or transcription.
- Streak, focus timer, tasks and calendar flows are implemented against Supabase.
- Pure rules have tests: transcript timing, watched-time accounting, completion,
  caption parsing, URL validation, streak/timezone and timer boundaries, route
  matching, plus Phase 1 gateway/embedding/evidence tests.
- Production build succeeds. The Phase 1 server modules are not imported by any
  client route; a built-client grep for `GEMINI_API_KEY`, `mock-embed`,
  `AI_MODEL_PREFERENCES` and `SUPABASE_SERVICE_ROLE` found no matches.
- Unauthenticated HTTP smoke test on the dev server: `/` and `/sign-in` returned
  200, and `/dashboard` redirected client-side to
  `/sign-in?redirect=%2Fdashboard` with no console errors. This confirms the
  existing shell and client-only auth gate still mount; it does not verify a
  signed-in session.

**Not verified:** signed-in end-to-end behaviour against a real Supabase project,
RLS behaviour with two live accounts, imported-provider playback, media
availability, and email delivery. These require credentials/accounts and were not
exercised.

## 4. Incomplete or misleading features

- The application does **not** have an AI tutor, embedding generation, document
  ingestion, semantic/hybrid retrieval or grounded answering. The lesson UI says
  "AI tutor: Phase 3 · External LLM connection not configured"; that is honest.
- The landing page describes PDFs, slides, notes and code as connected sources,
  timestamp/page citations and ContextGraph linking. Only demo video transcripts
  and downloadable static resources exist; the landing citation card is a
  labelled demonstration, not generated output. These are marketing/planned
  capabilities, not working features.
- The sample PDF/PPTX/Markdown/Python files are downloads, not indexed evidence.
  Transcript availability is not AI readiness.
- `docs/LEARNING_STUDIO.md` reported "14 tests"; that is now stale. It also
  correctly labels external AI as deferred.
- Imported lessons can have `duration_seconds = 0` until video metadata loads.
  They cannot support position-aware answers until a real duration is stored.
- Notes/bookmarks enforce `timestamp_seconds >= 0` but no upper bound against the
  lesson duration. This is an integrity gap, not a cross-user leak.
- `tasks`, `events` and `focus_sessions` have no explicit `user_id` indexes;
  RLS ownership queries will scan as data grows. Acceptable for a prototype, not
  for production scale.

## 5. Security and data-integrity audit

### RLS coverage observed in migrations

| Table                    | RLS                     | Ownership/visibility                                                                                    |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `profiles`               | Yes                     | `auth.uid() = id` for select/insert/update.                                                             |
| `tasks`                  | Yes                     | All operations require `auth.uid() = user_id`.                                                          |
| `events`                 | Yes                     | All operations require `auth.uid() = user_id`.                                                          |
| `focus_sessions`         | Yes                     | All operations require `auth.uid() = user_id`; FK to task did not check task ownership.                 |
| `courses`                | Yes                     | Read demo courses; writes only via service role.                                                        |
| `lessons`                | Yes                     | Demo lessons readable by anon/authenticated; private lessons are owned and non-demo for all operations. |
| `lesson_progress`        | Yes                     | Owner plus an accessible demo/owned lesson, on both `USING` and `WITH CHECK`.                           |
| `lesson_notes`           | Yes                     | Same owner + accessible lesson rule.                                                                    |
| `lesson_bookmarks`       | Yes                     | Same owner + accessible lesson rule.                                                                    |
| New `learning_resources` | Yes (migration written) | Demo readable; owner-only private reads/writes.                                                         |
| New `resource_chunks`    | Yes (migration written) | Inherits parent resource visibility/ownership via `EXISTS`.                                             |

Additional observed protections:

- `handle_new_user` had direct execute revoked from `public`, `anon` and
  `authenticated`.
- Constraints exist for note body (1–10,000), bookmark label (1–200), non-negative
  progress/watch/time values, lesson duration and provider/transcript-status
  enums, plus unique `(user_id, lesson_id)` progress.
- Indexes exist for lesson course/position, lesson owner, notes owner/lesson and
  bookmarks owner/lesson.
- The browser uses only the Supabase publishable key. No service-role credential
  was found in `.env` (see below).

### Findings

1. **Environment tracking (high, repository hygiene).** The original `.gitignore`
   did not ignore `.env` or `.env.*`. The observed `.env` contains only six
   variables: URL, project id and publishable key, each duplicated with a `VITE_`
   prefix. The key begins `sb_publishable_`, which is browser-safe; there is no
   service-role or secret key. Phase 1 added `.env`, `.env.*`,
   `!.env.example`, `.dev.vars*` to `.gitignore` and added a value-free
   `.env.example`. Because there is no `.git`, tracking could not be removed.
   No rotation is indicated by the observed values, but remote history was not
   inspected; if a service-role key ever existed there, rotate it.
2. **Client-only auth gate.** Existing learner operations rely on RLS rather than
   a server gate. That is acceptable for direct Supabase CRUD, but any future AI
   endpoint must verify the user server-side and load lesson ownership/duration
   server-side. A client-supplied `user_id`, `lesson_id`, timestamp or evidence
   scope must never be trusted.
3. **Cross-user focus task reference (fixed in migration).** `focus_sessions`
   allowed a learner to reference another learner's task UUID via the FK. Phase 1
   adds a trigger that rejects a task not owned by the same learner. Written, not
   applied.
4. **Timestamp upper bounds.** Notes/bookmarks can carry timestamps beyond the
   lesson. Retrieval must not treat learner notes as video evidence without its
   own scope rules. No destructive constraint was added because imported lesson
   durations may legitimately be 0 until metadata arrives.
5. **Query-cache isolation (fixed).** The dashboard cleared the cache on its own
   sign-out, but an account switch or expired session elsewhere could retain
   private data. The root auth listener now clears the query cache on sign-out and
   any identity change, and tests encode that policy. RLS remains the final
   boundary, but stale UI state is no longer accepted.
6. **Service-role client.** `client.server.ts` is generated and unused. Keep it
   server-only; never import it from a route or component, and never add
   `SUPABASE_SERVICE_ROLE_KEY` to a `VITE_` variable.
7. **No server endpoints means no server rate limiting.** The AI gateway has
   in-process quotas, but no endpoint is wired to it. Do not expose it before
   authentication, input validation and a deployment-aware quota decision exist.

### Assumptions not verified

- The live Supabase project's policies match the migration files. No remote
  schema inspection or two-account RLS test was performed.
- The production/hosted environment has no additional privileged credentials in
  client-visible configuration. Only this workspace's `.env` and build output
  were inspected.
- Media URLs are reachable and licensed for the deployment.

## 6. Test coverage

Baseline: 3 files, 14 tests — learning timing/captions/URL rules, streak/timer,
and `/` route matching. No authentication, RLS, cache isolation, AI, embedding,
retrieval or citation tests.

Phase 1 current: 8 files, 80 tests.

| Area                                                          | Tests |
| ------------------------------------------------------------- | ----- |
| Existing learning/streak/routing                              | 14    |
| Session/query-cache isolation                                 | 6     |
| Gateway selection, fallback, retries, quota, timeout, logging | 21    |
| Quota windows, app guards, concurrency                        | 10    |
| Embedding validation, spaces, mock vectors, retrieval mode    | 13    |
| Evidence scope, timestamps, retrieval, citations              | 16    |

Gaps: no live RLS integration test, no browser E2E, no migration execution test,
no real provider contract test (deliberate: no keys). Pure evidence authorization
tests do not replace a two-account Supabase check.

## 7. Baseline versus current checks

Commands were run from the repository root with npm; Bun is not installed.
`package-lock.json` and `bun.lock` both exist.

| Check              | Baseline                                                                                                                    | Current                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`     | **Fail**: 1003 problems (995 errors, 8 warnings), all `prettier/prettier`; 994 auto-fixable. No non-Prettier rule failures. | Still fails repo-wide: 1002 problems (994 errors, 8 warnings), all `prettier/prettier`. All new/modified Phase 1 files pass ESLint. |
| `npx tsc --noEmit` | Pass (exit 0).                                                                                                              | Pass (exit 0).                                                                                                                      |
| `npm test`         | Pass: 3 files, 14 tests.                                                                                                    | Pass: 8 files, 80 tests.                                                                                                            |
| `npm run build`    | Pass; Nitro/Cloudflare output generated.                                                                                    | Pass; client bundle leak grep found no Phase 1 credential names.                                                                    |

The repo-wide lint failure predates Phase 1 and is formatting-only. A global
`npm run format` would touch almost every source file; it was left as a separate,
reviewable cleanup rather than mixed into this change.

## 8. External dependencies and portability

- Supabase is the only data/auth provider; no local database or CLI was used.
- Demo media is tied to Lovable-hosted `/__l5e/assets-v1/` paths. Independent
  hosting requires rehosting files and updating `lessons.video_url`. `public/sample`
  contains copies but the database points at Lovable.
- Google Fonts are loaded at runtime.
- Imported videos depend on YouTube/Vimeo/direct-host availability and embed
  permissions.
- Two lockfiles coexist (`bun.lock`, `package-lock.json`). Choose one package
  manager and verify the chosen lockfile before release.
- No CI configuration was observed; all checks are manual.

## 9. Prioritized remediation plan

### P0 — before any AI endpoint or deployment

1. Reconcile Git history: remove the root `.env` from tracking if present, confirm
   no historical privileged key, and never commit the local `.env`.
2. Apply the two Phase 1 migrations on staging and regenerate Supabase types.
3. Implement the future AI/retrieval route as an authenticated TanStack server
   function. Load lesson ownership and duration from the database; accept only a
   position from the client; validate it before evidence selection.
4. Verify RLS with two real accounts, including private imported lessons,
   progress, notes, bookmarks, tasks, events and focus sessions.
5. Do not enable a provider until its current free-tier terms and model id are
   checked and only free-tier entries are configured.

### P1 — required to call the foundation complete in a later phase

6. Add real provider adapters with credential resolution, Retry-After parsing and
   provider-specific quota metadata; keep deterministic mock tests.
7. Wire the gateway quota policies to the chosen deployment shape. Replace the
   in-process ledger with a shared store only if multi-isolate accuracy matters.
8. Apply the resource/chunk schema, add extraction jobs and a vector index; select
   an embedding provider and an explicit reindex/switch procedure.
9. Add hybrid retrieval and ContextGraph only after real extraction and provenance
   exist. A graph edge is not evidence.
10. Add authenticated ingestion limits (file size/type), storage ownership and
    processing-state visibility.

### P2 — hygiene and scale

11. Consolidate package manager/lockfile and add CI for lint, typecheck, tests and
    build.
12. Rehost demo media and replace Lovable asset URLs for portability.
13. Add indexes for `tasks(user_id)`, `events(user_id)`, `focus_sessions(user_id)`
    and consider upper-bound validation for note/bookmark timestamps.
14. Decide whether to reformat the repository with Prettier as a standalone
    commit; then lint can enforce formatting again.
15. Add a migration test/CI check and a signed-in E2E smoke test with a dedicated
    test project.

## 10. What remains unverified

- The migrations' SQL was not executed; syntax/behavior on the live Postgres
  version is unverified.
- Signed-in auth flows, session refresh, account switching in a real browser, and
  RLS cross-account behavior are unverified.
- No real provider adapter, key, quota response, rate-limit header or embedding
  API was exercised. The gateway is tested only with deterministic mocks.
- The client bundle grep is evidence for the inspected build, not a formal
  guarantee for every future route/import.
