-- Upgrade-first connection management. Configuration defaults OFF and is never
-- API writable. This release does not select a minimum release or cut authority.
CREATE FUNCTION identity.connection_semver_parts(p_version text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE parts text[]; token text;
BEGIN
    IF p_version IS NULL OR length(p_version)>128 THEN RETURN NULL; END IF;
    parts := regexp_match(p_version,
      '^(0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})[.](0|[1-9][0-9]{0,8})(?:-([0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*))?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$');
    IF parts IS NULL THEN RETURN NULL; END IF;
    FOREACH token IN ARRAY COALESCE(string_to_array(parts[4],'.'),ARRAY[]::text[]) LOOP
        IF token ~ '^0[0-9]+$' THEN RETURN NULL; END IF;
    END LOOP;
    RETURN parts;
END;
$$;
CREATE FUNCTION identity.connection_semver_compare(p_left text,p_right text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE a text[]:=identity.connection_semver_parts(p_left); b text[]:=identity.connection_semver_parts(p_right);
    ac integer[]; bc integer[]; ap text[]; bp text[]; i integer; an boolean; bn boolean;
BEGIN
    IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
    ac:=ARRAY[a[1]::integer,a[2]::integer,a[3]::integer]; bc:=ARRAY[b[1]::integer,b[2]::integer,b[3]::integer];
    IF ac<>bc THEN RETURN CASE WHEN ac>bc THEN 1 ELSE -1 END; END IF;
    IF a[4] IS NULL THEN RETURN CASE WHEN b[4] IS NULL THEN 0 ELSE 1 END; END IF;
    IF b[4] IS NULL THEN RETURN -1; END IF;
    ap:=string_to_array(a[4],'.'); bp:=string_to_array(b[4],'.');
    FOR i IN 1..least(cardinality(ap),cardinality(bp)) LOOP
        IF ap[i]=bp[i] THEN CONTINUE; END IF;
        an:=ap[i] ~ '^[0-9]+$'; bn:=bp[i] ~ '^[0-9]+$';
        IF an AND bn THEN RETURN CASE WHEN ap[i]::numeric>bp[i]::numeric THEN 1 ELSE -1 END; END IF;
        IF an<>bn THEN RETURN CASE WHEN an THEN -1 ELSE 1 END; END IF;
        RETURN CASE WHEN ap[i] COLLATE "C">bp[i] COLLATE "C" THEN 1 ELSE -1 END;
    END LOOP;
    RETURN CASE WHEN cardinality(ap)=cardinality(bp) THEN 0 WHEN cardinality(ap)>cardinality(bp) THEN 1 ELSE -1 END;
END;
$$;
CREATE FUNCTION identity.connection_management_policy_valid(p_minimums jsonb,p_enforced boolean) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE entry record;
BEGIN
    IF p_enforced IS NULL OR jsonb_typeof(p_minimums) IS DISTINCT FROM 'object'
      OR p_enforced AND p_minimums='{}'::jsonb THEN RETURN false; END IF;
    FOR entry IN SELECT * FROM jsonb_each(p_minimums) LOOP
        IF entry.key NOT IN ('desktop','phone','server','web') OR jsonb_typeof(entry.value)<>'string'
          OR identity.connection_semver_parts(entry.value#>>'{}') IS NULL THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;
CREATE TABLE identity.connection_management_client_policy (
    id boolean PRIMARY KEY DEFAULT true CHECK(id),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
    enforced boolean NOT NULL DEFAULT false,
    minimum_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT connection_management_client_policy_valid CHECK(identity.connection_management_policy_valid(minimum_versions,enforced))
);
ALTER TABLE identity.connection_management_client_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.connection_management_client_policy FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO identity.connection_management_client_policy(id) VALUES(true);

CREATE FUNCTION identity.connection_management_headers() RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE headers jsonb:=COALESCE(NULLIF(current_setting('request.headers',true),''),'{}')::jsonb;
BEGIN
    IF jsonb_typeof(headers)<>'object' THEN RAISE EXCEPTION 'Connection request headers are invalid' USING ERRCODE='22023'; END IF;
    RETURN ARRAY[CASE WHEN jsonb_typeof(headers->'x-gugu-connection-client-version')='string'
      THEN headers->>'x-gugu-connection-client-version' END,
      CASE WHEN jsonb_typeof(headers->'x-gugu-connection-client-platform')='string'
      THEN headers->>'x-gugu-connection-client-platform' END];
END;
$$;
CREATE FUNCTION identity.connection_management_decision(p_version text,p_platform text,p_minimums jsonb,p_enforced boolean,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE platform text:=CASE WHEN p_platform IN ('desktop','phone','server','web') THEN p_platform END;
    minimum text; allowed boolean;
BEGIN
    IF NOT identity.connection_management_policy_valid(p_minimums,p_enforced) OR p_revision IS NULL OR p_revision<0 THEN
        RAISE EXCEPTION 'Connection management policy is invalid' USING ERRCODE='55000'; END IF;
    minimum:=p_minimums->>platform;
    allowed:=NOT p_enforced OR COALESCE(identity.connection_semver_compare(p_version,minimum)>=0,false);
    RETURN jsonb_build_object('version',1,'feature','connection-management','policyRevision',p_revision::text,
      'enforced',p_enforced,'allowed',allowed,'minimumVersion',minimum,'clientPlatform',platform,
      'errorCode',CASE WHEN NOT allowed THEN 'CONNECTION_CLIENT_UPGRADE_REQUIRED' END);
END;
$$;
CREATE FUNCTION identity.connection_management_access() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ignored_owner text:=identity.connection_owner(); cfg identity.connection_management_client_policy%ROWTYPE;
    headers text[]:=identity.connection_management_headers();
BEGIN
    SELECT * INTO STRICT cfg FROM identity.connection_management_client_policy WHERE id;
    RETURN identity.connection_management_decision(headers[1],headers[2],cfg.minimum_versions,cfg.enforced,cfg.revision);
END;
$$;

-- All actual management writes take this shared lock BEFORE owner/item locks.
-- Policy changes take it exclusively. A reader is never an effect permission.
-- This internal guard is closed; subsequent entry-point wiring must call it in
-- the actual credential/metadata mutation transaction, not only before HTTP IO.
CREATE FUNCTION identity.connection_management_require_access() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg identity.connection_management_client_policy%ROWTYPE; headers text[]; access jsonb;
BEGIN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('gugu:connection-management-policy',0));
    SELECT * INTO STRICT cfg FROM identity.connection_management_client_policy WHERE id FOR SHARE;
    headers:=identity.connection_management_headers();
    access:=identity.connection_management_decision(headers[1],headers[2],cfg.minimum_versions,cfg.enforced,cfg.revision);
    IF NOT (access->>'allowed')::boolean THEN
        RAISE EXCEPTION 'CONNECTION_CLIENT_UPGRADE_REQUIRED' USING ERRCODE='PT426',
          DETAIL=jsonb_build_object('feature','connection-management','minimumVersion',access->'minimumVersion',
            'clientPlatform',access->'clientPlatform','policyRevision',access->>'policyRevision')::text;
    END IF;
END;
$$;
CREATE FUNCTION identity.connection_management_set_policy(p_expected_revision bigint,p_enforced boolean,p_minimums jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg identity.connection_management_client_policy%ROWTYPE;
BEGIN
    IF p_expected_revision IS NULL OR p_expected_revision<0 OR NOT identity.connection_management_policy_valid(p_minimums,p_enforced) THEN
        RAISE EXCEPTION 'Connection management policy is invalid' USING ERRCODE='22023'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:connection-management-policy',0));
    SELECT * INTO STRICT cfg FROM identity.connection_management_client_policy WHERE id FOR UPDATE;
    IF cfg.revision<>p_expected_revision THEN RAISE EXCEPTION 'CONNECTION_POLICY_CHANGED' USING ERRCODE='PT409'; END IF;
    UPDATE identity.connection_management_client_policy SET revision=revision+1,enforced=p_enforced,minimum_versions=p_minimums
      WHERE id RETURNING * INTO cfg;
    RETURN jsonb_build_object('policyRevision',cfg.revision::text,'enforced',cfg.enforced);
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_semver_parts(text),identity.connection_semver_compare(text,text),
    identity.connection_management_policy_valid(jsonb,boolean),identity.connection_management_headers(),
    identity.connection_management_decision(text,text,jsonb,boolean,bigint),identity.connection_management_access(),
    identity.connection_management_require_access(),identity.connection_management_set_policy(bigint,boolean,jsonb)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.connection_management_access() TO authenticated;
