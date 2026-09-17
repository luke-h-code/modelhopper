-- Private storage bucket for chat attachments.
--
-- Layout: chat-files/{user_id}/{conversation_id}/{uuid}
--
-- storage.foldername('a/b/c') returns ['a','b'], so segment [1] is the owner's
-- uid. Every policy below pins that segment to the caller, which makes the path
-- itself the authorisation check — a user cannot read, write, or even list an
-- object outside their own prefix.
--
-- The bucket is private, so there are no public object URLs at all. Downloads
-- require either the user's JWT or a short-lived signed URL.

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files', 'chat-files', false, 26214400)  -- 25 MiB
on conflict (id) do nothing;

create policy chat_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'chat-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy chat_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'chat-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy chat_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'chat-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'chat-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy chat_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'chat-files'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
