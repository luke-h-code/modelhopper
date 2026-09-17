-- Stop telling the client which model does the routing.
--
-- The spend breakdown grouped classifier calls under "Classifier" in the UI,
-- which is not the same as hiding them: the client was selecting `model_id`
-- straight out of `usage_events`, so the real id was in the response and the
-- label was cosmetic. Anyone with devtools could read it.
--
-- That matters because the classifier is an implementation detail in a way the
-- answering models are not. The README's security model already says the
-- client is told which model ANSWERED and never which key served it; which
-- model was used to decide the routing belongs on the same side of that line.
-- Swapping it for something cheaper, or self-hosted, should not be visible to
-- anyone using the app.
--
-- Two changes, and both are needed — either alone leaves a way through:
--
--   1. Column-level SELECT. `model_id` is revoked from `authenticated`
--      entirely, so no direct query can return it whatever the client asks
--      for. RLS restricts rows; this restricts columns, which RLS cannot.
--   2. A SECURITY DEFINER function that groups the rows and returns a label
--      instead of an id, masking the classifier and naming everything else.
--      It runs as the owner, so it can read the column nobody else can.

-- --------------------------------------------------------------------------
-- The column
-- --------------------------------------------------------------------------

revoke select on public.usage_events from authenticated;

-- Everything except model_id. Listed rather than granted wholesale so that a
-- column added later is invisible by default and has to be named here, which
-- is the right way round for a table that exists to record spending.
--
-- `cost_micro_usd` and `occurred_at` stay readable because the
-- `allowance_balance` view is security_invoker — it sums them AS the caller,
-- and would return an empty balance without them.
grant select (
  id,
  user_id,
  message_id,
  kind,
  input_tokens,
  cached_input_tokens,
  output_tokens,
  cost_micro_usd,
  occurred_at
) on public.usage_events to authenticated;

-- --------------------------------------------------------------------------
-- The breakdown
-- --------------------------------------------------------------------------

-- This month's spend, grouped, with the classifier's model masked.
--
-- A function rather than a view because it has to read a column its caller
-- cannot. SECURITY DEFINER runs it as the owner, which means the WHERE clause
-- below is the only thing keeping one user out of another's spending — so it
-- filters on auth.uid() and the search_path is pinned, both deliberately.
create or replace function public.spend_by_model()
returns table (
  label               text,
  is_classifier       boolean,
  calls               bigint,
  input_tokens        bigint,
  cached_input_tokens bigint,
  output_tokens       bigint,
  cost_micro_usd      bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    -- One line for every routing call, whatever ran it. Grouping on the label
    -- rather than the id is what merges two different classifier models into
    -- one row, so changing the classifier does not show up as the old name
    -- disappearing and a new one arriving.
    case when u.kind = 'classify' then 'classifier' else u.model_id end as label,
    u.kind = 'classify'                                                as is_classifier,
    count(*)                                                           as calls,
    coalesce(sum(u.input_tokens), 0)::bigint                           as input_tokens,
    coalesce(sum(u.cached_input_tokens), 0)::bigint                    as cached_input_tokens,
    coalesce(sum(u.output_tokens), 0)::bigint                          as output_tokens,
    coalesce(sum(u.cost_micro_usd), 0)::bigint                         as cost_micro_usd
  from public.usage_events u
  where u.user_id = (select auth.uid())
    and u.occurred_at >= (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc')
  group by 1, 2
  order by 7 desc;
$$;

comment on function public.spend_by_model() is
  'This month''s spend for the calling user, grouped by model, with routing '
  'calls collapsed to the label "classifier". Runs as definer because it reads '
  'usage_events.model_id, which authenticated cannot select.';

grant execute on function public.spend_by_model() to authenticated;

-- A user with no rows gets no rows, which is the same answer as before.
