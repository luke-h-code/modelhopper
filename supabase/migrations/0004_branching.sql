-- Message branching.
--
-- Until now a conversation was a flat list ordered by created_at, which is why
-- edit and regenerate were not offered: both produce a TREE (one parent, many
-- children), and a flat list cannot represent one. Replaying a flat list after
-- an edit would show the reader both versions of their message and both
-- replies, and — worse — would feed both to the model on the next turn.
--
-- parent_id makes the tree explicit. A "branch" is then just a path from a
-- root message down to a leaf.

alter table public.messages
  add column parent_id uuid references public.messages (id) on delete cascade;

comment on column public.messages.parent_id is
  'The message this one replies to. Null for the first message in a thread. '
  'Siblings sharing a parent are alternative branches (an edit or a regenerate).';

-- Backfill: every existing conversation is linear, so each message''s parent is
-- simply the one before it. Ties on created_at are broken by id so the chain is
-- deterministic rather than dependent on scan order.
with ordered as (
  select
    id,
    lag(id) over (
      partition by conversation_id
      order by created_at, id
    ) as prev
  from public.messages
)
update public.messages m
set parent_id = ordered.prev
from ordered
where m.id = ordered.id
  and ordered.prev is not null;

-- Supports both the FK's cascade check and finding a message's children.
create index messages_parent_id_idx
  on public.messages (parent_id)
  where parent_id is not null;

-- A parent in a different conversation would let one thread's history leak into
-- another's prompt. The Edge Function never does this, but the RLS policies do
-- permit a client to insert message rows directly, so this is enforced in the
-- database rather than trusted to the caller.
create or replace function public.check_message_parent()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.parent_id is not null then
    -- security invoker means this select is itself RLS-filtered, so a parent
    -- the caller cannot see is treated as one that does not exist.
    if not exists (
      select 1
      from public.messages p
      where p.id = new.parent_id
        and p.conversation_id = new.conversation_id
    ) then
      raise exception 'parent message must belong to the same conversation';
    end if;
  end if;
  return new;
end;
$$;

create trigger messages_check_parent
  before insert or update of parent_id on public.messages
  for each row
  execute function public.check_message_parent();

-- Walk from a leaf up to the root, returning the branch oldest-first.
--
-- This replaces "the last N rows by created_at" as the way history is built.
-- After an edit those are not the same thing: created_at order interleaves
-- sibling branches, while the ancestor path is the one conversation the reader
-- is actually looking at.
create or replace function public.message_ancestors(
  leaf uuid,
  max_depth int default 40
)
returns table (
  id uuid,
  role text,
  content jsonb,
  created_at timestamptz,
  parent_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive chain as (
    select m.id, m.role, m.content, m.created_at, m.parent_id, 1 as depth
    from public.messages m
    where m.id = leaf

    union all

    select p.id, p.role, p.content, p.created_at, p.parent_id, c.depth + 1
    from public.messages p
    join chain c on p.id = c.parent_id
    where c.depth < max_depth
  )
  select chain.id, chain.role, chain.content, chain.created_at, chain.parent_id
  from chain
  order by depth desc;
$$;

revoke all on function public.message_ancestors(uuid, int) from public, anon;
grant execute on function public.message_ancestors(uuid, int) to authenticated;
