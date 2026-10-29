<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

- Personal data, lesson progress, notes and bookmarks are read/written from the browser Supabase client and protected by per-user RLS; signed-in pages live under src/routes/_authenticated (client-only gate). Why: simple, secure owner-only CRUD without extra server functions.
- Pure business rules (streaks, timers) live in src/lib with vitest tests in src/test. Why: keep rules testable.
- Course catalog and ordered lesson/transcript metadata live in Supabase; sample media is reproducible with scripts/generate-sample-course.py using the same narration source as the transcript. Why: real aligned educational resources without fabricated captions.
- External video providers use a browser-only registry and supported player APIs; no arbitrary server URL fetching. Why: maintain timestamp synchronization without SSR or private-network exposure.
