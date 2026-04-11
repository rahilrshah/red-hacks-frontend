-- Track when a defense's prompt or secret key was last modified, for the
-- attack-bonus counting window. On UPDATE, only bump updated_at if the
-- defensive content actually changed — ignores is_active flips (elimination)
-- and defense_reward_granted flips.

ALTER TABLE public.defended_challenges
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.defended_challenges
  SET updated_at = created_at
  WHERE created_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.defended_challenges_bump_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.system_prompt IS DISTINCT FROM OLD.system_prompt)
     OR (NEW.target_secret_key IS DISTINCT FROM OLD.target_secret_key) THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_defended_challenges_bump_updated_at
  ON public.defended_challenges;

CREATE TRIGGER trg_defended_challenges_bump_updated_at
  BEFORE UPDATE ON public.defended_challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.defended_challenges_bump_updated_at();
