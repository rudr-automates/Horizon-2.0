# Embeddings, retrieval and evidence safety

## Status

| Piece                                                          | State                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedding provider interface, model metadata, batch validation | Implemented in `src/server/ai/embeddings/`.                                                                                                                      |
| Deterministic mock embeddings                                  | Implemented and tested.                                                                                                                                          |
| Embedding-space identity and compatibility checks              | Implemented.                                                                                                                                                     |
| Keyword retrieval fallback                                     | Implemented in `src/server/retrieval/keyword.ts`.                                                                                                                |
| Timestamp/ownership evidence contract                          | Implemented in `src/server/retrieval/scope.ts`.                                                                                                                  |
| Citation existence/eligibility/quote checks                    | Implemented in `src/server/retrieval/citations.ts`.                                                                                                              |
| Resource/chunk schema                                          | Applied to the connected Supabase project.                                                                                                                       |
| Jina embeddings                                                | Implemented and verified with a real 1,024-dimension call.                                                                                                       |
| PDF / PPTX / text / code / caption extraction                  | Implemented in `src/server/ingestion/extract.server.ts`.                                                                                                         |
| Upload, ownership and storage                                  | Implemented in `ingestion/service.server.ts` and `/api/resources/upload`, with a private Supabase bucket.                                                        |
| pgvector index and keyword index                               | Applied: HNSW cosine index plus a GIN `tsvector` index.                                                                                                          |
| Request-time ranking                                           | Ranks the small authorized lesson subset in memory so scope is enforced before ranking; the HNSW/GIN indexes are available for a future database-side retriever. |
| Hybrid search                                                  | Implemented with reciprocal rank fusion.                                                                                                                         |
| Context graph                                                  | Implemented as a timestamp-adjacent transcript sequence graph.                                                                                                   |
| Jina reranking                                                 | Implemented as an optional cross-encoder step.                                                                                                                   |

The MIT 15.773 course is ingested: 11 lecture transcripts, 14 note PDFs and the
syllabus, all with Jina vectors in one declared embedding space.

## Embedding spaces are not interchangeable

A vector is meaningful only in the space that produced it. Every descriptor
declares:

```ts
{
  (providerId, modelId, dimension, spaceVersion, metric, maxInputChars, maxBatchSize);
}
```

The canonical key is
`encodeURIComponent(providerId):encodeURIComponent(modelId):dimension:encodeURIComponent(version)`.
Two vectors are compatible only when **all four** identity fields match. A model
rename, dimension change, provider change or `spaceVersion` bump creates a new
space.

Rules for later implementation:

- Store `embedding_space`, `embedding_model` and `embedding_dimension` beside
  every vector. The migration enforces all-or-none metadata.
- Query only an index whose space exactly matches the query embedding space.
- Never mix old and new vectors in one ranking.
- If no compatible ready index exists, use keyword retrieval. Do not compare
  incompatible vectors "approximately".
- Switching models requires a separate index or a controlled reindex with a
  status visible to operators. Do not silently swap the active model.
- Treat provider vectors as opaque arrays. Validate count, dimension and finite
  numbers; do not assume normalization.

## Batch validation

`validateEmbeddingInputs` rejects:

- empty input arrays and whitespace-only strings (`invalid_batch`, `empty_input`);
- more inputs than the model or application batch limit (`too_many_inputs`);
- a single input beyond the model/application character limit
  (`input_too_large`);
- a total batch beyond the application character budget (`batch_too_large`).

It never truncates text. Truncation would change what was indexed without the
learner knowing. Oversized content must be chunked deliberately first.

`EmbeddingService` additionally checks provider configuration, applies a timeout
and cancellation signal, validates returned vector count/dimension/finiteness,
and reports provider usage or an explicit estimate. `EmbeddingUsageGuard` is a
small per-isolate application guard for requests per minute and inputs/characters
per day. It is not a distributed quota service.

## Retrieval mode selection

`chooseRetrievalMode(index, querySpace)` returns:

| Situation                                  | Mode       | Reason                     |
| ------------------------------------------ | ---------- | -------------------------- |
| No index                                   | `keyword`  | `no_index`                 |
| Index building/stale/unavailable           | `keyword`  | `index_not_ready`          |
| No query embedding space                   | `keyword`  | `no_query_embedding_space` |
| Different provider/model/dimension/version | `keyword`  | `space_mismatch`           |
| Ready index with identical space           | `semantic` | `compatible_index`         |

The live lesson path uses the Jina query vector with compatible stored chunk
vectors when available. Missing vectors for the small authorized lesson set
are embedded at request time within a bounded limit and cached per server
instance. Keyword and vector rankings are merged with reciprocal rank fusion;
if embedding is unavailable or incompatible, the request falls back to keyword
retrieval. The HNSW and GIN indexes are provisioned, but this path currently
loads the authorized lesson subset and ranks it in memory rather than querying
those indexes through a database RPC.

## Resource and chunk model

The applied migration `20261025171000_ai_retrieval_foundation.sql` introduces:

### `learning_resources`

Identity and processing state for a source:

- owner (`owner_id`, null only for demo material), course, lesson, demo flag;
- kind: `video_transcript`, `pdf`, `slides`, `markdown`, `text`, `code`;
- title, status (`pending`, `processing`, `ready`, `failed`), source URL,
  content hash and a processing error;
- RLS: demo resources are public read-only; private resources are readable and
  writable only by their owner. A private file lives in the
  `learning-resources` bucket under the owner's user id and is opened through a
  short-lived signed URL.

### `resource_chunks`

One retrievable unit with provenance:

- `resource_id`, ordered `chunk_index`, content;
- locator: video start/end seconds, PDF page, slide number or text section;
- embedding space/model/dimension and a JSON vector (nullable);
- generated `tsvector` and a GIN index for keyword retrieval;
- constraints tying locator fields to the locator kind, and requiring embedding
  metadata to be all present or all absent;
- RLS inherited from the parent resource through `EXISTS` policies.

The migration is applied and `src/integrations/supabase/types.ts` is generated
from the resulting project. The vector column is fixed at 1,024 dimensions to
match the active Jina model; a different dimension requires a new migration and
a separate index, not a cast. `20261026130000_resource_file_storage.sql` adds the
private upload bucket and owner-folder policies.

## Evidence contract

`EvidenceScope` carries the authenticated learner id, lesson/course ids, lesson
owner, demo flag, real duration and the learner's current position. In the live
server path, every field except the client's position is loaded from the
database; the position is validated against the stored duration.

`validateScope` enforces:

- a non-empty learner and lesson id;
- demo lessons cannot have an owner, private lessons must be owned by the learner;
- duration is known and positive;
- position is a finite number in `[0, duration]`.

`selectEligibleEvidence` then enforces:

- status is `ready` and the text is non-empty;
- demo material has no owner; private material belongs to the learner;
- private material from a different course is excluded;
- video transcripts are lesson-scoped and cannot leak across lessons;
- documents may be course-level;
- locator fields are valid and video ranges are within the lesson duration;
- video end time is at or before the current position. The currently playing
  segment is excluded until it finishes, because its remaining words are future
  content. PDFs and slides remain eligible.

The pipeline selects evidence **before** any model call. A prompt telling the
model not to use future content is not an access-control boundary; this code is.

`buildGroundedContext` adds a context budget (8 chunks / 8,000 characters by
default). It omits a chunk that would exceed the budget instead of cutting it in
half, so a model never sees a partial source presented as complete.

## Citation verification

`validateGroundedAnswer` takes a draft and the evidence that was eligible before
generation. It rejects:

- no citations at all (`missing_citation`);
- empty ids (`invalid_citation`);
- ids not in the retrieved set (`unknown_citation`);
- ids retrieved but outside the learner's eligible scope (`ineligible_citation`);
- duplicate ids (`duplicate_citation`);
- a quote that does not occur in the cited text (`quote_mismatch`).

`validateGroundedAnswer` is the post-generation check used by the live tutor.
Quote matching is a surface check, not semantic entailment: it catches invented
quotations but cannot prove that a source supports the whole claim. The UI names
the cited source and shows its passage so the learner can judge it.

Evidence failures use `EvidenceContractError` with codes such as
`insufficient_evidence` or `ineligible_citation`. They are deliberately separate
from `AiError`; a provider outage is not "not enough evidence", and insufficient
evidence must not trigger provider fallback or paid model selection.

## Current pipeline

The tutor and practice paths in `src/server/ai/` now:

1. load the lesson through the learner's RLS-scoped Supabase client;
2. validate ownership and the server-loaded lesson duration;
3. select only evidence whose video end time is at or before the learner's
   position (documents remain eligible);
4. embed the query with Jina and use stored chunk vectors from the same space;
5. fuse keyword and semantic rankings with reciprocal rank fusion, then expand
   adjacent transcript passages when available;
6. optionally rerank the fused candidates with Jina;
7. build a bounded context and call the free-tier gateway;
8. accept the answer only when every citation id is in the pre-generation
   context and every supplied quote occurs in that source.

`prepareGroundedRequest` remains the reusable evidence-only pipeline; the live
path calls the same scope functions. Tests cover:

- a question covered by the transcript;
- a question answerable only by future content (insufficient);
- a permitted PDF/slide at position 0;
- a question absent from all resources;
- invalid/out-of-range positions and unknown duration;
- foreign-owner, cross-course, cross-lesson, failed and malformed chunks;
- valid, missing, unknown, ineligible, duplicate and quote-mismatch citations;
- context-budget omission without truncation.

## Ingestion limits and failure behaviour

- PDF text extraction uses `pdfjs-dist`; scanned/image-only PDFs are rejected
  with an OCR message rather than indexed as empty content.
- PPTX text and speaker notes are read from the OOXML archive. Legacy `.ppt` is
  rejected with a clear message.
- SRT/WebVTT captions become video evidence with real start/end times. A caption
  file that runs past the stored lesson duration is rejected.
- Files are limited to 10 MB and 220 passages. Chunk boundaries follow
  paragraphs/sentences; text is never silently truncated.
- The original file is stored privately. If Jina is unavailable, the passages are
  still stored and keyword retrieval works; the response says embeddings were
  unavailable instead of claiming semantic search.

## Remaining retrieval work

1. OCR for scanned PDFs and image-only decks.
2. A controlled reindex/active-space switch and operator-visible index status.
3. Entity/concept graph edges across resources. The current graph is deliberately
   a transcript sequence graph, not a claim of knowledge-graph retrieval.
4. A distributed embedding quota store; the current guard is per process.
5. Streaming answers and a citation-highlighting PDF viewer beyond the browser's
   native `#page=` anchor.
