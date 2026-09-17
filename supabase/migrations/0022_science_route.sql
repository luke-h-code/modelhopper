-- A science subject, and two models the routing table did not have before.
--
-- The point being demonstrated is that the subject picks the model, so the
-- three routes it is demonstrated with each go to a different lab: finance to
-- Gemini, science to GPT, coding to Fable. Healthcare stays on Opus, which is
-- also what makes the coding change visible — the two used to be the same
-- model and now are not.
--
-- All three are capped at low effort in ROUTES, whatever the reader chose.
-- That cap lives in the Edge Function rather than here because it changes what
-- one call asks for, not what the turn was: a capped Max turn is still stored
-- as Max, which is the truth about what was chosen and what picked the model.

-- --------------------------------------------------------------------------
-- The subject
-- --------------------------------------------------------------------------

-- Same failure this constraint had in 0008 and 0021: without it a science turn
-- routes correctly, answers correctly, and then fails to write its route row
-- — after the reader already has their reply, which is the hardest kind of
-- failure to notice.
alter table public.conversation_routes
  drop constraint if exists conversation_routes_category_check;

alter table public.conversation_routes
  add constraint conversation_routes_category_check
  check (category in ('finance', 'science', 'coding', 'healthcare', 'other', 'tools'));

-- The provider check already allows 'openai' — it has since 0021, because the
-- classifier has always been an OpenAI call. Nothing to widen there.

-- --------------------------------------------------------------------------
-- What the two new models cost
-- --------------------------------------------------------------------------

-- Without these rows both models answer normally and are recorded as free.
-- Nothing errors; the allowance meter simply stops counting, which is the
-- worst of both worlds on a route added to keep spend visible.
--
-- Cached input is left null on both, which 0016 reads as "bill it at the full
-- rate". That is the deliberate policy 0014 set and this migration is not the
-- place to revisit it — but the published cached rates are recorded in the
-- notes below so that flipping it later is a number lookup, not a re-research.
insert into public.model_prices (
  model_id,
  input_usd_per_mtok,
  output_usd_per_mtok,
  display_name,
  note
) values
  (
    'claude-fable-5-1',
    10.00,
    50.00,
    -- Must match modelName() in the client, which is what the badge shows
    -- while a reply is still streaming. The client learned to render a
    -- trailing "-5-1" as "5.1" for this row; two names for one model is what
    -- 0018 exists to prevent, so if one moves, move the other.
    'Claude Fable 5.1',
    '$10.00/$50.00 per Mtok, cached read $0.25, docs.claude.com pricing, 2026-09-17'
  ),
  (
    'gpt-6-astra',
    10.00,
    50.00,
    'GPT 6 Astra',
    '$10.00/$50.00 per Mtok short context, cached in $1.00, developers.openai.com/api/docs/pricing, 2026-09-17'
  )
on conflict (model_id) do update set
  input_usd_per_mtok  = excluded.input_usd_per_mtok,
  output_usd_per_mtok = excluded.output_usd_per_mtok,
  display_name        = excluded.display_name,
  note                = excluded.note,
  updated_at          = now();

-- Both are priced the same as each other and at twice Opus on input, ten times
-- on output against Budget. That is the argument for the effort cap: three
-- demonstration routes on premium models, each asked to think as little as the
-- question allows, because what is being shown is which model answers — not
-- how hard it thought.
