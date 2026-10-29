-- Horizon Phase 2: durable retrieval, embeddings and persisted learning feedback.
--
-- This replaces the Phase 1 draft in the same migration slot. That draft was
-- never applied (verified through Supabase migration history), so there is no
-- deployed schema to preserve. Everything here is additive at the application
-- level; no existing learner table is dropped or rewritten.
--
-- Ownership remains RLS-first. Demo resources are public; private resources
-- belong to exactly one learner. Resource chunks inherit their parent resource's
-- visibility, so a chunk can never be read after its resource is revoked.

create extension if not exists vector with schema extensions;

create table if not exists public.learning_resources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references auth.users(id) on delete cascade,
  course_id text references public.courses(id) on delete cascade,
  lesson_id text references public.lessons(id) on delete cascade,
  is_demo boolean not null default false,
  kind text not null check (kind in ('video_transcript', 'pdf', 'slides', 'markdown', 'text', 'code')),
  title text not null check (length(trim(title)) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  source_url text,
  content_hash text,
  processing_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((is_demo and owner_id is null) or (not is_demo and owner_id is not null)),
  check (lesson_id is not null or course_id is not null)
);

create index if not exists learning_resources_owner
  on public.learning_resources(owner_id, lesson_id);
create index if not exists learning_resources_course
  on public.learning_resources(course_id, kind, status);
create unique index if not exists learning_resources_owner_hash
  on public.learning_resources(owner_id, lesson_id, content_hash)
  where owner_id is not null and content_hash is not null;

alter table public.learning_resources enable row level security;
grant select on public.learning_resources to anon, authenticated;
grant insert, update, delete on public.learning_resources to authenticated;
grant all on public.learning_resources to service_role;

drop policy if exists "read visible learning resources" on public.learning_resources;
create policy "read visible learning resources"
  on public.learning_resources for select to anon, authenticated
  using (is_demo or owner_id = auth.uid());

drop policy if exists "manage own learning resources" on public.learning_resources;
create policy "manage own learning resources"
  on public.learning_resources for all to authenticated
  using (owner_id = auth.uid() and not is_demo)
  with check (owner_id = auth.uid() and not is_demo);

drop trigger if exists touch_learning_resources on public.learning_resources;
create trigger touch_learning_resources
  before update on public.learning_resources
  for each row execute function public.touch_updated_at();

create table if not exists public.resource_chunks (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references public.learning_resources(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  heading text,
  text text not null check (length(trim(text)) > 0),
  locator_kind text not null check (locator_kind in ('video', 'page', 'slide', 'text')),
  video_start_seconds double precision,
  video_end_seconds double precision,
  page_number integer,
  slide_number integer,
  section text,
  embedding extensions.vector(1024),
  embedding_space_key text,
  embedding_provider text,
  embedding_model text,
  embedding_dimension integer check (embedding_dimension is null or embedding_dimension = 1024),
  embedding_version text,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb,
  text_search tsvector generated always as (
    to_tsvector('english', coalesce(heading, '') || ' ' || text)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (resource_id, chunk_index),
  check (
    (locator_kind = 'video' and video_start_seconds is not null and video_end_seconds is not null
      and video_start_seconds >= 0 and video_end_seconds > video_start_seconds)
    or (locator_kind = 'page' and page_number is not null and page_number > 0)
    or (locator_kind = 'slide' and slide_number is not null and slide_number > 0)
    or (locator_kind = 'text')
  ),
  check (embedding is null or extensions.vector_dims(embedding) = 1024),
  check (
    embedding is null
    or (embedding_space_key is not null and embedding_provider is not null
      and embedding_model is not null and embedding_dimension = 1024
      and embedding_version is not null)
  )
);

create index if not exists resource_chunks_resource
  on public.resource_chunks(resource_id, chunk_index);
create index if not exists resource_chunks_text_search
  on public.resource_chunks using gin(text_search);
create index if not exists resource_chunks_embedding_hnsw
  on public.resource_chunks using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

alter table public.resource_chunks enable row level security;
grant select on public.resource_chunks to anon, authenticated;
grant insert, update, delete on public.resource_chunks to authenticated;
grant all on public.resource_chunks to service_role;

drop policy if exists "read chunks of visible resources" on public.resource_chunks;
create policy "read chunks of visible resources"
  on public.resource_chunks for select to anon, authenticated
  using (
    exists (
      select 1
      from public.learning_resources r
      where r.id = resource_id
        and (r.is_demo or r.owner_id = auth.uid())
        and r.status = 'ready'
    )
  );

drop policy if exists "manage chunks of own resources" on public.resource_chunks;
create policy "manage chunks of own resources"
  on public.resource_chunks for all to authenticated
  using (
    exists (
      select 1
      from public.learning_resources r
      where r.id = resource_id and r.owner_id = auth.uid() and not r.is_demo
    )
  )
  with check (
    exists (
      select 1
      from public.learning_resources r
      where r.id = resource_id and r.owner_id = auth.uid() and not r.is_demo
    )
  );

drop trigger if exists touch_resource_chunks on public.resource_chunks;
create trigger touch_resource_chunks
  before update on public.resource_chunks
  for each row execute function public.touch_updated_at();

-- Persisted tutor history and a simple helpful/not-helpful signal. The answer
-- and citations are stored so feedback can refer to exactly what was shown.
create table if not exists public.tutor_exchanges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lesson_id text not null references public.lessons(id) on delete cascade,
  position_seconds double precision not null check (position_seconds >= 0),
  mode text not null default 'question' check (mode in ('question', 'explain', 'summary')),
  question text not null check (length(trim(question)) between 1 and 1000),
  answer text not null check (length(trim(answer)) between 1 and 20000),
  citations jsonb not null default '[]'::jsonb,
  provider_id text,
  model_id text,
  retrieval text,
  helpful boolean,
  created_at timestamptz not null default now()
);

create index if not exists tutor_exchanges_owner
  on public.tutor_exchanges(user_id, lesson_id, created_at desc);

alter table public.tutor_exchanges enable row level security;
grant select, insert, update, delete on public.tutor_exchanges to authenticated;
grant all on public.tutor_exchanges to service_role;

drop policy if exists "own tutor exchanges" on public.tutor_exchanges;
create policy "own tutor exchanges"
  on public.tutor_exchanges for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.lessons l
      where l.id = lesson_id and (l.is_demo or l.user_id = auth.uid())
    )
  );

-- Quiz and practice attempts are generated from the same eligible evidence as
-- the tutor. Answers may contain model-generated questions, so the row remains
-- private to the learner.
create table if not exists public.quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lesson_id text not null references public.lessons(id) on delete cascade,
  mode text not null default 'quiz' check (mode in ('quiz', 'exam', 'interview')),
  position_seconds double precision not null default 0 check (position_seconds >= 0),
  questions jsonb not null default '[]'::jsonb,
  answers jsonb not null default '[]'::jsonb,
  score integer check (score is null or (score >= 0 and score <= 100)),
  feedback text,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists quiz_attempts_owner
  on public.quiz_attempts(user_id, lesson_id, created_at desc);

alter table public.quiz_attempts enable row level security;
grant select, insert, update, delete on public.quiz_attempts to authenticated;
grant all on public.quiz_attempts to service_role;

drop policy if exists "own quiz attempts" on public.quiz_attempts;
create policy "own quiz attempts"
  on public.quiz_attempts for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.lessons l
      where l.id = lesson_id and (l.is_demo or l.user_id = auth.uid())
    )
  );

-- Index ownership metadata is deliberately queryable so the application can
-- refuse to compare vectors from a different model/dimension/version.
comment on column public.resource_chunks.embedding_space_key is
  'Canonical provider:model:dimension:version key. Never compare vectors with different keys.';
