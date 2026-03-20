-- For rapid prototyping, we will allow all operations on games for anon and authenticated users
-- In a real application, you would lock this down (e.g., only admins can insert games).

DO $$
DECLARE
    table_names text[] := ARRAY['profiles', 'games', 'teams', 'team_members', 'tools', 'interp_args', 'challenges', 'challenge_tools', 'defended_challenges', 'attacks'];
    t text;
BEGIN
    FOREACH t IN ARRAY table_names LOOP
        EXECUTE format('
            CREATE POLICY "Allow all operations for anon" ON %I FOR ALL USING (true) WITH CHECK (true);
        ', t);
        EXECUTE format('
            CREATE POLICY "Allow all operations for authenticated" ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true);
        ', t);
    END LOOP;
END;
$$;
