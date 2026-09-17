-- Widen routing from two categories to four, and from two providers to four.
--
-- 0006 shipped a finance/other split across Anthropic and Meta. The router now
-- classifies with an OpenAI model and sends finance to Google, coding and
-- healthcare to Anthropic, and everything else to Meta.
--
-- Existing rows are left exactly as they are: a conversation is pinned to the
-- model that has been answering it, and reclassifying old threads under the new
-- categories would silently change which model a reader is mid-conversation
-- with. They keep serving from Meta until the reader starts a new thread.

alter table public.conversation_routes
  drop constraint if exists conversation_routes_category_check;

alter table public.conversation_routes
  add constraint conversation_routes_category_check
  check (category in ('finance', 'coding', 'healthcare', 'other'));

alter table public.conversation_routes
  drop constraint if exists conversation_routes_provider_check;

alter table public.conversation_routes
  add constraint conversation_routes_provider_check
  check (provider in ('openai', 'google', 'anthropic', 'meta'));
