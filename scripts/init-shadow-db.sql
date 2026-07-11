-- Runs once on first cluster init (docker-entrypoint-initdb.d).
-- Creates the throwaway shadow database Atlas uses for migration dry-runs.
-- Atlas needs a clean, disposable DB it fully controls; never point app code at it.
CREATE DATABASE rayspec_shadow OWNER rayspec;
