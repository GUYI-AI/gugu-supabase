-- The runtime-instance reap in identity.sweep_device_leases deletes at most p_limit rows per run. It joined the table to a
-- `LIMIT p_limit FOR UPDATE SKIP LOCKED` subquery. When the table is nearly empty, the planner puts that subquery on the
-- inner side of a nested loop and runs it again for every outer row, so each rescan locks and returns a different batch.
-- A run then deletes past the bound (three expired rows, p_limit 2: all three gone). The batch is now a MATERIALIZED CTE,
-- computed once per run, the same way the device flip above it already takes its batch.
-- Rebuild only this installed function, retaining owner, attributes and exact ACL.
DO $sweep_bounded$
DECLARE r record; definition text; previous text; permission record;
BEGIN
  SELECT p.oid, p.oid::regprocedure AS signature, COALESCE(p.proacl, acldefault('f', p.proowner)) AS acl INTO r
    FROM pg_proc p WHERE p.oid = 'identity.sweep_device_leases(integer)'::regprocedure;
  definition := pg_get_functiondef(r.oid); previous := definition;
  definition := replace(definition, $old$    DELETE FROM identity.runtime_instances r
     USING (SELECT instance_id FROM identity.runtime_instances
             WHERE last_heartbeat_at < now() - interval '1 hour'
             LIMIT p_limit
             FOR UPDATE SKIP LOCKED) stale
     WHERE r.instance_id = stale.instance_id;$old$, $new$    WITH stale AS MATERIALIZED (
        SELECT instance_id FROM identity.runtime_instances
         WHERE last_heartbeat_at < now() - interval '1 hour'
         LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    DELETE FROM identity.runtime_instances r
     USING stale
     WHERE r.instance_id = stale.instance_id;$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'Unexpected sweep_device_leases predecessor: %', r.signature;
  END IF;
  EXECUTE definition;
  FOR permission IN SELECT grantee, bool_or(is_grantable) AS grantable
    FROM aclexplode(r.acl) WHERE privilege_type = 'EXECUTE' GROUP BY grantee LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s%s', r.signature,
      CASE WHEN permission.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(permission.grantee)) END,
      CASE WHEN permission.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $sweep_bounded$;
