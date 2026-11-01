# Horizon 2.0 — Learning Studio

An evidence-grounded learning workspace built with TanStack Start, React,
TypeScript, Tailwind CSS, Supabase and Vitest.

## What works now

- Sign in with Supabase Auth; learner notes, bookmarks, progress, tutor history
  and practice attempts are protected by per-user RLS.
- Open the seeded **Hands-On Deep Learning (MIT 15.773)** course: 11 lectures with
  YouTube playback and synced transcripts, 14 note PDFs, and the syllabus.
- Ask the tutor at the current playback position. The server resolves the lesson
  and ownership, retrieves only evidence the learner has reached, embeds the query
  with Jina, fuses keyword and semantic ranking, optionally reranks, and calls
  Gemini with Groq as a bounded free-tier fallback.
- Answers are shown only when every citation points to eligible evidence. PDF
  citations open at the cited page; uploaded-file citations use a short-lived
  signed URL; video citations seek the player.
- **Explain simply**, **Summarize so far**, follow-up questions, quick quizzes,
  exam drills, interview drills, persisted scores and helpful/not-helpful
  feedback are wired to the same grounded path.
- **Any learner video** is ingested automatically: uploads and direct MP4/WebM
  links are transcribed with timestamped passages, chunked and embedded through
  the same pipeline as the seeded course, so all four AI features work at any
  timestamp. Links to hosts with published captions use those captions. A
  durable job exposes queued, processing, ready, needs-captions and failed
  states instead of an evidence error. See
  [universal video ingestion](docs/VIDEO_INGESTION_PIPELINE.md).
- **Study materials** uploads PDF, PPTX, Markdown, text, code and SRT/WebVTT
  captions. Files are private per learner, text is extracted and chunked, and
  Jina vectors are stored in an explicitly versioned 1,024-dimensional space.
- **Central pgvector RAG** indexes timestamped video passages with 768-d Gemini
  embeddings in PostgreSQL and retrieves only the playback-covered chunks for
  every AI feature. See [pgvector RAG](docs/PGVECTOR_RAG.md).
- If credentials are missing, a provider fails or free quota is exhausted, the UI
  reports the category and never fabricates an answer. There is no paid fallback.

No provider key is required to run the deterministic test suite. Real-provider
verification is opt-in; see [local setup](docs/LOCAL_SETUP.md).

## Documentation

- [Universal video ingestion: root cause, pipeline and limits](docs/VIDEO_INGESTION_PIPELINE.md)
- [Central PostgreSQL + pgvector RAG: schema, retrieval and limits](docs/PGVECTOR_RAG.md)
- [Phase 2 completion report and verification results](docs/HORIZON_2_PHASE_2_REPORT.md)
- [Local setup, migrations, uploads and Vercel build](docs/LOCAL_SETUP.md)
- [AI provider gateway and free-tier policy](docs/AI_PROVIDER_ARCHITECTURE.md)
- [Embeddings, hybrid retrieval and evidence safety](docs/EMBEDDING_AND_RETRIEVAL_ARCHITECTURE.md)
- [Learning Studio](docs/LEARNING_STUDIO.md)
- [Repository readiness audit](docs/REPOSITORY_READINESS.md)

## Development

```sh
npm ci
cp .env.example .env   # fill in Supabase and AI provider values
npm run dev
npm test
```

See [local setup](docs/LOCAL_SETUP.md) for the full environment table, applied
migrations, seeding and real-provider tests. `NITRO_PRESET=vercel npm run build`
produces a Vercel Build Output API bundle.

This project was built with [Lovable](https://lovable.dev). Lesson media is MIT
OpenCourseWare material licensed CC BY-NC-SA 4.0; YouTube playback remains subject
to YouTube's terms.

## Built with

- TanStack Start
- TypeScript / React
- Tailwind CSS
- Supabase (Postgres, Auth, Storage, pgvector)
- Gemini, Groq and Jina free tiers
