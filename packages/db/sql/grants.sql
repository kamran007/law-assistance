-- Database users & privileges (TRD §4.3). Run once per environment as an admin user.
-- Replace the passwords from your secret manager — never commit real values.
-- RDS note: set `log_bin_trust_function_creators = 1` in the parameter group so app_migrate
-- can create the triggers in migration 0001.
-- Per-table grants are used on purpose: MySQL cannot REVOKE a single table from a schema-wide grant.

CREATE USER IF NOT EXISTS 'app_migrate'@'%' IDENTIFIED BY '__SET_FROM_SECRET__';
CREATE USER IF NOT EXISTS 'app_api'@'%'     IDENTIFIED BY '__SET_FROM_SECRET__';
CREATE USER IF NOT EXISTS 'app_worker'@'%'  IDENTIFIED BY '__SET_FROM_SECRET__';
CREATE USER IF NOT EXISTS 'app_scraper'@'%' IDENTIFIED BY '__SET_FROM_SECRET__';

-- Migrations (CI/CD only)
GRANT ALL PRIVILEGES ON lawassist.* TO 'app_migrate'@'%';

-- ── app_api ────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.users              TO 'app_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.otp_challenges     TO 'app_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.refresh_tokens     TO 'app_api'@'%';
GRANT SELECT, INSERT                 ON lawassist.credential_reviews TO 'app_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.device_tokens      TO 'app_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.case_files         TO 'app_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.case_artifacts     TO 'app_api'@'%';
GRANT SELECT, INSERT, DELETE         ON lawassist.artifact_revisions TO 'app_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.conversations      TO 'app_api'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.messages           TO 'app_api'@'%';
GRANT SELECT ON lawassist.statutes               TO 'app_api'@'%';
GRANT SELECT ON lawassist.statute_sections       TO 'app_api'@'%';
GRANT SELECT ON lawassist.section_chunks         TO 'app_api'@'%';
GRANT SELECT ON lawassist.scrape_runs            TO 'app_api'@'%';
GRANT SELECT ON lawassist.scrape_events          TO 'app_api'@'%';
-- Schedule II is edited only through the admin console (API), with every change audited.
GRANT SELECT, INSERT, UPDATE ON lawassist.crpc_schedule_metadata TO 'app_api'@'%';
GRANT SELECT, INSERT ON lawassist.audit_log      TO 'app_api'@'%';   -- append-only
GRANT INSERT         ON lawassist.outbox_events  TO 'app_api'@'%';

-- ── app_worker (scan pipeline, exports, outbox, notifications) ─────────────
GRANT SELECT ON lawassist.users                  TO 'app_worker'@'%';
-- Push: reads the owner's FCM tokens, deletes ones FCM reports as no longer registered.
GRANT SELECT, DELETE ON lawassist.device_tokens  TO 'app_worker'@'%';
GRANT SELECT, UPDATE ON lawassist.case_files     TO 'app_worker'@'%';
GRANT SELECT, UPDATE ON lawassist.case_artifacts TO 'app_worker'@'%';
GRANT SELECT, UPDATE ON lawassist.conversations  TO 'app_worker'@'%';
GRANT SELECT, INSERT ON lawassist.messages       TO 'app_worker'@'%';
GRANT SELECT ON lawassist.statutes               TO 'app_worker'@'%';
GRANT SELECT ON lawassist.statute_sections       TO 'app_worker'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.section_chunks TO 'app_worker'@'%';
GRANT SELECT ON lawassist.crpc_schedule_metadata TO 'app_worker'@'%';
GRANT SELECT, UPDATE ON lawassist.outbox_events  TO 'app_worker'@'%';
GRANT SELECT, INSERT ON lawassist.audit_log      TO 'app_worker'@'%';   -- append-only

-- ── app_scraper (statute data only — never user tables) ────────────────────
GRANT SELECT, INSERT, UPDATE ON lawassist.statutes         TO 'app_scraper'@'%';
GRANT SELECT, INSERT, UPDATE ON lawassist.statute_sections TO 'app_scraper'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON lawassist.section_chunks TO 'app_scraper'@'%';
GRANT SELECT, INSERT, UPDATE ON lawassist.scrape_runs      TO 'app_scraper'@'%';
GRANT SELECT, INSERT         ON lawassist.scrape_events    TO 'app_scraper'@'%';
GRANT SELECT, INSERT         ON lawassist.outbox_events    TO 'app_scraper'@'%';
