-- Take the classifier's model off the read path entirely, and stop relying on
-- a definer view to hide it.
--
-- Two problems, found by taking Supabase's "Security definer view" warning
-- seriously rather than dismissing it as a false positive.
--
-- The first is that the warning is right about the shape even though it is
-- wrong about the exposure. `anon` is denied — verified — so nothing is
-- public. But `spend_breakdown` ran as its owner, which means RLS did not
-- apply and one `where user_id = auth.uid()` was the entire boundary between
-- one person's spending and another's. It was correct; it was also the only
-- thing that had to be.
--
-- The second is worse and was found while checking the first: 0006 grants
-- SELECT on `conversation_routes` to `authenticated`, and that table has a
-- `classifier_model_id` column. So the id that 0017 and 0018 went to some
-- trouble to hide was readable in one query the whole time, from a table
-- nobody had thought about since. Masking in one place is not masking.
--
-- The fix removes the need for the privilege rather than guarding it better:
-- the label is written when the row is written, the raw id is never on a
-- readable path, and ordinary RLS does the access control.

-- --------------------------------------------------------------------------
-- The route log is not for the client
-- --------------------------------------------------------------------------

-- It is a diagnostic log — "why did this turn go there" — read by whoever
-- operates the project, through SQL or the dashboard. No client code has ever
-- read it, so nothing is losing a capability it was using.
--
-- The insert grant stays: the Edge Function writes this as the caller, which
-- is what keeps it out of service-role territory.
revoke select on public.conversation_routes from authenticated;

-- --------------------------------------------------------------------------
-- The label, written once, at the source
-- --------------------------------------------------------------------------

alter table public.usage_events add column display_model text;

comment on column public.usage_events.display_model is
  'What this call is called in front of a person: a model''s display name, or '
  '"Classifier" for routing calls. Written at insert time so that reading a '
  'breakdown needs no privilege the reader should not have — model_id stays '
  'revoked from authenticated.';

-- Existing rows, named the same way the Edge Function will name new ones.
update public.usage_events u
   set display_model = case
         when u.kind = 'classify' then 'Classifier'
         else coalesce(p.display_name, u.model_id)
       end
  from public.model_prices p
 where p.model_id = u.model_id;

-- Rows for a model that has no price row at all, which the join above misses.
update public.usage_events
   set display_model = case when kind = 'classify' then 'Classifier' else model_id end
 where display_model is null;

-- Readable, unlike model_id. This is the whole point: the column a person can
-- see carries no information about which model does the routing.
grant select (display_model) on public.usage_events to authenticated;

-- --------------------------------------------------------------------------
-- The breakdown, without the privilege
-- --------------------------------------------------------------------------

drop view if exists public.spend_breakdown;

-- security_invoker this time. It reads only columns `authenticated` may read,
-- so the existing row policy on usage_events does the filtering and there is
-- no definer object in the schema at all. The `where user_id = auth.uid()` is
-- gone with it — not because it stopped mattering, but because RLS now says
-- the same thing in the one place it is enforced for every other table.
create view public.spend_breakdown
with (security_invoker = true) as
with period as (
  -- The calendar month, deliberately, and NOT a rolling 30 days: this has to
  -- reconcile with the allowance meter beside it, and that resets on the 1st.
  select (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc') as started_at
),
rate as (
  select gbp_per_unit from public.fx_rates where currency = 'USD'
)
select
  u.user_id,
  coalesce(u.display_model, 'Unknown')            as model,
  count(*)                                        as calls,
  coalesce(sum(u.input_tokens), 0)::bigint        as input_tokens,
  coalesce(sum(u.cached_input_tokens), 0)::bigint as cached_input_tokens,
  coalesce(sum(u.output_tokens), 0)::bigint       as output_tokens,
  coalesce(sum(u.cost_micro_usd), 0)::bigint      as cost_micro_usd,
  -- The same rate and the same rounding as allowance_balance, so the rows sum
  -- to what the meter says was spent.
  round(coalesce(sum(u.cost_micro_usd), 0) * (select gbp_per_unit from rate))::bigint
                                                  as cost_micro_gbp
from public.usage_events u
cross join period
where u.occurred_at >= period.started_at
-- Grouped on the label, so two different classifier models merge into one row
-- and changing the classifier is not visible as one name leaving and another
-- arriving.
group by u.user_id, 2
order by 7 desc;

comment on view public.spend_breakdown is
  'This month''s spend for the calling user, grouped and named for display. '
  'security_invoker: RLS on usage_events does the filtering, and the view '
  'reads no column authenticated may not select.';

revoke all on public.spend_breakdown from anon;
grant select on public.spend_breakdown to authenticated;
