# Horizon 2.0 review branch report

Date: 31 October 2026
Repository: `rudr-automates/Horizon-2.0`
Review branch: `codex/horizon-final-rebuild`
Base: `ea7350cc829c92f4625004761fc60d895f357c33` (`main`)

## Work in this branch

- Normalized `src/routes/__root.tsx` to LF. The latest upstream favicon change
  had CRLF line endings and failed the repository's Prettier lint rule on this
  Windows checkout.
- Added `.gitattributes` rules to keep TypeScript files on LF across checkouts.
- Corrected the retrieval architecture note: the live tutor uses hybrid
  keyword/vector ranking over the authorized lesson subset in memory. The
  database HNSW/GIN indexes exist but are not queried by a database RPC today.
- This report records fresh checks and clearly separates them from earlier
  acceptance evidence.

## RAG findings

The recorded 30 October live acceptance found two caption-path defects: valid
WebVTT `NOTE`, `STYLE`, and `REGION` blocks were rejected, and captions indexed
from Study Materials did not update the lesson transcript used by the synced
Transcript panel. The existing code now skips those metadata blocks, indexes
timestamped caption chunks, and syncs parsed cues to the lesson row. The local
caption parser and ingestion tests passed in this run; the prior live upload,
answer, future-content refusal, and citation-seek run is documented in
`LOCAL_ACCEPTANCE_REPORT.md` and was not repeated here.

Current tutor code filters by learner, course, lesson, resource status, and
timestamp before retrieval/model calls; ranks eligible evidence with keyword
and compatible Jina vectors; optionally reranks; and validates citation IDs,
eligibility, and quoted text after generation. Tests exercised by `npm test`
cover timestamp boundaries, ownership/scope exclusions, future-only evidence,
insufficient evidence, and citation validation.

YouTube playback does not acquire captions automatically. A learner must
provide an SRT/WebVTT track before transcript-grounded questions can use that
video. The product reports the transcript as unavailable rather than treating
the video URL as indexed content. Automatic transcription remains unimplemented.

## Fresh verification

| Check                               | Result                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                      | Passed with 0 errors and 8 existing React Fast Refresh warnings.                                                                                                |
| `npm test`                          | Passed: 10 files, 97 tests; 2 suites / 14 opt-in tests skipped. The skipped suites require explicit live-provider or live-workflow opt-in.                      |
| `npx tsc --noEmit`                  | Passed.                                                                                                                                                         |
| `npm run build`                     | Passed. Vite reported an existing tsconfig-paths plugin notice and large client chunks.                                                                         |
| `NITRO_PRESET=vercel npm run build` | Passed; generated `.vercel/output` for the Vercel Node.js 24 runtime.                                                                                           |
| `git diff --check`                  | Passed.                                                                                                                                                         |
| Production homepage                 | `https://horizonreboot.vercel.app/` returned HTTP 200 and Horizon 2.0 HTML.                                                                                     |
| Production icon assets              | Versioned `/favicon.svg?v=2` returned HTTP 200 with `image/svg+xml` and the Horizon mark; `/favicon.ico?v=2` returned HTTP 200 with `image/vnd.microsoft.icon`. |
| Production deployment               | Vercel reports READY deployment `dpl_oMwJU1WCE7BmBuNdHHhSkZ4yjzyh` on `main`, commit `ea7350cc829c92f4625004761fc60d895f357c33`.                                |
| Review deployment                   | READY preview `dpl_DXgsFwhvEy8feEzqbxPRELXJ44ni` for the review commit; its homepage and versioned Horizon SVG returned HTTP 200.                               |
| Supabase security advisor           | No security finding was returned except a warning that leaked-password protection is disabled. No database changes were made.                                   |

The HTTP icon responses and page declarations were verified. A visible browser
tab was not checked in this pass. No new production RAG question, account
isolation attempt, signup/sign-in, or upload workflow was run. Earlier live
acceptance results in `LOCAL_ACCEPTANCE_REPORT.md` are historical evidence,
not fresh results for this branch.

## Remaining work and limitations

- Run the opt-in real-provider and live-workflow suites in a disposable
  environment before release. The existing live workflow mutates Supabase rows
  and storage; it was not run against production in this pass.
- Add legitimate automatic caption acquisition or transcription if the product
  requires YouTube URLs to become searchable without a learner-supplied track.
- Visually check the deployed browser tab favicon.
- Review Supabase Auth's disabled leaked-password protection setting. The
  performance advisor also reports missing foreign-key indexes and RLS policy
  optimization opportunities; no schema or Auth settings were changed here.
- The review branch has a READY preview deployment. Production was not redeployed.
- No account, user row, or existing production data was deleted or modified.

## Git state

Work is on `codex/horizon-final-rebuild`, based on current `origin/main`. Changes
are for review; `main` and the production deployment were not changed.
