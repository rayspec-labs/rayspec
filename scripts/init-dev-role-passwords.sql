-- Runs once on first cluster init (docker-entrypoint-initdb.d), after 20-database-roles.sql created
-- the three database roles in `rayspec`. DEV CONTAINER ONLY: throwaway placeholder passwords, the
-- same convention as the rayspec/rayspec superuser of this container. A real deployment sets its own
-- passwords (docs/database-isolation.md) and never uses these.
ALTER ROLE rayspec_migrator PASSWORD 'rayspec_migrator';
ALTER ROLE rayspec_runtime PASSWORD 'rayspec_runtime';
ALTER ROLE rayspec_snapshot PASSWORD 'rayspec_snapshot';
