-- Core chat schema.
--
-- Design notes:
--   * `messages.content` is JSONB holding an array of content parts, not a plain
--     string, so citations, tool calls, images and other structured parts can be
--     added later without a migration.
--   * `attachments.message_id` is nullable by necessity: a file is uploaded from
--     the composer before the message row exists. The /chat Edge Function links
--     the attachment to its message once that row is created.

create extension if not exists "pgcrypto";

create table public.conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'system')),
  content         jsonb not null,
  created_at      timestamptz not null default now()
);

create table public.attachments (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  message_id      uuid references public.messages (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  storage_path    text not null unique,
  filename        text not null,
  mime_type       text not null,
  size            bigint not null check (size >= 0),
  created_at      timestamptz not null default now()
);

-- Sidebar: a user's conversations, most recently active first.
create index conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

-- Thread: one conversation's messages in order.
create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at);

create index attachments_message_idx
  on public.attachments (message_id);

create index attachments_conversation_idx
  on public.attachments (conversation_id);

-- Keep `updated_at` accurate so the sidebar ordering means something.
create or replace function public.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set updated_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row
  execute function public.touch_conversation();
