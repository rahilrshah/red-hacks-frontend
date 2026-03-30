-- Per-game challenge selection
-- Default behavior: every game includes every challenge unless an admin removes specific mappings.

CREATE TABLE IF NOT EXISTS game_challenges (
  game_id UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  challenge_id UUID NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_game_challenges_game_id ON game_challenges(game_id);
CREATE INDEX IF NOT EXISTS idx_game_challenges_challenge_id ON game_challenges(challenge_id);

ALTER TABLE game_challenges ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'game_challenges'
      AND policyname = 'Allow all operations for anon'
  ) THEN
    CREATE POLICY "Allow all operations for anon"
      ON game_challenges
      FOR ALL
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'game_challenges'
      AND policyname = 'Allow all operations for authenticated'
  ) THEN
    CREATE POLICY "Allow all operations for authenticated"
      ON game_challenges
      FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END;
$$;

-- Backfill: existing games should include all existing challenges by default.
INSERT INTO game_challenges (game_id, challenge_id)
SELECT g.id, c.id
FROM games g
CROSS JOIN challenges c
ON CONFLICT (game_id, challenge_id) DO NOTHING;

-- Keep default behavior when new games are created.
CREATE OR REPLACE FUNCTION add_all_challenges_to_new_game()
RETURNS trigger AS $$
BEGIN
  INSERT INTO game_challenges (game_id, challenge_id)
  SELECT NEW.id, c.id
  FROM challenges c
  ON CONFLICT (game_id, challenge_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_add_all_challenges_to_new_game ON games;
CREATE TRIGGER trg_add_all_challenges_to_new_game
AFTER INSERT ON games
FOR EACH ROW
EXECUTE FUNCTION add_all_challenges_to_new_game();

-- Keep default behavior when new challenges are created.
CREATE OR REPLACE FUNCTION add_new_challenge_to_all_games()
RETURNS trigger AS $$
BEGIN
  INSERT INTO game_challenges (game_id, challenge_id)
  SELECT g.id, NEW.id
  FROM games g
  ON CONFLICT (game_id, challenge_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_add_new_challenge_to_all_games ON challenges;
CREATE TRIGGER trg_add_new_challenge_to_all_games
AFTER INSERT ON challenges
FOR EACH ROW
EXECUTE FUNCTION add_new_challenge_to_all_games();
