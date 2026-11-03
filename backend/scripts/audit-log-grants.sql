-- Audit logs are append-only. Run as a database administrator after migrations.
-- Replace redflie_app with the runtime database role used by the API.
-- Table owners bypass grants, so production must not run the API as the owner.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'redflie_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM redflie_app;
    GRANT INSERT, SELECT ON TABLE audit_logs TO redflie_app;
    RAISE NOTICE 'audit_logs grants applied to redflie_app';
  ELSE
    RAISE NOTICE 'Role redflie_app not found; skipping audit_logs grants';
  END IF;
END
$$;
