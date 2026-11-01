-- Private, durable work queue for the Horizon local Whisper worker.
-- The desktop worker reaches this queue only through authenticated app routes.
create table public.transcription_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id text not null references public.lessons(id) on delete cascade,
  media_path text not null,
  status text not null default 'queued' check (status in (
    'queued','claimed','downloading','extracting_audio','transcribing',
    'normalizing','indexing','ready','retry_wait','failed'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  next_attempt_at timestamptz not null default now(),
  worker_id text,
  lease_token text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  progress jsonb not null default '{}'::jsonb,
  error_code text,
  error_message text,
  resource_id uuid references public.learning_resources(id) on delete set null,
  model_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lesson_id, media_path)
);

create table public.transcription_workers (
  worker_id text primary key,
  state text not null default 'idle' check (state in (
    'idle','claimed','downloading','extracting_audio','transcribing','normalizing','indexing'
  )),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index transcription_jobs_claim_idx
  on public.transcription_jobs (next_attempt_at, created_at)
  where status in ('queued','retry_wait');
create index transcription_jobs_lease_idx
  on public.transcription_jobs (lease_expires_at)
  where status in ('claimed','downloading','extracting_audio','transcribing','normalizing','indexing');
create index transcription_jobs_owner_idx
  on public.transcription_jobs (user_id, lesson_id, created_at desc);

alter table public.transcription_jobs enable row level security;
alter table public.transcription_workers enable row level security;
revoke all on public.transcription_jobs from anon, authenticated;
revoke all on public.transcription_workers from anon, authenticated;
grant select on public.transcription_jobs to authenticated;
grant all on public.transcription_jobs to service_role;
grant all on public.transcription_workers to service_role;
create policy "learners read their transcription jobs"
  on public.transcription_jobs for select to authenticated
  using ((select auth.uid()) = user_id);

-- Claim one eligible row with skip-locked concurrency and one active job per worker.
-- An expired lease can be reclaimed, but each claim receives a new token.
create or replace function public.claim_transcription_job(p_worker_id text)
returns setof public.transcription_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.transcription_jobs;
begin
  if p_worker_id is null or length(trim(p_worker_id)) < 1 or length(p_worker_id) > 120 then
    raise exception 'invalid worker id';
  end if;

  -- This PC has one GPU worker; serialize claims and enforce one active job
  -- globally, even if someone starts two copies with different worker IDs.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('horizon_whisper_queue', 0));

  update public.transcription_jobs
     set status = case when attempt_count >= max_attempts then 'failed' else 'retry_wait' end,
         next_attempt_at = now(),
         lease_token = null,
         worker_id = null,
         lease_expires_at = null,
         error_code = 'worker_lease_expired',
         error_message = 'The worker stopped responding; the job will be retried.',
         updated_at = now()
   where status in ('claimed','downloading','extracting_audio','transcribing','normalizing','indexing')
     and lease_expires_at < now();

  if exists (
    select 1 from public.transcription_jobs
     where status in ('claimed','downloading','extracting_audio','transcribing','normalizing','indexing')
       and lease_expires_at >= now()
  ) then return; end if;

  select * into claimed
    from public.transcription_jobs
   where status in ('queued','retry_wait')
     and next_attempt_at <= now()
     and attempt_count < max_attempts
   order by created_at
   for update skip locked
   limit 1;

  if not found then return; end if;

  update public.transcription_jobs
     set status = 'claimed',
         attempt_count = attempt_count + 1,
         worker_id = p_worker_id,
         lease_token = gen_random_uuid()::text || gen_random_uuid()::text,
         lease_expires_at = now() + interval '3 minutes',
         heartbeat_at = now(),
         progress = '{"stage":"claimed"}'::jsonb,
         error_code = null,
         error_message = null,
         updated_at = now()
   where id = claimed.id
   returning * into claimed;
  return next claimed;
end;
$$;

revoke all on function public.claim_transcription_job(text) from public, anon, authenticated;
grant execute on function public.claim_transcription_job(text) to service_role;
