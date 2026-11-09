-- The routing reader must ship before the first new-location client. It is
-- independent of closed owner application RPCs and does not switch any owner.
ALTER TABLE identity.connection_heads ADD COLUMN authority_mode text NOT NULL DEFAULT 'legacy'
    CHECK (authority_mode IN ('legacy','owner'));
ALTER TABLE identity.connection_heads ADD COLUMN authority_epoch bigint NOT NULL DEFAULT 0 CHECK (authority_epoch>=0);
ALTER TABLE identity.connection_heads ADD COLUMN authority_phase text NOT NULL DEFAULT 'stable'
    CHECK (authority_phase IN ('stable','quiescing'));

CREATE FUNCTION identity.connection_authority() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); head identity.connection_heads%ROWTYPE;
BEGIN
    SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id=owner_id;
    -- No row has a defined server policy, rather than an inferred client route.
    -- Reading does not create a head, assistant or private folder.
    RETURN jsonb_build_object('version',1,'mode',COALESCE(head.authority_mode,'legacy'),
        'epoch',COALESCE(head.authority_epoch,0)::text,'phase',COALESCE(head.authority_phase,'stable'),
        'acceptingNewOperations',COALESCE(head.authority_phase='stable',true));
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_authority() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION identity.connection_authority() TO authenticated;

-- Internal transaction fence for the later, separately approved entry-point
-- wiring. It is deliberately not callable by clients as a check-then-act RPC.
-- Every transition must take this same advisory lock, then the head row lock.
CREATE FUNCTION identity.connection_authority_fence(p_expected_mode text,p_expected_epoch bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id text := identity.connection_owner(); head identity.connection_heads%ROWTYPE; actual_mode text; actual_epoch bigint;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('gugu:connection-authority:' || owner_id,0));
    SELECT * INTO head FROM identity.connection_heads WHERE owner_user_id=owner_id FOR UPDATE;
    actual_mode := COALESCE(head.authority_mode,'legacy'); actual_epoch := COALESCE(head.authority_epoch,0);
    IF p_expected_mode IS NULL OR p_expected_mode NOT IN ('legacy','owner') OR p_expected_epoch IS NULL OR p_expected_epoch<0 THEN
        RAISE EXCEPTION 'Connection routing identity is invalid' USING ERRCODE='22023'; END IF;
    IF p_expected_mode<>actual_mode OR p_expected_epoch<>actual_epoch OR COALESCE(head.authority_phase,'stable')<>'stable' THEN
        RAISE EXCEPTION 'Connection authority changed or is quiescing' USING ERRCODE='PT409'; END IF;
    RETURN jsonb_build_object('mode',actual_mode,'epoch',actual_epoch::text);
END;
$$;
REVOKE ALL ON FUNCTION identity.connection_authority_fence(text,bigint) FROM PUBLIC,anon,authenticated,service_role;
