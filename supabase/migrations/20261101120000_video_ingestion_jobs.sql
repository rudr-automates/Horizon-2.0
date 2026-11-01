-- Durable, per-lesson video ingestion jobs.
--
-- Why this table is required: a lesson only becomes usable by the tutor, the
-- simplifier, the summariser and the quiz generator once its transcript has
-- been chunked and embedded. That work is asynchronous (media upload, provider
-- transcription, embedding), so it needs durable state that survives a page
-- reload: which stage it reached, why it stopped and what can be retried.
-- `lessons.transcript_status` alone cannot express "in progress" or an error.
--
-- This is additive and isolated. It does not alter `lessons`,
-- `learning_resources`, `resource_chunks`, the existing Whisper queue, any
-- existing policy, or authentication. Owners write only their own rows; the
-- demo lessons remain read-only for learners.

create table if not exists public.video_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lesson_id text not null references public.lessons(id) on delete cascade,
  -- Snapshot of the video reference this job processed, so replacing a video
  -- creates a new job instead of reusing a completed one.
  source_url text not null,
  source_kind text not null check (source_kind in ('upload', 'youtube', 'vimeo', 'direct')),
  status text not null default 'queued' check (
    status in (
      'queued',
      'preparing',
      'transcribing',
      'indexing',
      'ready',
      'retry_wait',
      'failed',
      'needs_captions'
    )
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  -- Non-secret pipeline bookkeeping: stage, upload offset, provider file name,
  -- provider interaction id, segment count. Never credentials.
  progress jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lesson_id, source_url)
);

create index if not exists video_ingestion_jobs_owner
  on public.video_ingestion_jobs (user_id, lesson_id, created_at desc);

alter table public.video_ingestion_jobs enable row level security;
grant select, insert, update, delete on public.video_ingestion_jobs to authenticated;
grant all on public.video_ingestion_jobs to service_role;

drop policy if exists "read own video ingestion jobs" on public.video_ingestion_jobs;
create policy "read own video ingestion jobs"
  on public.video_ingestion_jobs for select to authenticated
  using (user_id = auth.uid());

-- A learner may create and advance jobs only for a lesson they own. Demo
-- lessons are seeded with a ready transcript and never take learner jobs.
drop policy if exists "write own video ingestion jobs" on public.video_ingestion_jobs;
create policy "write own video ingestion jobs"
  on public.video_ingestion_jobs for all to authenticated
  using (
    user_id = auth.uid()
    and exists (
      select 1
      from public.lessons l
      where l.id = lesson_id
        and l.user_id = auth.uid()
        and not l.is_demo
    )
  )
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.lessons l
      where l.id = lesson_id
        and l.user_id = auth.uid()
        and not l.is_demo
    )
  );

drop trigger if exists touch_video_ingestion_jobs on public.video_ingestion_jobs;
create trigger touch_video_ingestion_jobs
  before update on public.video_ingestion_jobs
  for each row execute function public.touch_updated_at();

comment on table public.video_ingestion_jobs is
  'Durable progress for automatic transcript/chunk/embedding ingestion of learner videos.';
