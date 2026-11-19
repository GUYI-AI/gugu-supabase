-- Explicit reviewed recovery only. The normal preparation never runs DROP.
-- The CD host holds its deployment lock across inspection, DROP and rebuild.
-- psql sends DROP CONCURRENTLY as its own request, outside transactions.
RESET ROLE;
SET lock_timeout='100ms';
\if :{?auth_audit_statement_ms}
\else
\set auth_audit_statement_ms 120000
\endif
SET statement_timeout=:'auth_audit_statement_ms';
SET search_path=pg_catalog;
DO $recover$
BEGIN
    IF session_user<>'supabase_admin' OR current_user<>'supabase_admin'
       OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
        RAISE EXCEPTION 'Index recovery requires the existing administrator with complete catalog visibility';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
        JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_am am ON am.oid=i.relam
        WHERE x.indrelid='auth.audit_log_entries'::regclass
          AND i.oid=to_regclass('auth.audit_log_entries_created_at_id_idx')
          AND i.relowner=t.relowner AND NOT x.indisvalid AND x.indislive
          AND NOT x.indisunique AND am.amname='btree'
          AND x.indpred IS NULL AND x.indexprs IS NULL AND x.indnatts=2 AND x.indnkeyatts=2
          AND ARRAY(SELECT a.attname::text FROM unnest(x.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
              JOIN pg_catalog.pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=k.attnum ORDER BY k.n)
              =ARRAY['created_at','id']::text[]) OR EXISTS(
        SELECT 1 FROM pg_stat_progress_create_index WHERE relid='auth.audit_log_entries'::regclass
    ) THEN
        RAISE EXCEPTION 'Recovery requires the exact invalid time index and no active index build';
    END IF;
END $recover$;
SELECT 1 AS invalid_index_confirmed;
SET ROLE supabase_auth_admin;
DROP INDEX CONCURRENTLY auth.audit_log_entries_created_at_id_idx;
