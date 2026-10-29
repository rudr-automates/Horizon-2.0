-- Private storage for learner-uploaded lesson videos (MP4/WebM).
--
-- Videos live in their own private bucket so the 10 MB document limit and the
-- document MIME allowlist stay untouched. Objects are stored under
-- "<auth.uid()>/<lesson-id>.<ext>" and the four policies below confine every
-- operation to the owner's folder, matching the learning-resources bucket.
-- Playback resolves a storage:// reference to a short-lived signed URL.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lesson-videos',
  'lesson-videos',
  false,
  262144000,
  array['video/mp4', 'video/webm']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "owners read their lesson videos" on storage.objects;
create policy "owners read their lesson videos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'lesson-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owners upload their lesson videos" on storage.objects;
create policy "owners upload their lesson videos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'lesson-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owners replace their lesson videos" on storage.objects;
create policy "owners replace their lesson videos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'lesson-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'lesson-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "owners delete their lesson videos" on storage.objects;
create policy "owners delete their lesson videos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'lesson-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
