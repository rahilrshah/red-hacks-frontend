-- Phase 1 runtime verification for the user_steering_vectors migration.
--
-- Run with:
--     supabase db reset           -- applies all migrations + seed
--     supabase db execute -f supabase/tests/steering_vectors_rls.sql
--
-- Any assertion that fails raises an exception and aborts the script.
-- Covers: V1.2 policies present, V1.3 trigger present, V1.4 cross-user
-- read isolation, V1.5 quota exceeded raises, V1.6 FK intact.

BEGIN;

-- --------------------------------------------------------------------------
-- V1.2/V1.3 structural checks via catalogs
-- --------------------------------------------------------------------------

DO $$
DECLARE
  expected_policies TEXT[] := ARRAY[
    'Users can read own or public steering vectors',
    'Users can insert own steering vectors',
    'Users can update own steering vectors',
    'Users can delete own steering vectors',
    'Admins override steering vectors'
  ];
  missing_policies TEXT[];
  has_trigger BOOLEAN;
BEGIN
  SELECT array_agg(p) INTO missing_policies
    FROM unnest(expected_policies) AS p
    WHERE p NOT IN (
      SELECT polname FROM pg_policy
        WHERE polrelid = 'public.steering_vectors'::regclass
    );
  IF missing_policies IS NOT NULL THEN
    RAISE EXCEPTION 'V1.2 FAIL — missing policies: %', missing_policies;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy
      WHERE polrelid = 'public.steering_vectors'::regclass
        AND polname IN ('Admins can read steering vectors',
                        'Admins can modify steering vectors',
                        'Authenticated users can read steering vectors')
  ) THEN
    RAISE EXCEPTION 'V1.2 FAIL — stale admin-only policies still present';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'public.steering_vectors'::regclass
        AND tgname = 'steering_vector_quota'
        AND NOT tgisinternal
  ) INTO has_trigger;
  IF NOT has_trigger THEN
    RAISE EXCEPTION 'V1.3 FAIL — steering_vector_quota trigger missing';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- V1.6 — challenges.steering_vector_id FK intact.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t  ON t.oid  = c.conrelid
    JOIN pg_class rt ON rt.oid = c.confrelid
    WHERE t.relname  = 'challenges'
      AND rt.relname = 'steering_vectors'
      AND c.contype  = 'f'
  ) THEN
    RAISE EXCEPTION 'V1.6 FAIL — FK challenges -> steering_vectors is missing';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Fixtures for V1.4 / V1.5.
-- Insert two auth users + profiles and a public vector owned by B.
-- --------------------------------------------------------------------------
CREATE TEMP TABLE _cleanup_users (id UUID) ON COMMIT DROP;

WITH alice AS (
  INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'alice@test.local')
    RETURNING id
), bob AS (
  INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'bob@test.local')
    RETURNING id
)
INSERT INTO _cleanup_users SELECT id FROM alice UNION ALL SELECT id FROM bob;

INSERT INTO public.profiles (id, role)
  SELECT id, 'player' FROM _cleanup_users;

-- Seed: bob has a private vector + a public vector.
INSERT INTO public.steering_vectors
  (name, model_name, positive_examples, negative_examples,
   target_layers, vector_payload, visibility, created_by)
SELECT
  'bob_private', 'gpt2', '[]'::jsonb, '[]'::jsonb,
  ARRAY[8], '{}'::jsonb, 'private',
  (SELECT id FROM _cleanup_users LIMIT 1 OFFSET 1);

INSERT INTO public.steering_vectors
  (name, model_name, positive_examples, negative_examples,
   target_layers, vector_payload, visibility, created_by)
SELECT
  'bob_public', 'gpt2', '[]'::jsonb, '[]'::jsonb,
  ARRAY[8], '{}'::jsonb, 'public',
  (SELECT id FROM _cleanup_users LIMIT 1 OFFSET 1);

-- --------------------------------------------------------------------------
-- V1.4 — cross-user read isolation under RLS.
-- Simulate requests by setting request.jwt.claims.sub = alice.id, role = authenticated.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  alice_id UUID;
  private_seen INT;
  public_seen INT;
BEGIN
  SELECT id INTO alice_id FROM _cleanup_users LIMIT 1;
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', alice_id::text, 'role', 'authenticated')::text,
    true
  );
  SET LOCAL ROLE authenticated;

  SELECT COUNT(*) INTO private_seen
    FROM public.steering_vectors WHERE name = 'bob_private';
  SELECT COUNT(*) INTO public_seen
    FROM public.steering_vectors WHERE name = 'bob_public';

  RESET ROLE;

  IF private_seen <> 0 THEN
    RAISE EXCEPTION 'V1.4 FAIL — Alice can see Bob''s private vector';
  END IF;
  IF public_seen <> 1 THEN
    RAISE EXCEPTION 'V1.4 FAIL — Alice cannot see Bob''s public vector (got %)', public_seen;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- V1.5 — quota trigger raises when Alice tries to insert her 26th vector.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  alice_id UUID;
  i INT;
  raised BOOLEAN := false;
BEGIN
  SELECT id INTO alice_id FROM _cleanup_users LIMIT 1;
  FOR i IN 1..25 LOOP
    INSERT INTO public.steering_vectors
      (name, model_name, positive_examples, negative_examples,
       target_layers, vector_payload, visibility, created_by)
    VALUES
      ('alice_vec_' || i, 'gpt2', '[]'::jsonb, '[]'::jsonb,
       ARRAY[8], '{}'::jsonb, 'private', alice_id);
  END LOOP;
  BEGIN
    INSERT INTO public.steering_vectors
      (name, model_name, positive_examples, negative_examples,
       target_layers, vector_payload, visibility, created_by)
    VALUES
      ('alice_vec_26', 'gpt2', '[]'::jsonb, '[]'::jsonb,
       ARRAY[8], '{}'::jsonb, 'private', alice_id);
  EXCEPTION WHEN raise_exception THEN
    raised := true;
  END;
  IF NOT raised THEN
    RAISE EXCEPTION 'V1.5 FAIL — quota trigger did not raise on 26th insert';
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- Cleanup (script runs in a transaction we ROLLBACK at the end).
-- --------------------------------------------------------------------------
ROLLBACK;
\echo 'Phase 1 runtime verification passed.'
