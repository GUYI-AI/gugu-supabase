-- Fixed platform-owner preparation. Run with psql -X -v ON_ERROR_STOP=1,
-- outside an explicit transaction; psql sends CREATE as its own request.
-- Never pass this entire script as one driver query or wrap it in BEGIN.
SET lock_timeout='100ms';
SET statement_timeout='120s';
SET search_path=pg_catalog;
DO $before$
BEGIN
    IF current_setting('server_version_num')::integer<170000 THEN
        RAISE EXCEPTION 'Auth audit preparation requires PostgreSQL 17';
    END IF;
    IF current_user<>'supabase_auth_admin'
       OR (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='auth.audit_log_entries'::regclass)<>current_user THEN
        RAISE EXCEPTION 'Auth audit preparation requires its existing platform owner';
    END IF;
    IF to_regclass('auth.audit_log_entries_created_at_id_idx') IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
        JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_am am ON am.oid=i.relam
        WHERE x.indrelid='auth.audit_log_entries'::regclass
          AND i.oid=to_regclass('auth.audit_log_entries_created_at_id_idx')
          AND i.relowner=t.relowner AND x.indisvalid AND x.indisready
          AND NOT x.indisunique AND am.amname='btree'
          AND x.indpred IS NULL AND x.indexprs IS NULL AND x.indnatts=2 AND x.indnkeyatts=2
          AND ARRAY(SELECT a.attname::text FROM unnest(x.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
              JOIN pg_catalog.pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=k.attnum ORDER BY k.n)
              =ARRAY['created_at','id']::text[]) THEN
        RAISE EXCEPTION 'Existing Auth audit time index is invalid or differs; stop for review';
    END IF;
END $before$;
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_entries_created_at_id_idx ON auth.audit_log_entries USING btree (created_at,id);
DO $after$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
        JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_am am ON am.oid=i.relam
        WHERE x.indrelid='auth.audit_log_entries'::regclass
          AND i.oid=to_regclass('auth.audit_log_entries_created_at_id_idx')
          AND i.relowner=t.relowner AND x.indisvalid AND x.indisready
          AND NOT x.indisunique AND am.amname='btree'
          AND x.indpred IS NULL AND x.indexprs IS NULL AND x.indnatts=2 AND x.indnkeyatts=2
          AND ARRAY(SELECT a.attname::text FROM unnest(x.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
              JOIN pg_catalog.pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=k.attnum ORDER BY k.n)
              =ARRAY['created_at','id']::text[]) THEN
        RAISE EXCEPTION 'Auth audit time index is not valid and ready; stop without rebuilding';
    END IF;
END $after$;
SELECT 1 AS index_valid_ready;
