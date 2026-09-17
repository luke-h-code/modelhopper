-- Record when a turn was answered by a stand-in.
--
-- Routing now falls over to another provider rather than failing when the
-- chosen one will not answer — including on a 429, because somewhere with
-- capacity answering is better for the reader than a refusal.
--
-- That decision only holds if the failovers are counted. A rate limit and an
-- outage look identical from the reader's side and have opposite remedies:
-- one means this app is asking for more than its quota and should ask for a
-- bigger one, the other means the provider is down and there is nothing to do.
-- Without these columns, "we should ask Anthropic for a higher limit" is a
-- hunch; with them it is a number.
--
--   select fallback_from, fallback_reason, count(*)
--     from conversation_routes
--    where fallback_from is not null
--      and created_at > now() - interval '7 days'
--    group by 1, 2 order by 3 desc;

alter table public.conversation_routes
  -- The provider that SHOULD have answered, not the one that did — model_id
  -- already records the stand-in. Null on the ordinary case, which is what
  -- makes "where fallback_from is not null" the whole query.
  add column fallback_from text,
  add column fallback_reason text
    check (fallback_reason in ('rate_limit', 'error', 'timeout'));

comment on column public.conversation_routes.fallback_from is
  'Provider that failed, when this turn was answered by a stand-in. Null when '
  'the first choice answered.';
