-- Steering vectors are stored server-side and linked to challenges.

CREATE TABLE steering_vectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  model_name TEXT NOT NULL,
  positive_examples JSONB NOT NULL,
  negative_examples JSONB NOT NULL,
  target_layers INT[] NOT NULL,
  pooling TEXT NOT NULL DEFAULT 'last',
  position TEXT NOT NULL DEFAULT 'all',
  vector_payload JSONB NOT NULL,
  min_coefficient NUMERIC NOT NULL DEFAULT -12,
  max_coefficient NUMERIC NOT NULL DEFAULT 12,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE steering_vectors ENABLE ROW LEVEL SECURITY;

ALTER TABLE challenges
  ADD COLUMN IF NOT EXISTS steering_vector_id UUID REFERENCES steering_vectors(id);

DROP POLICY IF EXISTS "Authenticated users can read steering vectors" ON steering_vectors;
DROP POLICY IF EXISTS "Admins can modify steering vectors" ON steering_vectors;

CREATE POLICY "Admins can read steering vectors"
ON steering_vectors FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
  )
);

CREATE POLICY "Admins can modify steering vectors"
ON steering_vectors FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM profiles
    WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
  )
);
