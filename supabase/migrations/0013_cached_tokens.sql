-- Bill cached input at the cached rate.
--
-- 0012 charged every input token at the full rate, which over-bills this app
-- badly and specifically. A tool loop resends the whole history on every leg,
-- and that repeated prefix is exactly what a provider's cache is for: Gemini
-- caches implicitly by default and discounts a hit by 90%. Twenty legs of the
-- same growing prefix is therefore mostly cache hits, priced as though none of
-- them were.
--
-- Measured, not assumed: one 20-leg Gemini run recorded 401,400 input tokens
-- and was billed £0.2762, while Google's own dashboard showed roughly £0.10
-- for the same work. That gap is ~85% of the input being cached.
--
-- Two buckets rather than three. Anthropic also charges 1.25x for the tokens
-- that CREATE a cache entry; those are folded in with full-rate input here,
-- which under-bills them slightly. It is theoretical today — this app sets no
-- cache_control breakpoints, so Anthropic caches nothing and reports zero.

alter table public.model_prices
  add column cached_input_micros_per_mtok bigint not null default 0
    check (cached_input_micros_per_mtok >= 0);

comment on column public.model_prices.cached_input_micros_per_mtok is
  'Micro-pounds per million input tokens served from the provider''s cache. '
  'Zero means "charge cached tokens at the full input rate", which is the safe '
  'default for a model whose cache behaviour is unknown.';

-- Same sources and the same 1 USD = 0.74007 as 0012.
--   Anthropic  cache read is 0.1x input  (up to 90% saving)
--   Gemini     implicit caching, on by default, 0.1x
--   OpenAI     cached input reads 0.1x
--   Meta       $0.15 per Mtok flat, against $1.25 standard
update public.model_prices set cached_input_micros_per_mtok = 370035
  where model_id = 'claude-opus-5';
update public.model_prices set cached_input_micros_per_mtok = 55505
  where model_id = 'gemini-3.8-flash';
update public.model_prices set cached_input_micros_per_mtok = 14801
  where model_id = 'gpt-5.6-luna';
update public.model_prices set cached_input_micros_per_mtok = 111010
  where model_id = 'muse-spark-1.3';

-- Tokens served from cache, split out from the ones charged in full.
--
-- `input_tokens` changes meaning slightly with this column: it is now the
-- tokens billed at the FULL rate, not every token in the prompt. The providers
-- disagree about which of those their own field means — Gemini and OpenAI
-- include cached tokens in the prompt total, Anthropic reports cache reads
-- separately — so the split is done when the stream is read, and what lands
-- here is already normalised.
alter table public.usage_events
  add column cached_input_tokens integer not null default 0
    check (cached_input_tokens >= 0);

comment on column public.usage_events.cached_input_tokens is
  'Input tokens served from the provider''s cache and billed at the cached '
  'rate. Rows written before this column existed have zero here and were '
  'charged in full — they are over-stated, not wrong in a way that can be '
  'recomputed, because the split was never recorded.';
