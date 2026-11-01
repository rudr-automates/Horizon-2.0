# Horizon 2.0 evaluation evidence

Date: 1 November 2026. Results below distinguish measured local checks from unverified deployment claims.

## Measured

| Evaluation | Result | Evidence and limit |
|---|---|---|
| TypeScript | PASS | `corepack pnpm exec tsc --noEmit` on merged local `main`. |
| Browser/server build | PASS | `corepack pnpm build`. |
| Vercel target build | PASS | `NITRO_PRESET=vercel` Vite build generated `.vercel/output` for Node.js 24 on Windows x64. This is a local build, not a deployment. |
| ESLint | PASS with warnings | 0 errors, 8 existing React Fast Refresh warnings. |
| Application and live provider tests | PASS with skips | 12 files / 112 tests passed; 7 tests skipped. Live MIT workflow cases need a separate E2E login; configured Gemini, Groq and Jina provider smoke checks passed. |
| Worker parser tests | PASS | 4 unittest cases passed. |
| MKV technical test | PASS, local excerpt only | FFmpeg selected first/default English AAC audio stream, source duration 43:17.931, and extracted 20 seconds at 16 kHz mono. Whisper large-v3-turbo produced 6 timestamped segments. No benchmark beyond that excerpt; the source is copyrighted and remains local. |
| Whisper sample performance | MEASURED (prior report) | Prior local run: bundled 11-second JFK sample took 7.86 seconds on Vulkan0 / AMD RX 580; one segment through 10.4 seconds. Not representative throughput. |

## Not measured in this pass

- Word error rate, reference-aligned transcript quality, timestamp error distribution.
- Retrieval precision/recall, citation accuracy, refusal rate, adversarial claim-verification quality, or realistic seeded-course latency.
- Controlled provider failure/fallback behavior, token/cost use, quiz coherence and scoring against a live provider.
- Signup delivery, password recovery, storage privacy, two-account RLS isolation, browser persistence, live upload/transcription/indexing, calendar persistence, or cross-device use.
- AWS deployment cost. No region or workload assumptions were provided and no resources were provisioned.
- Real-address signup delivery, account recovery, cross-account RLS behavior and browser persistence. A disposable reserved-domain address was rejected before user creation; Auth settings remain unchanged.
- Production Whisper queue processing. Production landing and AI health are reachable, but Whisper heartbeat returns 404; the migration confirmation expired before application and the worker token is not configured.

## Evaluation labels

- **MEASURED:** observed in the local checks above.
- **TARGET:** future acceptance requirement, not measured.
- **SOURCED:** not used for any new quantitative claim in this report.
- **DESIGN:** architecture described in [ARCHITECTURE.md](ARCHITECTURE.md).
- **HYPOTHESIS:** none presented as measured evidence.

The test suite's pass result demonstrates local code contracts only. It does not establish that production data or external providers behave correctly.
