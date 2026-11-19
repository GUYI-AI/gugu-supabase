-- Keep routine device status updates compatible with runtime heartbeats.
-- Preparation still takes FOR UPDATE on the device, and stale RR snapshots
-- must not publish presence after preparation. Existing migration bytes stay fixed.
DO $$
BEGIN
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
        'account_deletion_private.device_preparation_runtime_guard()'::regprocedure)
        IS DISTINCT FROM '260ebc8af639209032cd78b866255813'
      OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=
        'account_deletion_private.device_preparation_prepare(uuid,text,uuid)'::regprocedure)
        IS DISTINCT FROM '2ac8078b49e1e7bc5f8ae0744cfda632' THEN
        RAISE EXCEPTION 'Closure device preparation predecessor differs';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION account_deletion_private.device_preparation_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE device text; admission boolean;
BEGIN
    -- The closed path never locks the device row. Share the admission row until
    -- commit, so enabling cannot overtake a heartbeat admitted while closed.
    SELECT enabled INTO admission FROM account_deletion_private.device_preparation_access
      WHERE singleton FOR SHARE;
    IF NOT COALESCE(admission,false) AND NOT EXISTS(
      SELECT 1 FROM account_deletion_private.device_preparations
      WHERE state='prepared' AND device_id=ANY(CASE WHEN TG_OP='UPDATE'
        THEN ARRAY[OLD.device_id,NEW.device_id] ELSE ARRAY[NEW.device_id] END)
    ) THEN RETURN NEW; END IF;
    -- A gate closure never unseals an already prepared device. Preparation's
    -- explicit FOR UPDATE conflicts; ordinary non-key status updates do not.
    FOR device IN SELECT DISTINCT value FROM unnest(CASE WHEN TG_OP='UPDATE'
        THEN ARRAY[OLD.device_id,NEW.device_id] ELSE ARRAY[NEW.device_id] END) AS ids(value) ORDER BY value LOOP
        PERFORM 1 FROM identity.gugu_devices WHERE device_id=device FOR KEY SHARE NOWAIT;
        IF account_deletion_private.device_preparation_is_sealed(device) THEN
            RAISE EXCEPTION 'DEVICE_CLOSURE_PREPARING' USING ERRCODE='42501';
        END IF;
    END LOOP;
    RETURN NEW;
END $$;

-- Closing admission must also wait for preparations already admitted while
-- open; otherwise the closed-path fast return could miss an uncommitted seal.
DO $$
DECLARE definition text; before text;
BEGIN
    SELECT pg_get_functiondef('account_deletion_private.device_preparation_prepare(uuid,text,uuid)'::regprocedure)
      INTO definition;
    before:='FROM account_deletion_private.device_preparation_access WHERE singleton),false)';
    IF length(definition)-length(replace(definition,before,''))<>length(before) THEN
        RAISE EXCEPTION 'Closure admission predecessor differs';
    END IF;
    EXECUTE replace(definition,before,
      'FROM account_deletion_private.device_preparation_access WHERE singleton FOR SHARE),false)');
END $$;
