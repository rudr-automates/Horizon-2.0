# Learning Studio

## Available

- Signed-in course collection at `/courses`, imported-video library at `/library`,
  course outlines at `/courses/:courseId`, and the Studio at `/learn/:lessonId`.
- **Hands-On Deep Learning (MIT 15.773)** is seeded with 11 lectures, 14 note PDFs
  and the course syllabus. Lectures play from YouTube; synchronized transcripts
  are stored in Supabase. The material is MIT OpenCourseWare, CC BY-NC-SA 4.0.
- Playback controls, active transcript highlighting, caption search, timestamp
  seeking, notes and bookmarks.
- Resume checkpoints while playing, on pause/seeking, on lesson navigation and on
  visibility changes. Completion is explicit and separate from watched time;
  seeking cannot mark a lesson complete.
- **Grounded AI tutor:** answers at the current playback position from eligible
  evidence only, with verified citations, Explain Simply, Summarize So Far and
  follow-up history.
- **Practice:** quick quiz, exam drill and interview drill generated from the
  covered evidence, with persisted answers, scores and explanations.
- **Study materials:** lesson and course resources with direct PDF/page links,
  plus private uploads of PDF, PPTX, Markdown, text, code and SRT/WebVTT captions.
- Import YouTube, Vimeo and direct public HTTPS MP4/WebM URLs. Imported lessons
  remain private. Captions can be pasted or uploaded; the app does not scrape or
  transcribe video automatically.

## Evidence rules

The server loads the lesson and its duration through the learner's RLS client.
The client only supplies a playback position, which is validated against that
duration. Video evidence must end at or before the position, so future lecture
content is excluded. Documents may be course-level. Demo resources are public;
private resources are owner-only. A model answer is withheld unless every
citation is in the pre-generation context and any quote occurs in the cited text.

See [embeddings and retrieval](EMBEDDING_AND_RETRIEVAL_ARCHITECTURE.md) for the
full contract and [AI providers](AI_PROVIDER_ARCHITECTURE.md) for quotas and
fallback.

## Sample media and portability

- Lecture video is remote YouTube playback; no video file is stored in this
  workspace.
- Course PDFs are copied under `public/course/mit-15-773/` and are served by the
  app.
- `scripts/generate-sample-course.py` can rebuild the older synthetic PDF, PPTX,
  Markdown, Python and video demonstration if Pillow, reportlab, python-pptx,
  ffmpeg and espeak are available. Those older `src/assets/*.asset.json` pointers
  are not used by the current Study materials tab.
- Re-run `scripts/ingest-mit-course.mjs` after changing embedding model metadata
  or source files. It replaces only the `mit-15-773` demo resources.

## Validation

`npm test` covers gateway selection/fallback/quota, embedding-space validation,
scope and timestamp enforcement, citation verification, graph expansion, text
chunking, PDF/PPTX/VTT extraction, auth cache isolation, streaks and routing.
Real-provider checks are opt-in and documented in
[local setup](LOCAL_SETUP.md). Live checks cover Gemini, Groq, Jina embeddings,
Jina reranking, the seeded MIT course, private-note citation opening and quiz
persistence. A full localhost UI pass, its pass/fail matrix and the bugs it fixed
are recorded in [local acceptance](LOCAL_ACCEPTANCE_REPORT.md).
