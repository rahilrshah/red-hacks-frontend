-- Add round support and optional direct backend URLs for challenges.

ALTER TABLE public.challenges
  ADD COLUMN IF NOT EXISTS challenge_url TEXT;

ALTER TABLE public.attacks
  ADD COLUMN IF NOT EXISTS challenge_id UUID REFERENCES public.challenges(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_attacks_challenge_id ON public.attacks(challenge_id);

CREATE TABLE IF NOT EXISTS public.rounds (
  game_id UUID NOT NULL REFERENCES public.games(id) ON DELETE CASCADE,
  round_index INT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'pvp',
  required_defenses INT NOT NULL DEFAULT 1,
  available_challenges UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, round_index),
  CONSTRAINT rounds_type_check CHECK (type IN ('pvp', 'pve')),
  CONSTRAINT rounds_required_defenses_check CHECK (required_defenses > 0)
);

CREATE INDEX IF NOT EXISTS idx_rounds_game_id ON public.rounds(game_id);

ALTER TABLE public.rounds ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rounds'
      AND policyname = 'Allow all operations for anon'
  ) THEN
    CREATE POLICY "Allow all operations for anon"
      ON public.rounds
      FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rounds'
      AND policyname = 'Allow all operations for authenticated'
  ) THEN
    CREATE POLICY "Allow all operations for authenticated"
      ON public.rounds
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$$;

-- Snapshot the current game challenge layout into a default round for existing games.
INSERT INTO public.rounds (game_id, round_index, name, type, required_defenses, available_challenges)
SELECT
  gc.game_id,
  0,
  'Round 1',
  'pvp',
  1,
  COALESCE(array_agg(gc.challenge_id ORDER BY gc.created_at), '{}'::uuid[])
FROM public.game_challenges gc
GROUP BY gc.game_id
ON CONFLICT (game_id, round_index) DO UPDATE
SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  required_defenses = EXCLUDED.required_defenses,
  available_challenges = EXCLUDED.available_challenges;