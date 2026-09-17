-- The folder a conversation's commands run in.
--
-- Per conversation rather than per account: the point of the folder is that it
-- scopes what a model can see, so "the quarterly model" and "the client deck"
-- should not share one. A conversation about a spreadsheet in ~/Documents/books
-- stays pointed there across restarts, and asking about a different project
-- means opening a different chat rather than repointing this one.
--
-- Null means "whatever the desktop shell offers as its default", which is
-- resolved on the machine rather than stored. That matters because this column
-- holds a path from one computer: the same account signed in on a second
-- machine will read a folder that may not exist there. The app treats a path
-- that does not resolve as an unset one and falls back, rather than failing the
-- turn — so a stale value is a smaller problem than a stored default would be.
--
-- Web sessions never read it. Tools exist only in the desktop shell, so in a
-- browser this column is inert.

alter table public.conversations
  add column tool_root text check (tool_root is null or length(tool_root) between 1 and 1024);

-- No column-level grant is implied; RLS here is row-level. The owner can
-- already update their own conversation rows (conversations_update, 0002), and
-- what they are updating is which of their own folders their own machine will
-- run their own approved commands in. The boundary that matters is enforced in
-- the desktop shell at execution time, not by this value being trustworthy.
