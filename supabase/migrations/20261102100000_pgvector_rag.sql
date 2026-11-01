-- Horizon: central PostgreSQL + pgvector retrieval layer.
--
-- Additive only. `public.lessons` remains the canonical video/content row (it
-- already stores owner, title, source, duration and processing state), so this
-- migration does not duplicate it. `public.videos` is a read-only projection of
-- that existing table plus its vector-index state.
--
-- The legacy 1024-d Jina index in `resource_chunks` is left untouched. The
-- tables below hold a separate Gemini embedding space (768-d) and are used by
-- the central RAG service. Both indexes can coexist during and after migration.

create extension if not exists vector with schema extensions;

create table if not exists public.video_indexes (
  lesson_id text primary key references public.lessons(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  chunk_count integer not null default 0 check (chunk_count >= 0),
  source_hash text,
  embedding_provider text,
  embedding_model text,
  embedding_dimension integer check (embedding_dimension is null or embedding_dimension = 768),
  embedding_space_key text,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.video_indexes enable row level security;
grant select on public.video_indexes to anon, authenticated;
grant insert, update, delete on public.video_indexes to authenticated;
grant all on public.video_indexes to service_role;

drop policy if exists "read video index of visible lessons" on public.video_indexes;
create policy "read video index of visible lessons"
  on public.video_indexes for select to anon, authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_id and (l.is_demo or l.user_id = auth.uid())
    )
  );

drop policy if exists "manage own video index" on public.video_indexes;
create policy "manage own video index"
  on public.video_indexes for all to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_id and l.user_id = auth.uid() and not l.is_demo
    )
  )
  with check (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_id and l.user_id = auth.uid() and not l.is_demo
    )
  );

drop trigger if exists touch_video_indexes on public.video_indexes;
create trigger touch_video_indexes
  before update on public.video_indexes
  for each row execute function public.touch_updated_at();

create table if not exists public.video_chunks (
  id uuid primary key default gen_random_uuid(),
  lesson_id text not null references public.lessons(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  text text not null check (length(trim(text)) > 0),
  start_seconds double precision not null check (start_seconds >= 0),
  end_seconds double precision not null check (end_seconds > start_seconds),
  embedding extensions.vector(768) not null,
  embedding_provider text not null,
  embedding_model text not null,
  embedding_dimension integer not null default 768 check (embedding_dimension = 768),
  embedding_space_key text not null,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lesson_id, chunk_index),
  check (extensions.vector_dims(embedding) = 768)
);

create index if not exists video_chunks_lesson_order
  on public.video_chunks(lesson_id, chunk_index);
create index if not exists video_chunks_lesson_window
  on public.video_chunks(lesson_id, end_seconds);
create index if not exists video_chunks_embedding_hnsw
  on public.video_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.video_chunks enable row level security;
grant select on public.video_chunks to anon, authenticated;
grant insert, update, delete on public.video_chunks to authenticated;
grant all on public.video_chunks to service_role;

drop policy if exists "read video chunks of visible lessons" on public.video_chunks;
create policy "read video chunks of visible lessons"
  on public.video_chunks for select to anon, authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_id and (l.is_demo or l.user_id = auth.uid())
    )
  );

drop policy if exists "manage own video chunks" on public.video_chunks;
create policy "manage own video chunks"
  on public.video_chunks for all to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_id and l.user_id = auth.uid() and not l.is_demo
    )
  )
  with check (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_id and l.user_id = auth.uid() and not l.is_demo
    )
  );

drop trigger if exists touch_video_chunks on public.video_chunks;
create trigger touch_video_chunks
  before update on public.video_chunks
  for each row execute function public.touch_updated_at();

-- Read-only compatibility projection for code that expects a `videos` table.
-- It does not store data; every column comes from the canonical rows above.
create or replace view public.videos
  with (security_invoker = true)
  as
  select
    l.id,
    l.user_id as owner_id,
    l.title,
    l.description,
    l.course_id,
    case
      when l.video_url like 'storage://%' then 'upload'
      when l.provider in ('youtube', 'vimeo') then l.provider
      else 'direct'
    end as source_type,
    l.video_url as source_url,
    case
      when l.video_url like 'storage://%'
        then regexp_replace(l.video_url, '^storage://[^/]+/', '')
      else null
    end as storage_path,
    l.duration_seconds,
    l.transcript_status,
    coalesce(vi.status, 'pending') as processing_status,
    vi.error as processing_error,
    vi.chunk_count,
    vi.indexed_at,
    l.is_demo,
    l.created_at,
    l.updated_at
  from public.lessons l
  left join public.video_indexes vi on vi.lesson_id = l.id;

grant select on public.videos to anon, authenticated;

-- Cosine similarity over 768-d Gemini embeddings. `security invoker` keeps RLS
-- on video_chunks in force: the caller only ever sees lessons they may read.
-- The position boundary is applied in SQL, so no prompt or client value can
-- widen it.
create or replace function public.match_video_chunks(
  query_embedding extensions.vector(768),
  target_lesson_id text,
  max_position_seconds double precision,
  match_count integer default 8
)
returns table (
  id uuid,
  lesson_id text,
  chunk_index integer,
  text text,
  start_seconds double precision,
  end_seconds double precision,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    c.lesson_id,
    c.chunk_index,
    c.text,
    c.start_seconds,
    c.end_seconds,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.video_chunks c
  where c.lesson_id = target_lesson_id
    and c.embedding is not null
    and max_position_seconds >= 0
    and c.end_seconds <= max_position_seconds
  order by c.embedding <=> query_embedding, c.chunk_index
  limit greatest(1, least(coalesce(match_count, 8), 50));
$$;

revoke all on function public.match_video_chunks(extensions.vector, text, double precision, integer) from public, anon;
grant execute on function public.match_video_chunks(extensions.vector, text, double precision, integer) to authenticated, service_role;

-- Chronological "covered so far" retrieval for summaries, explanations and
-- practice generation.
create or replace function public.list_covered_video_chunks(
  target_lesson_id text,
  max_position_seconds double precision,
  match_count integer default 12
)
returns table (
  id uuid,
  lesson_id text,
  chunk_index integer,
  text text,
  start_seconds double precision,
  end_seconds double precision,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    c.lesson_id,
    c.chunk_index,
    c.text,
    c.start_seconds,
    c.end_seconds,
    null::double precision as similarity
  from public.video_chunks c
  where c.lesson_id = target_lesson_id
    and max_position_seconds >= 0
    and c.end_seconds <= max_position_seconds
  order by c.end_seconds desc, c.chunk_index desc
  limit greatest(1, least(coalesce(match_count, 12), 50));
$$;

revoke all on function public.list_covered_video_chunks(text, double precision, integer) from public, anon;
grant execute on function public.list_covered_video_chunks(text, double precision, integer) to authenticated, service_role;

comment on table public.video_chunks is
  'Timestamped transcript chunks with 768-d Gemini embeddings for the central pgvector RAG pipeline.';
comment on table public.video_indexes is
  'Per-lesson vector index state. A lesson is RAG-ready only when status = ready and chunk_count > 0.';
comment on column public.video_chunks.embedding_space_key is
  'Canonical provider:model:dimension:version key. Never compare vectors with different keys.';
