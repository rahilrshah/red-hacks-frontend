-- Enable Supabase Realtime for the tables that player clients need to
-- react to in real time when the admin makes changes. Without this, the
-- supabase.channel().on('postgres_changes', ...) subscriptions silently
-- receive nothing because the tables aren't in the publication.

ALTER PUBLICATION supabase_realtime ADD TABLE public.games;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rounds;
ALTER PUBLICATION supabase_realtime ADD TABLE public.teams;
ALTER PUBLICATION supabase_realtime ADD TABLE public.defended_challenges;
ALTER PUBLICATION supabase_realtime ADD TABLE public.attacks;
