-- Budget: a fifth provider slot, and the effort level that only ever reaches it.
--
-- The slot is called 'compat' rather than after any vendor: it is an
-- OpenAI-compatible endpoint, configured by COMPAT_BASE_URL, COMPAT_API_KEY
-- and COMPAT_MODEL_ID. DeepSeek on DeepInfra is the default those three ship
-- with, which is why the price row below names that model, and nothing more
-- than a default.
--
-- The effort control used to offer Thinking · Medium and Thinking · Max, which
-- routed identically and differed only in how hard each provider was asked to
-- think. Medium is now Budget and does not route at all: every Budget turn
-- goes to one configured model whatever the subject, which is the point of
-- it. Max kept the classifier and the whole routing table unchanged.
--
-- The stored effort value is still 'medium'. Renaming it would mean rewriting
-- every message ever sent and the check constraint in 0007, to change a word
-- that only ever appears in the interface — so the rename stopped at the
-- label. 'medium' on a row means Budget; there is no other reading of it,
-- because nothing else has ever written that value.

-- --------------------------------------------------------------------------
-- A fifth provider
-- --------------------------------------------------------------------------

-- Without this every Budget turn routes correctly, answers correctly, and then
-- fails to write its route row — the failure lands after the reader already
-- has their reply, which is the hardest kind to notice.
alter table public.conversation_routes
  drop constraint if exists conversation_routes_provider_check;

alter table public.conversation_routes
  add constraint conversation_routes_provider_check
  check (provider in ('openai', 'google', 'anthropic', 'meta', 'compat'));

-- Existing rows are untouched, as in 0008: a conversation stays pinned to the
-- model that has been answering it. Budget applies to turns sent from now on.

-- --------------------------------------------------------------------------
-- What it costs
-- --------------------------------------------------------------------------

-- A model with no row here is billed at zero (see `prices()` in index.ts,
-- which fails toward charging nothing so a price lookup cannot block a turn).
-- That is the right way to fail for an outage and the wrong way to launch a
-- whole effort level: Budget spend would simply not appear in anyone's
-- allowance or breakdown.
--
-- The rates below are DeepInfra's published prices for this model, read off
-- its page on 2026-09-13. They are the serverless rates, which is what this
-- app pays: a dedicated deployment is billed per GPU-hour instead, and none of
-- the arithmetic here would describe it.
--
-- Cheapest row in the table by a distance, which is the whole argument for
-- Budget existing: $0.20/$0.60 against Opus at $5.00/$25.00 is about a
-- fortieth of the output cost.
insert into public.model_prices (
  model_id,
  input_usd_per_mtok,
  output_usd_per_mtok,
  -- $0.006 against $0.20 standard: a thirty-third of the rate, the steepest
  -- cache discount of any model in this table. Leaving it null would not have
  -- failed anything — 0016 bills cached tokens at the full rate when there is
  -- no cached rate — it would simply have over-billed every cached Budget
  -- token by that factor, quietly and forever.
  cached_input_usd_per_mtok,
  display_name,
  note
) values (
  'deepseek-ai/DeepSeek-V4.1-Flash',
  0.20,
  0.60,
  0.006,
  -- Must match modelName() in the client, which is what the badge shows while
  -- a reply is still streaming. Two names for one model is what 0018 exists to
  -- prevent, so if one moves, move the other.
  'DeepSeek V4.1 Flash',
  '$0.20/$0.60, cached in $0.006, serverless tier, deepinfra.com/deepseek-ai/DeepSeek-V4.1-Flash, 2026-09-13'
);
