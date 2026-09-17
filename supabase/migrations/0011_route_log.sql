-- Make conversation_routes describe what routing now is.
--
-- 0006 built it to pin a conversation to one model, decided from its first
-- message. That concept was removed on 2026-09-09 when routing moved to a
-- fresh decision for every message, and nothing has written the table since —
-- the last writer went with it. What is left is a table shaped around a
-- question the app no longer asks.
--
-- It becomes a log instead: one row per assistant reply, recording what the
-- classifier judged and where the turn went. That is not what messages.model_id
-- already stores. model_id says which model answered; this says why — the
-- category, whether a classifier produced it or it was a default, and whether
-- the turn was given the user's folder. When a reply comes back on the wrong
-- model, that difference is the whole diagnosis.
--
-- The 0006 backfill rows are kept and left with a null message_id. They were
-- invented by that migration — every pre-existing conversation was written down
-- as 'other'/muse-spark-1.3 without anything being classified — so a null
-- message_id here means "not a real decision", and the log can be read without
-- believing them. They are safe to delete whenever you want them gone.

-- One row per reply, so the conversation can no longer be the key.
alter table public.conversation_routes
  drop constraint conversation_routes_pkey;

alter table public.conversation_routes
  add column id uuid primary key default gen_random_uuid(),
  add column message_id uuid unique references public.messages (id) on delete cascade,
  add column effort text check (effort in ('fast', 'medium', 'max')),
  add column needs_tools boolean not null default false,
  -- False covers both "the classifier errored" and "Fast, which does not ask".
  -- Without it a fallback is indistinguishable from a verdict, which is the
  -- one thing you are reading this table to tell apart.
  add column classified boolean not null default true;

-- 'tools' is not a subject like the others. It is the answer to the extra
-- question asked when a working folder is open: does this turn need the files?
alter table public.conversation_routes
  drop constraint if exists conversation_routes_category_check;

alter table public.conversation_routes
  add constraint conversation_routes_category_check
  check (category in ('finance', 'coding', 'healthcare', 'other', 'tools'));

-- The Edge Function writes this as the caller, forwarding their JWT, so the
-- insert has to be granted rather than done with a service-role key. The
-- previous writer used one; the security model says none is used anywhere, and
-- that should stay true.
--
-- What this lets someone do is write route rows against their own
-- conversations. Nothing reads the table to make a decision — it is a record of
-- decisions already taken — so a forged row misleads only its author.
grant insert on public.conversation_routes to authenticated;

create policy conversation_routes_insert on public.conversation_routes
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

-- The log is read by conversation, newest first. The 0006 index is on
-- (user_id, created_at) and does not serve that.
create index conversation_routes_conversation_idx
  on public.conversation_routes (conversation_id, created_at desc);
