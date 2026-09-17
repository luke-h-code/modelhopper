-- Lock each conversation to the model selected from its first message, while
-- retaining the model and effort that produced every assistant response.

create table public.conversation_routes (
  conversation_id    uuid primary key references public.conversations (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  category            text not null check (category in ('finance', 'other')),
  provider            text not null check (provider in ('anthropic', 'meta')),
  model_id            text not null,
  classifier_model_id text not null,
  created_at          timestamptz not null default now()
);

alter table public.messages
  add column model_id text,
  add column effort text check (effort in ('medium', 'high'));

-- Conversations created before routing existed keep the model that originally
-- served them rather than being reclassified from a later message.
insert into public.conversation_routes (
  conversation_id,
  user_id,
  category,
  provider,
  model_id,
  classifier_model_id
)
select id, user_id, 'other', 'meta', 'muse-spark-1.3', 'muse-spark-1.3'
from public.conversations;

alter table public.conversation_routes enable row level security;

revoke all on public.conversation_routes from anon;
revoke insert, update, delete on public.conversation_routes from authenticated;
grant select on public.conversation_routes to authenticated;

create policy conversation_routes_select on public.conversation_routes
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and public.owns_conversation(conversation_id)
  );

create index conversation_routes_user_idx
  on public.conversation_routes (user_id, created_at desc);
