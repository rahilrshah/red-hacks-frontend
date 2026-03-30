ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS college TEXT,
  ADD COLUMN IF NOT EXISTS graduation_year INT;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_graduation_year_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_graduation_year_check
  CHECK (
    graduation_year IS NULL
    OR graduation_year BETWEEN EXTRACT(YEAR FROM now())::INT - 10 AND EXTRACT(YEAR FROM now())::INT + 10
  );

-- Force PostgREST to refresh schema cache after migration.
NOTIFY pgrst, 'reload schema';
