-- Private file storage for learner-uploaded resources.
--
-- Files are stored under "<auth.uid()>/<resource-id>.<ext>" in a private
-- bucket. RLS on storage.objects enforces that a learner can only touch their
-- own folder, so a guessed object path is not enough to read another learner's
-- source document. The extracted text and vectors live in public.resource_chunks
-- and inherit the same ownership checks.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'learning-resources',
  'learning-resources',
  false,
  10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/markdown',
    'text/vtt',
    'application/x-subrip',
    'application/json',
    'text/csv',
    'text/x-python',
    'application/typescript',
    'text/javascript'
  ]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "owners read their resource files" on storage.objects;
create policy "owners read their resource files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'learning-resources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owners upload their resource files" on storage.objects;
create policy "owners upload their resource files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'learning-resources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owners replace their resource files" on storage.objects;
create policy "owners replace their resource files"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'learning-resources'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'learning-resources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owners delete their resource files" on storage.objects;
create policy "owners delete their resource files"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'learning-resources'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
