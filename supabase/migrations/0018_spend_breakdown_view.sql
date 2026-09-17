-- One view the client can read, with the work already done.
--
-- 0017 solved the disclosure problem with a SECURITY DEFINER function, which
-- worked but left the client doing three jobs that are not its own: turning
-- `gemini-3.8-flash` into `Gemini 3.8 Flash`, deciding that a classify row
-- should be labelled differently, and converting dollars to pounds. Every one
-- of those is a rule about the data, and rules about the data belong next to
-- the data — not least because a second client would otherwise have to
-- reimplement all three and get them subtly different.
--
-- A view rather than a function, because a view that is NOT security_invoker
-- already runs as its owner. That is the same privilege the definer function
-- borrowed: it can read `usage_events.model_id`, which `authenticated` cannot
-- select. The cost of that privilege is that the caller's RLS does not apply,
-- so the `where user_id = auth.uid()` below is the only thing standing between
-- one person's spending and another's. It is load-bearing, not a filter.

-- --------------------------------------------------------------------------
-- Display names
-- --------------------------------------------------------------------------

-- model_prices already lists every model the app knows how to bill, so it is
-- the registry. A name here is the one a person sees.
alter table public.model_prices add column display_name text;

-- These must match `modelName()` in the client, which is what the badge under
-- a reply uses while a turn is still streaming — before any of this is
-- readable. Two names for one model is the thing this whole change exists to
-- avoid, so if one moves, move the other.
update public.model_prices set display_name = 'Claude Opus 5'   where model_id = 'claude-opus-5';
update public.model_prices set display_name = 'Gemini 3.8 Flash' where model_id = 'gemini-3.8-flash';
update public.model_prices set display_name = 'GPT 5.6 Luna'     where model_id = 'gpt-5.6-luna';
update public.model_prices set display_name = 'Muse Spark 1.3'   where model_id = 'muse-spark-1.3';

-- --------------------------------------------------------------------------
-- The breakdown
-- --------------------------------------------------------------------------

create view public.spend_breakdown as
with period as (
  -- The calendar month, deliberately, and NOT a rolling 30 days. This has to
  -- add up to the allowance meter beside it, and the allowance resets on the
  -- 1st. A breakdown covering a different window than the balance it explains
  -- would disagree with it for eleven days out of twelve, and a total that
  -- does not reconcile is worse than no total at all.
  select (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc') as started_at
),
rate as (
  select gbp_per_unit from public.fx_rates where currency = 'USD'
)
select
  u.user_id,
  case
    when u.kind = 'classify' then 'Classifier'
    -- The registry name, falling back to the raw id for a model nobody has
    -- named yet. A model with no row here also has no price, so it appears
    -- costing nothing — showing the id is how that gets noticed.
    else coalesce(p.display_name, u.model_id)
  end                                                    as model,
  (u.kind = 'classify')                                  as is_classifier,
  count(*)                                               as calls,
  coalesce(sum(u.input_tokens), 0)::bigint               as input_tokens,
  coalesce(sum(u.cached_input_tokens), 0)::bigint        as cached_input_tokens,
  coalesce(sum(u.output_tokens), 0)::bigint              as output_tokens,
  coalesce(sum(u.cost_micro_usd), 0)::bigint             as cost_micro_usd,
  -- Converted here, at the same rate and in the same way as
  -- allowance_balance, so the rows sum to what the meter says was spent.
  round(coalesce(sum(u.cost_micro_usd), 0) * (select gbp_per_unit from rate))::bigint
                                                         as cost_micro_gbp
from public.usage_events u
left join public.model_prices p on p.model_id = u.model_id
cross join period
where u.user_id = (select auth.uid())
  and u.occurred_at >= period.started_at
-- Grouped on the LABEL, not the id: two different classifier models merge into
-- one row, so changing the classifier does not show up as one name vanishing
-- and another arriving.
group by u.user_id, 2, 3
order by 8 desc;

comment on view public.spend_breakdown is
  'This month''s spend for the calling user, grouped and named for display, '
  'with routing calls collapsed to "Classifier". Runs as owner so it can read '
  'usage_events.model_id, which authenticated cannot select — so the '
  'auth.uid() filter is the access control, not a convenience.';

revoke all on public.spend_breakdown from anon;
grant select on public.spend_breakdown to authenticated;

-- Superseded. Two implementations of the same breakdown is one too many, and
-- the one left is the one the client actually reads.
drop function if exists public.spend_by_model();
