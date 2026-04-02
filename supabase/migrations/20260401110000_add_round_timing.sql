-- Add timing fields to rounds: duration and intermission period.

ALTER TABLE public.rounds
  ADD COLUMN IF NOT EXISTS duration_minutes INT NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS intermission_minutes INT NOT NULL DEFAULT 5;

ALTER TABLE public.rounds
  ADD CONSTRAINT rounds_duration_check CHECK (duration_minutes > 0),
  ADD CONSTRAINT rounds_intermission_check CHECK (intermission_minutes >= 0);
