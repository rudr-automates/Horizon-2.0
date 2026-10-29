-- Ownership policies for the private "learning-resources" storage bucket.
--
-- PROVENANCE: this version was applied to the connected Horizon 2.0 project
-- (ozmarachwzpinryukupj) by the hosting platform on 2026-10-25 19:41:46 and the
-- SQL never landed in this repository. The four statements below were recovered
-- verbatim from
--   supabase_migrations.schema_migrations.statements where version = '20261025194146'
-- and are reproduced without edits so a fresh database reaches the same state as
-- the existing one. They are not a reconstruction or a paraphrase.
--
-- 20261026130000_resource_file_storage.sql later adds a second, identically
-- scoped set of policies under different names ("owners ... their resource
-- files"). Both sets are present in the connected project and both are equally
-- permissive on the owner's folder, so files apply cleanly in order on a fresh
-- database and the duplicate set is harmless. Do not delete either set while the
-- remote history claims they were applied.

create policy "own folder read" on storage.objects for select to authenticated using (bucket_id = 'learning-resources' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder upload" on storage.objects for insert to authenticated with check (bucket_id = 'learning-resources' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder update" on storage.objects for update to authenticated using (bucket_id = 'learning-resources' and (storage.foldername(name))[1] = auth.uid()::text) with check (bucket_id = 'learning-resources' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder delete" on storage.objects for delete to authenticated using (bucket_id = 'learning-resources' and (storage.foldername(name))[1] = auth.uid()::text);
