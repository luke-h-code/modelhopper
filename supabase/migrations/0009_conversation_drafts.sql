-- A conversation exists from the moment it is opened, but stays out of the
-- sidebar until the reader actually sends something.
--
-- Opening a chat has to write the row: attachments and messages both reference
-- conversation_id, so an upload or a send needs something to point at. What
-- was wrong before was showing every one of those rows in the history, so
-- clicking "New conversation" and changing your mind left a permanent, empty
-- entry. The flag separates "exists" from "worth listing".
--
-- Everything that already exists has been used, so it is not a draft.

alter table public.conversations
  add column is_draft boolean not null default true;

update public.conversations set is_draft = false;

-- The sidebar reads exactly this shape: one user's non-draft conversations,
-- newest first. Partial, so the drafts nobody lists cost nothing to skip.
create index conversations_listed_idx
  on public.conversations (user_id, updated_at desc)
  where not is_draft;

-- No column-level grant is implied. RLS here is row-level, so the owner can
-- set this flag on their own rows directly — which only decides whether a row
-- appears in that same person's own sidebar, and is not worth defending.
