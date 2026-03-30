-- Keep `college` as the single source of truth.
UPDATE public.profiles
SET college = colleege
WHERE college IS NULL AND colleege IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_sync_profile_college_columns ON public.profiles;
DROP FUNCTION IF EXISTS public.sync_profile_college_columns();

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS colleege;

NOTIFY pgrst, 'reload schema';
