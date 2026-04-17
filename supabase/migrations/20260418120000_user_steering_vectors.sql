-- Make steering_vectors user-authorable and add per-user quotas.
--
-- Before this migration, the table from 20260416120000_add_steering_vectors
-- was admin-only. This migration:
--   1. Adds ownership/visibility metadata (visibility, description, compiled_dim).
--   2. Replaces admin-only RLS policies with owner-aware ones so any
--      authenticated user can CRUD their own vectors.
--   3. Keeps admins as a superset ("Admins override steering vectors").
--   4. Caps each user at 25 vectors via a BEFORE INSERT trigger.
--
-- NOTE: challenges.steering_vector_id is intentionally left alone — that
-- column represents the defender side of a challenge and continues to be
-- admin-managed via the challenges admin UI.

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------

ALTER TABLE public.steering_vectors
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS compiled_dim INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'steering_vectors_visibility_chk'
  ) THEN
    ALTER TABLE public.steering_vectors
      ADD CONSTRAINT steering_vectors_visibility_chk
      CHECK (visibility IN ('private', 'public'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS: drop admin-only policies, install owner-aware ones
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Admins can read steering vectors" ON public.steering_vectors;
DROP POLICY IF EXISTS "Admins can modify steering vectors" ON public.steering_vectors;
-- Defensive: drop older variants from earlier iterations in case they exist.
DROP POLICY IF EXISTS "Authenticated users can read steering vectors" ON public.steering_vectors;

DROP POLICY IF EXISTS "Users can read own or public steering vectors" ON public.steering_vectors;
CREATE POLICY "Users can read own or public steering vectors"
  ON public.steering_vectors FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    OR visibility = 'public'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Users can insert own steering vectors" ON public.steering_vectors;
CREATE POLICY "Users can insert own steering vectors"
  ON public.steering_vectors FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Users can update own steering vectors" ON public.steering_vectors;
CREATE POLICY "Users can update own steering vectors"
  ON public.steering_vectors FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS "Users can delete own steering vectors" ON public.steering_vectors;
CREATE POLICY "Users can delete own steering vectors"
  ON public.steering_vectors FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());

DROP POLICY IF EXISTS "Admins override steering vectors" ON public.steering_vectors;
CREATE POLICY "Admins override steering vectors"
  ON public.steering_vectors FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid() AND profiles.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- Per-user quota: soft cap at 25 vectors
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_steering_vector_quota()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  vec_count INTEGER;
BEGIN
  IF NEW.created_by IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(*) INTO vec_count
    FROM public.steering_vectors
    WHERE created_by = NEW.created_by;
  IF vec_count >= 25 THEN
    RAISE EXCEPTION 'Steering vector limit reached (25 per user).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS steering_vector_quota ON public.steering_vectors;
CREATE TRIGGER steering_vector_quota
  BEFORE INSERT ON public.steering_vectors
  FOR EACH ROW EXECUTE FUNCTION public.enforce_steering_vector_quota();

-- ---------------------------------------------------------------------------
-- updated_at maintenance (matches the pattern used elsewhere in the project)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.touch_steering_vector_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS steering_vector_touch_updated_at ON public.steering_vectors;
CREATE TRIGGER steering_vector_touch_updated_at
  BEFORE UPDATE ON public.steering_vectors
  FOR EACH ROW EXECUTE FUNCTION public.touch_steering_vector_updated_at();

-- ---------------------------------------------------------------------------
-- Comments — kept for forensics if someone greps the schema later.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN public.steering_vectors.visibility IS
  'One of (private, public). Public vectors are readable by any authenticated user and can be selected as attacker tools.';
COMMENT ON COLUMN public.steering_vectors.description IS
  'Free-text description surfaced in the user library UI.';
COMMENT ON COLUMN public.steering_vectors.compiled_dim IS
  'Hidden-size dimension of the direction payload. Stored so the UI can display it without parsing vector_payload.';
