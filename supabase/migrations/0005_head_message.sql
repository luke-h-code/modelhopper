-- Remember which branch the reader was last on.
--
-- 0004 made a conversation a tree, but reopening one always landed on the
-- branch holding the newest message. So switching to an earlier version of a
-- turn and reloading silently threw that choice away.
--
-- head_message_id records the leaf that was last being viewed. It is a hint,
-- not a constraint: if it is null, or names a message that has since been
-- deleted, the client falls back to the newest leaf.

alter table public.conversations
  add column head_message_id uuid
    references public.messages (id) on delete set null;

comment on column public.conversations.head_message_id is
  'Leaf of the branch last viewed. A hint for restoring the view; null means '
  'fall back to the newest message. Cleared automatically if that message is '
  'deleted.';

-- Backfill: the newest message in each conversation, which is exactly what the
-- client was already inferring.
update public.conversations c
set head_message_id = newest.id
from (
  select distinct on (conversation_id)
    conversation_id, id
  from public.messages
  order by conversation_id, created_at desc, id desc
) as newest
where c.id = newest.conversation_id;

-- Same reasoning as the messages.parent_id guard in 0004: a head pointing at
-- another conversation's message would restore the wrong thread, and RLS does
-- permit clients to update their own conversation rows directly.
create or replace function public.check_conversation_head()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.head_message_id is not null then
    if not exists (
      select 1
      from public.messages m
      where m.id = new.head_message_id
        and m.conversation_id = new.id
    ) then
      raise exception 'head_message_id must belong to this conversation';
    end if;
  end if;
  return new;
end;
$$;

create trigger conversations_check_head
  before insert or update of head_message_id on public.conversations
  for each row
  execute function public.check_conversation_head();
