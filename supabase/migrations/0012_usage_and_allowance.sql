-- What each turn cost, and what is left of this month's allowance.
--
-- Three tables, and the important one is append-only. `usage_events` is the
-- record of spend, and it is built so that a user who fully controls their
-- client still cannot reduce it: they may INSERT their own rows with a
-- non-negative cost, and there is no UPDATE policy and no DELETE policy, so
-- both are denied outright. Forging gains nothing — the only thing a forged
-- row can do is spend more of your own allowance.
--
-- That is why this needs no service-role key and no shared secret. The Edge
-- Function goes on acting as the caller, exactly as it does for everything
-- else, and the security model in the README is unchanged.
--
-- What is deliberately NOT here: anything describing what the message said.
-- No content, no title, no conversation id, no category. A usage row knows the
-- model, the token counts, the cost and which message it paid for — and that
-- last link is `on delete set null`, so deleting a conversation destroys the
-- evidence of what was asked while the spend survives. Deleting your history
-- must not refund you.

-- --------------------------------------------------------------------------
-- Prices
-- --------------------------------------------------------------------------

-- A table rather than a constant in the function, for one reason: a wrong
-- price should be fixable with an UPDATE, not a deploy. Costs are computed at
-- the moment of use and frozen into usage_events, so editing a price here
-- changes what future turns cost and never rewrites history.
create table public.model_prices (
  model_id               text primary key,
  -- Micro-pounds per million tokens. Integers throughout: money in floating
  -- point accumulates error, and this gets summed over thousands of rows.
  input_micros_per_mtok  bigint not null check (input_micros_per_mtok >= 0),
  output_micros_per_mtok bigint not null check (output_micros_per_mtok >= 0),
  -- Where the number came from, so the next person can check it.
  note                   text,
  updated_at             timestamptz not null default now()
);

-- Real prices, converted to GBP at 1 USD = 0.74007 (11 September 2026).
--
-- Two things are baked in here and both will go stale. The exchange rate is a
-- snapshot, and a model's list price can change without anything in this repo
-- noticing. Costs are frozen into usage_events at the moment of use, so an
-- UPDATE here changes what future turns cost and never rewrites history.
--
-- A model with no row is charged nothing, which is the safe direction to be
-- wrong in: an unpriced model under-bills rather than locking someone out.
--
-- Dated caveats, worth a diary note:
--   * Gemini 3.8 Flash is on an INTRODUCTORY rate until 31 December 2026, and
--     doubles to $1.50/$7.50 on 1 January 2027. Nothing here will notice.
--   * Luna's long-context tier is $0.40/$1.80 rather than $0.20/$1.20. Fast
--     answers carry the whole history, so a long thread may be billed at the
--     higher rate while this row assumes the lower one.
--   * muse-spark-1.3 is the non-contributor variant (see the README), so it
--     takes standard pricing and not the contributor discount.
--   * Opus 5 fast mode is double. This app does not use it.
insert into public.model_prices (model_id, input_micros_per_mtok, output_micros_per_mtok, note) values
  ('claude-opus-5',    3700350, 18501750, '$5.00/$25.00 per Mtok, anthropic.com/research/claude-opus-5, 2026-09-12'),
  ('gemini-3.8-flash',  555052,  2775262, '$0.75/$3.75 INTRODUCTORY until 2026-12-31 then $1.50/$7.50, ai.google.dev/gemini-api/docs/pricing, 2026-09-12'),
  ('gpt-5.6-luna',      148014,   888084, '$0.20/$1.20 short-context, developers.openai.com/api/docs/pricing, 2026-09-12'),
  ('muse-spark-1.3',    925088,  3145298, '$1.25/$4.25 standard non-contributor, openrouter.ai/meta/muse-spark-1.3, 2026-09-12');

-- --------------------------------------------------------------------------
-- Spend
-- --------------------------------------------------------------------------

create table public.usage_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- Set null, NOT cascade. The message may be deleted; the money was still
  -- spent. This column is the only thing tying a cost to anything, and losing
  -- it is the intended outcome of deleting a conversation.
  message_id    uuid references public.messages (id) on delete set null,
  -- Every model call is a row: the routing classifier, the reply, and each
  -- leg of a tool loop. A twenty-leg turn is twenty-one rows, which is the
  -- point — it is the only way the cost of a loop is visible at all.
  kind          text not null check (kind in ('classify', 'reply', 'tool_leg')),
  model_id      text not null,
  input_tokens  integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  -- Frozen at the moment of use from model_prices. Never recomputed.
  cost_micros   bigint not null default 0 check (cost_micros >= 0),
  occurred_at   timestamptz not null default now()
);

-- Every read is "this user, this month", so the index matches it exactly.
create index usage_events_user_time_idx
  on public.usage_events (user_id, occurred_at desc);

-- --------------------------------------------------------------------------
-- Allowance
-- --------------------------------------------------------------------------

-- One row per user, and a row is optional: a user without one gets the default
-- below. Nothing in the app writes this table — an allowance is changed from
-- the dashboard, which is what keeps it out of reach of the client.
create table public.allowances (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  grant_micros bigint not null check (grant_micros >= 0),
  updated_at   timestamptz not null default now()
);

-- £5.00 a month. Deliberately generous while usage_events is empty: nobody
-- yet knows whether a real tool loop costs pennies or pounds, and the honest
-- way to find out is to measure for a month rather than guess now.
create or replace function public.default_grant_micros()
returns bigint language sql immutable as $$ select 5000000::bigint $$;

-- --------------------------------------------------------------------------
-- The balance
-- --------------------------------------------------------------------------

-- Computed, never stored. There is no scheduled job to refill anything and no
-- running total to drift out of step: the month boundary is arithmetic on
-- occurred_at, so the answer is correct after the app has sat unused for a
-- year, and correct the instant the clock passes midnight on the first.
--
-- security invoker, so RLS still applies and auth.uid() is the caller. A user
-- reading this function can only ever see their own spend.
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
  with period as (
    select (date_trunc('month', (now() at time zone 'utc')) at time zone 'utc') as started_at
  ),
  allowed as (
    select coalesce(
      (select a.grant_micros from public.allowances a where a.user_id = (select auth.uid())),
      public.default_grant_micros()
    ) as granted
  ),
  used as (
    select coalesce(sum(u.cost_micros), 0)::bigint as spent
    from public.usage_events u, period p
    where u.user_id = (select auth.uid())
      and u.occurred_at >= p.started_at
  )
  select
    allowed.granted,
    used.spent,
    allowed.granted - used.spent,
    (select started_at + interval '1 month' from period)
  from allowed, used;
$$;

-- --------------------------------------------------------------------------
-- Access
-- --------------------------------------------------------------------------

alter table public.usage_events  enable row level security;
alter table public.allowances    enable row level security;
alter table public.model_prices  enable row level security;

revoke all on public.usage_events from anon;
revoke all on public.allowances   from anon;
revoke all on public.model_prices from anon;

-- Read your own spend.
create policy usage_events_select_own on public.usage_events
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Add to your own spend, and only add. The check that cost is non-negative is
-- on the column as well as implied here; between that and the absence of any
-- update or delete policy, the worst a forged insert can do is cost its author
-- more of their own allowance.
create policy usage_events_insert_own on public.usage_events
  for insert to authenticated
  with check (user_id = (select auth.uid()) and cost_micros >= 0);

-- No update policy and no delete policy, on purpose. Both are denied.

-- Read your own allowance. Writes are dashboard-only.
create policy allowances_select_own on public.allowances
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Prices are not secret — the client never uses them, but hiding them buys
-- nothing and a user ought to be able to see what they are being charged.
create policy model_prices_select on public.model_prices
  for select to authenticated
  using (true);

grant execute on function public.allowance_status() to authenticated;
grant execute on function public.default_grant_micros() to authenticated;
