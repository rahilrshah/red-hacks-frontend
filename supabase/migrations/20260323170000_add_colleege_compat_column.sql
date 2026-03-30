ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS colleege TEXT;

UPDATE public.profiles
SET colleege = college
WHERE colleege IS NULL AND college IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_profile_college_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.college IS NULL AND NEW.colleege IS NOT NULL THEN
    NEW.college := NEW.colleege;
  ELSIF NEW.colleege IS NULL AND NEW.college IS NOT NULL THEN
    NEW.colleege := NEW.college;
  ELSIF NEW.college IS NOT NULL AND NEW.colleege IS NOT NULL AND NEW.college <> NEW.colleege THEN
    NEW.colleege := NEW.college;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_profile_college_columns ON public.profiles;

CREATE TRIGGER trigger_sync_profile_college_columns
BEFORE INSERT OR UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.sync_profile_college_columns();

NOTIFY pgrst, 'reload schema';
