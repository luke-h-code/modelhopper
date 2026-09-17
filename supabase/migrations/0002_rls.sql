-- Row Level Security.
--
-- This file IS the access control for user data. The client is assumed to be
-- reverse-engineerable, so nothing here may depend on client-side checks.
--
-- Two rules, applied to every table:
--   1. A row is reachable only by its owner: user_id = auth.uid().
--   2. Rows that hang off a conversation additionally prove that the parent
--      conversation belongs to the caller, so a forged conversation_id fails
--      even though user_id would be set correctly.
--
-- `(select auth.uid())` rather than a bare `auth.uid()` so Postgres evaluates it
-- once per query instead of once per row.

alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
alter table public.attachments   enable row level security;

-- Anonymous callers have no business touching any of this. RLS alone would stop
-- them, but removing the grant means a future policy mistake cannot expose them.
revoke all on public.conversations from anon;
revoke all on public.messages      from anon;
revoke all on public.attachments   from anon;

-- Helper: does this conversation belong to the caller?
create or replace function public.owns_conversation(cid uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
      from public.conversations c
     where c.id = cid
       and c.user_id = (select auth.uid())
  );
$$;

-- conversations -------------------------------------------------------------

create policy conversations_select on public.conversations
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy conversations_insert on public.conversations
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy conversations_update on public.conversations
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy conversations_delete on public.conversations
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- messages ------------------------------------------------------------------

create policy messages_select on public.messages
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

create policy messages_insert on public.messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

create policy messages_update on public.messages
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

create policy messages_delete on public.messages
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

-- attachments ---------------------------------------------------------------

create policy attachments_select on public.attachments
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

create policy attachments_insert on public.attachments
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

create policy attachments_update on public.attachments
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  )
  with check (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

create policy attachments_delete on public.attachments
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );
