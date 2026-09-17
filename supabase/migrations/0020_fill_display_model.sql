-- Fill display_model in the database, not in the Edge Function.
--
-- 0019 had the function write the label on insert. That worked and then
-- quietly stopped: the migration ran, its backfill named every row that
-- existed, and the function was not redeployed — so every row written
-- afterwards had a null label and the breakdown filled up with "Unknown".
-- The data was fine; the only thing missing was a deploy.
--
-- The fix is not to remember the deploy. It is to put the rule somewhere a
-- deploy cannot miss. A trigger fills the column from the same two facts the
-- function was using — the kind of call, and the model's registry name — so a
-- client that has never heard of display_model still produces correctly
-- labelled rows, and the column cannot be null.
--
-- This does not weaken what 0017 and 0019 were for. `model_id` is still
-- revoked from `authenticated`, the view still reads only the label, and the
-- label is still decided before the row is visible to anybody. It is decided
-- by Postgres rather than by whatever happens to be deployed.

create or replace function public.fill_usage_display_model()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.display_model is null or new.display_model = '' then
    new.display_model := case
      -- Every routing call reads as one line, whatever ran it. Changing the
      -- classifier must not show up as one name leaving and another arriving.
      when new.kind = 'classify' then 'Classifier'
      -- The registry name, falling back to the id for a model nobody has
      -- named. A model with no row here also has no price, so it appears
      -- costing nothing — showing the id is how that gets noticed.
      else coalesce(
        (select p.display_name from public.model_prices p
          where p.model_id = new.model_id),
        new.model_id
      )
    end;
  end if;
  return new;
end;
$$;

-- BEFORE INSERT: the value has to be in place by the time the row lands, not
-- corrected afterwards, or a reader could see the null in between.
create trigger usage_events_fill_display_model
  before insert on public.usage_events
  for each row execute function public.fill_usage_display_model();

-- The rows written between 0019's backfill and this trigger.
update public.usage_events u
   set display_model = case
         when u.kind = 'classify' then 'Classifier'
         else coalesce(
           (select p.display_name from public.model_prices p
             where p.model_id = u.model_id),
           u.model_id
         )
       end
 where u.display_model is null or u.display_model = '';
