-- Widen the effort scale from medium/high to fast/medium/max.
--
-- The composer now offers "Fast" as the default and puts Medium and Max behind
-- a "Thinking" step, so the stored vocabulary has to match what the UI can
-- send. Existing 'high' rows become 'max', which is the level they meant.
--
-- 'max' is accepted and recorded here, but the Edge Function deliberately calls
-- the provider at medium while the setting is being tested — see providers.ts.
-- The column therefore records what the user ASKED for, not what was spent.

alter table public.messages
  drop constraint if exists messages_effort_check;

update public.messages
   set effort = 'max'
 where effort = 'high';

alter table public.messages
  add constraint messages_effort_check
  check (effort in ('fast', 'medium', 'max'));
