# AI provider architecture (Phase 2 live integration)

## Status

| Piece                                                            | State                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Provider-neutral contracts                                       | Implemented in `src/server/ai/types.ts`.                                                                               |
| Provider registry                                                | Implemented in `registry.ts`.                                                                                          |
| Gateway: selection, fallback, retries, timeouts, correlation ids | Implemented in `gateway.ts`.                                                                                           |
| Quota ledger, application limits, concurrency guard              | Implemented in `quota.ts`.                                                                                             |
| Typed errors and HTTP classification                             | Implemented in `errors.ts`.                                                                                            |
| Deterministic mock provider                                      | Implemented in `mock-provider.ts`; used only by tests.                                                                 |
| Real Gemini adapter                                              | Implemented in `providers/gemini.ts`; verified with a live call.                                                       |
| Real Groq adapter                                                | Implemented in `providers/groq.ts`; verified with a live call.                                                         |
| Jina embeddings and reranking                                    | Implemented in `embeddings/jina.ts` and `retrieval/rerank.ts`; verified live.                                          |
| Authenticated tutor/scaffold RPC                                 | Implemented in `src/lib/ai-tutor.functions.ts`, backed by `src/server/ai/lesson-tutor.server.ts` and `quiz.server.ts`. |
| Streaming and structured output                                  | JSON response mode is used; token streaming is not implemented.                                                        |

Gemini is the primary free-tier model and Groq is the bounded fallback. The live
path is exercised with real keys when they are present, and with deterministic
mocks in the normal test suite. A mock answer is never labelled as a real one.

## Server boundary

Everything under `src/server/**` is treated as server-only by the TanStack Start
import-protection configuration. Importing these modules from a route or
component is a build error. `src/server/ai/credentials.ts` also imports the
explicit `@tanstack/react-start/server-only` marker.

Do not move provider adapters into `src/lib` or `src/components`. The public RPC
wrappers live in `src/lib/ai-tutor.functions.ts` because TanStack Start's import
protection blocks client imports from `src/server/**`; each wrapper dynamically
imports the server implementation and is protected by `requireSupabaseAuth`. The
browser never receives provider keys, raw provider errors or unrestricted
evidence.

## Request lifecycle

1. `validateRequest` rejects empty messages, oversized input, invalid roles,
   invalid `maxOutputTokens`, invalid temperature and invalid timeouts.
2. Candidates come from `GatewayConfig.models`, in order, and only entries that
   are `enabled`, `tier: "free"` and present in the registry are considered.
3. A candidate is skipped when it has no adapter, no credentials, an open health
   circuit, an input exceeding its model limit, a busy concurrency slot, an
   exhausted provider window or an application quota denial.
4. A quota reservation is recorded before the call. Provider-reported tokens may
   increase the record; a lower reported number never decreases it.
5. The provider call is bounded by a timeout and forwarded cancellation signal.
6. Success must contain non-empty text; usage is normalized (missing usage is
   reported as `unknown`, never invented).
7. Failures are classified and handled by the policy below. Every attempt is
   recorded in `AiCompletion.attempts` (metadata only).

At most `attemptsPerProvider` attempts are made per model and `totalAttempts`
per learner request. Backoff is exponential with bounded jitter, and
`Retry-After` is honoured for rate limits.

## Failure policy

| Classification                                                       | Retry same provider                     | Fall back                                 | Rationale                                                                                |
| -------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `invalid_request`, `invalid_configuration`                           | No                                      | No                                        | Input is wrong; repeating cannot help.                                                   |
| `content_refused`                                                    | No                                      | **No**                                    | Do not try to bypass a safety decision with another model.                               |
| `aborted`                                                            | No                                      | No                                        | Caller cancelled.                                                                        |
| `timeout`                                                            | **No**                                  | **No**                                    | The provider may already have processed the request; retrying risks duplicate work/cost. |
| `authentication_failed`                                              | No                                      | Yes, after marking the provider unhealthy | Bad credentials are provider-level, not learner input.                                   |
| `rate_limited`                                                       | Yes, only within the inline wait budget | Yes                                       | Honour `Retry-After`; avoid a tight loop.                                                |
| `quota_exhausted`                                                    | No                                      | Yes                                       | Remember the reset time before trying another free provider.                             |
| `provider_unavailable`, `network_error`                              | Yes, bounded                            | Yes                                       | Transient infrastructure failures.                                                       |
| `response_invalid`, `unsupported_model`, missing credentials/adapter | No                                      | Yes                                       | No usable result from that model.                                                        |
| `application_limit_exceeded` (global)                                | No                                      | **No**                                    | Application spending guard must stop all providers.                                      |
| `all_providers_unavailable`                                          | No                                      | No                                        | Terminal typed error for graceful UI degradation.                                        |

When every candidate fails, the gateway throws `all_providers_unavailable`. It
never selects a paid model, never retries indefinitely and does not fan out
without a total attempt cap.

## Configuration

The runtime in `src/server/ai/runtime.server.ts` registers Gemini and Groq and
uses these free-tier candidates in order:

1. `gemini` / `gemini-3.5-flash-lite`
2. `groq` / `openai/gpt-oss-20b`

`AI_MODEL_PREFERENCES` may replace that ordered list with a JSON array. Every
entry must declare `tier: "free"`; a paid or missing tier fails configuration
instead of being silently skipped. A retired model fails closed rather than
silently selecting a paid replacement. Check each provider's current terms and
quota documentation before changing a model id.

Quota policies are currently constructed in server code, not from environment
variables. A policy declares provider/model, application minute/day request and
token limits, concurrency, and optionally a mirrored provider-published window.
A configured model with no policy fails closed (it is skipped), which is covered
by tests.

## Adding a provider adapter

1. Implement `AiProvider` from `types.ts` with a stable `id`.
2. Implement `isConfigured()` using `credentialStatus` / `readCredential` from
   `credentials.ts`. Never read credentials in the browser.
3. Map the provider's HTTP status through `classifyHttpStatus`. For 429 responses,
   parse `Retry-After` and, only when the provider explicitly reports it, a quota
   reset. Never parse or log response bodies for secrets or learner content.
4. Forward the supplied `AbortSignal`; do not implement an unbounded internal
   retry loop.
5. Return text, optional usage and a normalized `finishReason`.
6. Register the adapter on the server. Registration alone does not enable it; a
   free-tier config entry is also required.
7. Add deterministic tests using `MockAiProvider` shapes; never invoke a real API
   in the test suite.

Provider capabilities differ. `ModelCapabilities` has extension flags for
streaming and structured output, but the current gateway only requests text.
Do not assume a provider supports streaming, JSON mode, system messages or the
same model identifiers.

## Credentials

Server-side names only:

- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `JINA_API_KEY` (embeddings and reranking)

`credentialStatus` reports missing variable **names**, never values. Placeholder
values such as `<your-key>` or `changeme` are treated as unconfigured. Provide
real keys through the hosting secret store, not through a committed file. The
local development server was verified to load the root `.env`; `/api/ai/health`
reports only configured/unconfigured booleans.

## Usage and quota semantics

The ledger distinguishes:

- **Application limits** (`application_limit_exceeded`): authoritative, enforced
  by this app. A per-model limit may fall back to another model; the global guard
  stops the whole request.
- **Provider-published limits** (`quota_exhausted`): mirrored conservatively to
  avoid obvious overrun. They are not proof of remaining provider quota.
- **Unknown limits**: the snapshot always reports `providerRemaining: "unknown"`.
  The API does not claim to know a provider's real remaining balance.
- **Temporary rate limiting** (`rate_limited`): short-lived cooldown with
  `Retry-After`, distinct from exhausted quota.
- **Application spending guard**: global request/token windows. No paid fallback.
- **Missing token usage**: reservations stay conservative; reservations are never
  reduced by an under-report.

The ledger is in-process. In a multi-isolate/serverless deployment every isolate
enforces its own share, so a global limit configured as 100 can be exceeded by
the number of concurrently active isolates. That is documented, not hidden. A
shared quota store is deliberately deferred until the deployment shape requires
it.

## Observability

Logs are whitelist-sanitized by `sanitizeLogFields`. Allowed fields are
correlation id, provider/model, attempt, error code, duration, candidate count,
fallback flag, input character count and output token count. Message content,
prompts, learner text, credentials and raw provider bodies are never logged.
Correlation ids are caller-supplied (sanitized) or generated per request.

## Tests

```sh
npx vitest run src/test/ai-gateway.test.ts src/test/ai-quota.test.ts
```

Coverage includes selection order, fallback, Retry-After, retry bounds, total
attempt cap, missing credentials, paid-model rejection, quota exhaustion
remembered, application guards, timeout without duplication, cancellation,
unknown usage, log scrubbing and deterministic mock behaviour. The default
suite uses no API keys. The opt-in smoke suite makes one bounded call per
configured provider and is not part of `npm test`.

## Live verification

With real keys in the server environment:

```sh
RUN_REAL_AI_SMOKE=1 node --env-file=.env node_modules/vitest/vitest.mjs run src/test/real-ai.smoke.test.ts
RUN_LIVE_WORKFLOW=1 node --env-file=.env --env-file=.env.e2e node_modules/vitest/vitest.mjs run src/test/live-workflow.test.ts
```

The second command creates a temporary private note, asks a question about it,
checks the signed citation, and removes the note. It requires an existing test
learner in `.env.e2e`.

## Planned, not implemented

- Token streaming.
- A shared quota store for multi-isolate deployments; the current ledger is
  per-process and documented as such.
- Admin alerting beyond structured logs.
- Provider-specific model discovery; model ids remain an explicit allowlist.
