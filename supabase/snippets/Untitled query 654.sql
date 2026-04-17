SELECT relname, relrowsecurity
   FROM pg_class
   WHERE relname = 'steering_vectors'; 