# Horizon sample course dataset — Spaced Repetition

This self-contained sample is synthetic Horizon acceptance content. The 60-second video is a generated test pattern and tone, the caption track is written to match that video, and the slide deck is generated from original fixture text. No real lecture, person, copyrighted recording, private course file, or source episode is included.

## Contents

- `spaced-repetition-demo.mp4` — generated 60-second sample video.
- `spaced-repetition-demo.vtt` — ten timestamped captions aligned to the generated video.
- `spaced-repetition-practice.pptx` — three-slide practice deck with synthetic speaker notes.
- `course.json` — metadata, five expected questions, answers, and evidence locators.

## Regeneration

The source fixtures and build instructions are in `scripts/fixtures/README.md`; the sample video can be regenerated with FFmpeg and the slide deck with `scripts/build-fixture-package.py`.

## Provenance

The package contains no third-party source media. It is intended for educational software demonstrations and acceptance testing. This folder makes no licensing claim about material outside this sample.
