# Offline finale package inventory

This workspace contains an editable six-slide presentation and synthetic sample dataset alongside the source documents. It is not yet a complete release package: no recorded demo or verified production deployment receipt is available.

## Present deliverables

- [Competition presentation](../deliverables/Horizon_2.0_Competition_Final_Presentation.pptx) — six editable slides, rendered and visually inspected; artifact import validation passed. Native PowerPoint rendering was not independently checked.
- [Synthetic sample dataset ZIP](../deliverables/horizon-sample-dataset.zip) — archive extraction verified. It contains generated MP4, matching VTT, synthetic PPTX, metadata with expected questions/evidence locators, and README. No user-supplied MKV or private course export is included.
- [Extracted sample files](../deliverables/horizon-sample-dataset/).

## Included source documents

- `FINAL_RELEASE_TRACKER.md` — consolidated acceptance and release status.
- `docs/ARCHITECTURE.md` — current as-built diagram, AWS reference diagram and migration notes.
- `docs/API.md` — API and worker route inventory.
- `docs/EVALUATION.md` — measured local evidence and explicit unmeasured areas.
- `docs/DEMO_RUNBOOK.md` — two-minute recording storyboard.
- `docs/LOCAL_SETUP.md`, `docs/WHISPER_WORKER.md`, `README.md` — setup and operations.
- `docs/WHISPER_INTEGRATION_REPORT.md`, `docs/HORIZON_FINAL_REVIEW_REPORT.md`, `docs/HORIZON_TARGETED_ACCEPTANCE_REPORT.md` — prior review evidence and limitations.

## Required before judging

1. Capture and verify the real demonstration video (maximum two minutes) using [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).
2. Complete the gated Supabase migration, worker setup, end-to-end transcription acceptance and production deployment; attach its verified URL and commit receipt.
3. Copy the final PPTX, recorded MP4, sample dataset, architecture, evaluation, API, setup and operations runbook into the offline handoff folder.

Do not describe this inventory as a complete reviewer-ready package until every required file exists and has been opened/checked offline.
