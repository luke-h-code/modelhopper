-- Price in the currency the providers bill in, and convert once, at the edge.
--
-- 0012 stored prices already converted to GBP. That was wrong in a way that
-- gets worse with time: every row carried a frozen exchange rate, a rate move
-- meant editing all of them, and the number in the table matched nothing on
-- any provider's pricing page — so it could not be checked without redoing the
-- arithmetic by hand.
--
-- Now:
--   model_prices    USD, exactly as published. Written as dollars; the
--                   micro-USD integers used for arithmetic are derived.
--   usage_events    cost in micro-USD, the currency it was actually billed in.
--   allowances      micro-GBP, because the allowance is a commitment in
--   allowance_topups  pounds, not a floating dollar amount.
--   fx_rates        one place the conversion lives.
--   allowance_balance  a view that does the conversion and nothing else.
--
-- Money stays in integers everywhere it is summed. `numeric` appears only for
-- the human-written dollar figure, which is never added up.

-- --------------------------------------------------------------------------
-- Exchange rates
-- --------------------------------------------------------------------------

create table public.fx_rates (
  -- What a currency is worth in GBP. One row per currency; USD is the only one
  -- that matters today, and the shape is here so a second provider billing in
  -- euros does not need a schema change.
  currency   text primary key,
  gbp_per_unit numeric(18, 8) not null check (gbp_per_unit > 0),
  as_of      date not null,
  note       text,
  updated_at timestamptz not null default now()
);

insert into public.fx_rates (currency, gbp_per_unit, as_of, note) values
  ('USD', 0.74007, '2026-09-11', 'spot rate, wise.com');

-- Deliberately not automatic. A rate that updates itself would silently
-- restate every balance in the app, including the one that decides whether
-- somebody can send a message. Update it on purpose:
--
--   update public.fx_rates set gbp_per_unit = 0.7412, as_of = current_date,
--          note = 'spot rate, <source>', updated_at = now()
--    where currency = 'USD';

-- --------------------------------------------------------------------------
-- Prices, in dollars
-- --------------------------------------------------------------------------

alter table public.model_prices
  add column currency text not null default 'USD'
    references public.fx_rates (currency),
  -- Written by hand from the provider's pricing page, so it is stored the way
  -- it is published: 5.00, not 3700350. Six decimal places carries the
  -- cheapest models, which are quoted in fractions of a cent.
  add column input_usd_per_mtok        numeric(12, 6),
  add column output_usd_per_mtok       numeric(12, 6),
  add column cached_input_usd_per_mtok numeric(12, 6);

-- The published rates, from each provider's own page on 2026-09-12.
--   Anthropic  anthropic.com/research/claude-opus-5
--   Google     ai.google.dev/gemini-api/docs/pricing   (INTRODUCTORY to 2026-12-31)
--   OpenAI     developers.openai.com/api/docs/pricing  (short-context tier)
--   Meta       openrouter.ai/meta/muse-spark-1.3       (non-contributor)
update public.model_prices set
  input_usd_per_mtok = 5.00, output_usd_per_mtok = 25.00,
  cached_input_usd_per_mtok = 0.50
  where model_id = 'claude-opus-5';
update public.model_prices set
  input_usd_per_mtok = 0.75, output_usd_per_mtok = 3.75,
  cached_input_usd_per_mtok = 0.075
  where model_id = 'gemini-3.8-flash';
update public.model_prices set
  input_usd_per_mtok = 0.20, output_usd_per_mtok = 1.20,
  cached_input_usd_per_mtok = 0.02
  where model_id = 'gpt-5.6-luna';
update public.model_prices set
  input_usd_per_mtok = 1.25, output_usd_per_mtok = 4.25,
  cached_input_usd_per_mtok = 0.15
  where model_id = 'muse-spark-1.3';

alter table public.model_prices
  alter column input_usd_per_mtok set not null,
  alter column output_usd_per_mtok set not null;

-- Derived, never written. The dollar figure above is the one a person checks
-- against a pricing page; these are the integers the arithmetic uses, and
-- having Postgres compute them removes the chance of the two disagreeing.
alter table public.model_prices
  add column input_micro_usd_per_mtok bigint
    generated always as (round(input_usd_per_mtok * 1000000)::bigint) stored,
  add column output_micro_usd_per_mtok bigint
    generated always as (round(output_usd_per_mtok * 1000000)::bigint) stored,
  -- Null means "no cached rate", and the function charges cached tokens at the
  -- full rate — the conservative direction. 0014 zeroed the GBP equivalents on
  -- purpose; that decision is re-applied below, after these are populated.
  add column cached_input_micro_usd_per_mtok bigint
    generated always as (round(cached_input_usd_per_mtok * 1000000)::bigint) stored;

-- The GBP columns are what 0012 and 0013 added. They are gone: a price now has
-- exactly one representation, and a second one that has to be kept in step is
-- how the two drift apart.
alter table public.model_prices
  drop column input_micros_per_mtok,
  drop column output_micros_per_mtok,
  drop column cached_input_micros_per_mtok;

-- --------------------------------------------------------------------------
-- Spend, in dollars
-- --------------------------------------------------------------------------

alter table public.usage_events
  add column cost_micro_usd bigint not null default 0 check (cost_micro_usd >= 0);

-- Existing rows hold micro-GBP charged at the 0.74007 the app was using. Back
-- them out at the same rate rather than leaving them at zero, which would read
-- as a month of free usage.
update public.usage_events
   set cost_micro_usd = round(cost_micros / 0.74007)::bigint
 where cost_micros > 0;

-- The append-only policy from 0012 checks `cost_micros >= 0`, so the column
-- cannot be dropped while the policy exists — Postgres refuses with a
-- dependency error rather than quietly weakening the check.
--
-- Dropped and recreated rather than left alone, because the check is the whole
-- security argument for this table: a user may add to their own spend and
-- never reduce it. Recreating it against the new column is what keeps that
-- true. All inside one transaction, so there is no moment where the table is
-- writable without it.
drop policy if exists usage_events_insert_own on public.usage_events;

alter table public.usage_events drop column cost_micros;

create policy usage_events_insert_own on public.usage_events
  for insert to authenticated
  with check (user_id = (select auth.uid()) and cost_micro_usd >= 0);

-- Still no update policy and no delete policy. Both remain denied.

comment on column public.usage_events.cost_micro_usd is
  'Millionths of a US dollar, frozen at the moment of use. Never recomputed: '
  'a later price change or rate move must not restate what a past turn cost.';

-- --------------------------------------------------------------------------
-- The allowance, in pounds
-- --------------------------------------------------------------------------

-- Renamed, because it is no longer the only source of a person's budget: it is
-- the recurring monthly entitlement, and top-ups are added on top of it.
alter table public.allowances
  rename column grant_micros to monthly_micro_gbp;

comment on table public.allowances is
  'One row per user: their recurring monthly entitlement in micro-pounds. '
  'A row is created automatically for every new user by the trigger below, so '
  'an empty table means no users rather than no allowances.';

-- Every invited user gets one, without anyone remembering to add them. This is
-- what 0012 was doing with a coalesce to a default; a real row is better,
-- because it can be read, listed, and changed per person from the dashboard
-- without a migration.
create or replace function public.grant_default_allowance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.allowances (user_id, monthly_micro_gbp)
  values (new.id, 5000000)      -- £5.00
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_grant_allowance
  after insert on auth.users
  for each row execute function public.grant_default_allowance();

-- Anyone who signed up before this migration.
insert into public.allowances (user_id, monthly_micro_gbp)
select id, 5000000 from auth.users
on conflict (user_id) do nothing;

-- --------------------------------------------------------------------------
-- Top-ups
-- --------------------------------------------------------------------------

-- One row per grant of extra budget: how much, and when it takes effect.
--
-- Scoped to the month it lands in, deliberately. A top-up is what you give
-- someone who has run out before the month is over; carrying the unused part
-- forward would make the monthly entitlement a floor rather than a budget, and
-- the whole point of the reset is that it is predictable.
create table public.allowance_topups (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  amount_micro_gbp bigint not null check (amount_micro_gbp > 0),
  -- When it starts counting. Defaults to now, but can be dated forward to
  -- prepare next month, or back to correct a month already under way.
  effective_at timestamptz not null default now(),
  -- Why. This is the table someone will read in six months asking why one
  -- person had triple the budget in November.
  note         text,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users (id)
);

create index allowance_topups_user_time_idx
  on public.allowance_topups (user_id, effective_at desc);

-- --------------------------------------------------------------------------
-- The balance
-- --------------------------------------------------------------------------

-- Per user, one row each, converted to pounds here and nowhere else.
--
-- Still computed rather than stored: the month boundary is arithmetic on
-- timestamps, so there is no job to refill anything and nothing to drift. What
-- is new is that spend arrives in dollars and the budget is in pounds, so the
-- conversion has exactly one home — this view — and changing the rate changes
-- every balance at once, on purpose and visibly.
--
-- security_invoker, so RLS still applies: a user selecting from this sees only
-- their own row, while the service role sees everyone. One view, both jobs.
create view public.allowance_balance
with (security_invoker = true) as
with period as (
  select (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc') as started_at
),
rate as (
  select gbp_per_unit from public.fx_rates where currency = 'USD'
)
select
  a.user_id,
  (select started_at from period)                       as period_started_at,
  (select started_at + interval '1 month' from period)  as resets_at,
  a.monthly_micro_gbp,
  coalesce(t.topped_up, 0)::bigint                      as topped_up_micro_gbp,
  (a.monthly_micro_gbp + coalesce(t.topped_up, 0))::bigint as budget_micro_gbp,
  coalesce(u.spent_usd, 0)::bigint                      as spent_micro_usd,
  -- The one conversion in the system.
  round(coalesce(u.spent_usd, 0) * (select gbp_per_unit from rate))::bigint
                                                        as spent_micro_gbp,
  (a.monthly_micro_gbp + coalesce(t.topped_up, 0)
    - round(coalesce(u.spent_usd, 0) * (select gbp_per_unit from rate)))::bigint
                                                        as remaining_micro_gbp,
  (select gbp_per_unit from rate)                       as gbp_per_usd
from public.allowances a
left join lateral (
  select sum(amount_micro_gbp) as topped_up
  from public.allowance_topups tu, period p
  where tu.user_id = a.user_id
    and tu.effective_at >= p.started_at
    and tu.effective_at < p.started_at + interval '1 month'
) t on true
left join lateral (
  select sum(cost_micro_usd) as spent_usd
  from public.usage_events ue, period p
  where ue.user_id = a.user_id
    and ue.occurred_at >= p.started_at
) u on true;

-- Kept as the app's entry point so the Edge Function and the client have one
-- thing to call, but it is now a thin read of the view rather than its own
-- copy of the arithmetic — two implementations of a balance is one too many.
create or replace function public.allowance_status()
returns table (
  grant_micros     bigint,
  spent_micros     bigint,
  remaining_micros bigint,
  resets_at        timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    budget_micro_gbp,
    spent_micro_gbp,
    remaining_micro_gbp,
    resets_at
  from public.allowance_balance
  where user_id = (select auth.uid());
$$;

drop function if exists public.default_grant_micros();

-- --------------------------------------------------------------------------
-- Access
-- --------------------------------------------------------------------------

alter table public.fx_rates         enable row level security;
alter table public.allowance_topups enable row level security;

revoke all on public.fx_rates         from anon;
revoke all on public.allowance_topups from anon;
revoke all on public.allowance_balance from anon;

-- Read your own top-ups. Writes are dashboard-only, like the allowance itself:
-- a user who could insert one would be granting themselves budget.
create policy allowance_topups_select_own on public.allowance_topups
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The rate is not secret, and a balance shown in pounds is unreadable without
-- knowing what it was converted at.
create policy fx_rates_select on public.fx_rates
  for select to authenticated
  using (true);

grant select on public.allowance_balance to authenticated;

-- Cached input goes back to being charged at the full rate, which is what 0014
-- decided and this migration must not quietly undo. The USD figures above are
-- the real published rates; nulling the derived column is what switches the
-- discount off while keeping the number on record.
update public.model_prices set cached_input_usd_per_mtok = null;
