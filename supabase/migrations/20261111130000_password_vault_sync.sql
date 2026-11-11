-- End-to-end encrypted password vault sync (GUYI-AI/gugu#2481).
--
-- The desktop vault (Settings → 密码) syncs across one owner's devices. The cloud never sees plaintext: items are
-- AES-256-GCM ciphertext under per-item keys, item keys are wrapped by a vault key, and the vault key reaches a device
-- only as a libsodium sealed box addressed to that device's X25519 public key. Website, account, field names and the
-- authorized-Agent list are all inside the ciphertext; these tables hold ids, versions, epochs and timestamps.
--
-- A new device joins with a commit–reveal short code (Bluetooth numeric-comparison shape): it registers its public key
-- and a commitment, an approved device posts its nonce, the new device reveals its nonce, and both screens show 6 digits
-- derived from the key and both nonces. A swapped key must be committed before the approver's nonce exists, so the
-- server cannot grind a matching code. The person compares and approves on the old device, which seals the key.
--
-- Saves carry the version they were based on; a stale version is refused (40001) and the client pulls first. Every
-- write bumps the owner's head revision, which clients poll; items carry the revision that last wrote them.
-- Removing a device (or deleting its gugu_devices row) sets rotation_required; an approved full-scope device then
-- re-keys everything in one call (password_vault_rotate).
--
-- Recovery code (optional): a device that lives on paper. Its X25519 key pair derives from a random ~130-bit code the
-- person keeps; the cloud holds the vault key sealed to its public key and a SHA-256 verifier of a separate proof
-- derived from the same code. With the account signed in and the proof, a new device receives that sealed key and joins
-- with no other device. A use consumes the code. Re-keying re-seals to the code, or drops it.
--
-- Tables are closed to API roles; access is through owner-checked SECURITY DEFINER functions only. New tables, no
-- change to existing ones; no table lock beyond creation. Rollback: drop the functions and the four tables.
SET LOCAL lock_timeout = '5s';

CREATE TABLE identity.password_vault_heads (
    owner_user_id text PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
    key_epoch integer NOT NULL CHECK (key_epoch >= 1),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    rotation_required boolean NOT NULL DEFAULT false,
    recovery_public_key text CHECK (recovery_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
    recovery_verifier text CHECK (recovery_verifier ~ '^[0-9a-f]{64}$'),
    recovery_sealed text CHECK (length(recovery_sealed) <= 256),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((recovery_public_key IS NULL) = (recovery_verifier IS NULL) AND (recovery_public_key IS NULL) = (recovery_sealed IS NULL))
);
CREATE TABLE identity.password_vault_devices (
    owner_user_id text NOT NULL REFERENCES identity.password_vault_heads(owner_user_id) ON DELETE CASCADE,
    device_id text NOT NULL REFERENCES identity.gugu_devices(device_id) ON DELETE CASCADE,
    public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
    commitment text CHECK (commitment ~ '^[0-9a-f]{64}$'),
    approver_device_id text,
    approver_nonce text CHECK (approver_nonce ~ '^[A-Za-z0-9+/]{43}=$'),
    device_nonce text CHECK (device_nonce ~ '^[A-Za-z0-9+/]{43}=$'),
    status text NOT NULL CHECK (status IN ('pending','approved')),
    scope text CHECK (scope IN ('full','granted')),
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    approved_at timestamptz,
    PRIMARY KEY (owner_user_id, device_id),
    CHECK ((status = 'approved') = (scope IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX password_vault_devices_device_idx ON identity.password_vault_devices(device_id);
CREATE TABLE identity.password_vault_items (
    owner_user_id text NOT NULL REFERENCES identity.password_vault_heads(owner_user_id) ON DELETE CASCADE,
    item_id uuid NOT NULL,
    version bigint NOT NULL CHECK (version >= 1),
    key_epoch integer NOT NULL,
    wrapped_key text CHECK (length(wrapped_key) <= 256),
    ciphertext text CHECK (length(ciphertext) <= 524288),
    deleted_at timestamptz,
    revision bigint NOT NULL,
    updated_by_device_id text,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_user_id, item_id),
    CHECK ((deleted_at IS NULL) = (wrapped_key IS NOT NULL AND ciphertext IS NOT NULL))
);
CREATE INDEX password_vault_items_revision_idx ON identity.password_vault_items(owner_user_id, revision);
-- item_id NULL = the vault key share of a full-scope device; otherwise one item key for a granted-scope device.
CREATE TABLE identity.password_vault_shares (
    share_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_user_id text NOT NULL,
    device_id text NOT NULL,
    key_epoch integer NOT NULL,
    item_id uuid,
    sealed text NOT NULL CHECK (length(sealed) <= 256),
    FOREIGN KEY (owner_user_id, device_id) REFERENCES identity.password_vault_devices(owner_user_id, device_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX password_vault_shares_one ON identity.password_vault_shares(owner_user_id, device_id, key_epoch, COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE identity.password_vault_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.password_vault_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.password_vault_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.password_vault_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.password_vault_heads, identity.password_vault_devices, identity.password_vault_items,
    identity.password_vault_shares FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION identity.password_vault_owner(p_device_id text) RETURNS text
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE owner_id text := auth.uid()::text;
BEGIN
    IF owner_id IS NULL OR NOT EXISTS (SELECT 1 FROM identity.users WHERE id = owner_id AND type = 'human' AND removed_at IS NULL) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_ACCOUNT: account is unavailable' USING ERRCODE = '42501';
    END IF;
    IF p_device_id IS NULL OR NOT EXISTS (SELECT 1 FROM identity.gugu_devices WHERE device_id = p_device_id AND user_id::text = owner_id) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_DEVICE: device is not owned' USING ERRCODE = '42501';
    END IF;
    RETURN owner_id;
END;
$$;
-- Serializes every write of one owner and returns the next revision.
CREATE FUNCTION identity.password_vault_write(p_owner text) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE next_revision bigint;
BEGIN
    UPDATE identity.password_vault_heads SET revision = revision + 1, updated_at = clock_timestamp()
     WHERE owner_user_id = p_owner RETURNING revision INTO next_revision;
    IF next_revision IS NULL THEN RAISE EXCEPTION 'PASSWORD_VAULT_STATE: vault is not initialized' USING ERRCODE = '55000'; END IF;
    RETURN next_revision;
END;
$$;
-- The caller must be an approved device; full scope when it manages keys.
CREATE FUNCTION identity.password_vault_member(p_owner text, p_device_id text, p_full boolean) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM identity.password_vault_devices WHERE owner_user_id = p_owner AND device_id = p_device_id
        AND status = 'approved' AND (NOT p_full OR scope = 'full')) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_DEVICE: device is not an approved member' USING ERRCODE = '42501';
    END IF;
END;
$$;
CREATE FUNCTION identity.password_vault_put_shares(p_owner text, p_epoch integer, p_shares jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE share jsonb;
BEGIN
    IF jsonb_typeof(COALESCE(p_shares, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: shares' USING ERRCODE = '22023'; END IF;
    FOR share IN SELECT * FROM jsonb_array_elements(COALESCE(p_shares, '[]'::jsonb)) LOOP
        IF NOT EXISTS (SELECT 1 FROM identity.password_vault_devices WHERE owner_user_id = p_owner AND device_id = share->>'deviceId' AND status = 'approved') THEN
            RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: share for a device that is not approved' USING ERRCODE = '22023';
        END IF;
        INSERT INTO identity.password_vault_shares(owner_user_id, device_id, key_epoch, item_id, sealed)
        VALUES (p_owner, share->>'deviceId', p_epoch, NULLIF(share->>'itemId', '')::uuid, share->>'sealed')
        ON CONFLICT (owner_user_id, device_id, key_epoch, COALESCE(item_id, '00000000-0000-0000-0000-000000000000'::uuid))
        DO UPDATE SET sealed = EXCLUDED.sealed;
    END LOOP;
END;
$$;
-- A deleted approved device (remove_device cascades here) held the current key: the next full device re-keys.
CREATE FUNCTION identity.password_vault_device_gone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF OLD.status = 'approved' THEN
        UPDATE identity.password_vault_heads SET rotation_required = true, revision = revision + 1, updated_at = clock_timestamp()
         WHERE owner_user_id = OLD.owner_user_id;
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER password_vault_device_gone AFTER DELETE ON identity.password_vault_devices
    FOR EACH ROW EXECUTE FUNCTION identity.password_vault_device_gone();

CREATE FUNCTION identity.password_vault_state(p_device_id text, p_since bigint DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id); head identity.password_vault_heads; result jsonb;
    my_scope text;
BEGIN
    SELECT * INTO head FROM identity.password_vault_heads WHERE owner_user_id = owner_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('initialized', false); END IF;
    -- A pending device sees the device list (its own challenge) but no ciphertext; a limited device sees only the items
    -- it holds a key for.
    SELECT scope INTO my_scope FROM identity.password_vault_devices
     WHERE owner_user_id = owner_id AND device_id = p_device_id AND status = 'approved';
    SELECT jsonb_build_object('initialized', true, 'epoch', head.key_epoch, 'revision', head.revision::text,
        'rotationRequired', head.rotation_required, 'recovery', head.recovery_public_key IS NOT NULL,
        'recoveryPublicKey', CASE WHEN my_scope = 'full' THEN head.recovery_public_key END,
        'devices', COALESCE((SELECT jsonb_agg(jsonb_build_object('deviceId', v.device_id, 'label', d.label, 'platform', d.platform,
                'hostKind', d.capabilities->>'host_kind', 'status', v.status, 'scope', v.scope, 'publicKey', v.public_key,
                'commitment', v.commitment, 'approverDeviceId', v.approver_device_id, 'approverNonce', v.approver_nonce,
                'deviceNonce', v.device_nonce, 'requestedAt', v.requested_at, 'approvedAt', v.approved_at) ORDER BY v.requested_at)
            FROM identity.password_vault_devices v JOIN identity.gugu_devices d ON d.device_id = v.device_id
            WHERE v.owner_user_id = owner_id), '[]'::jsonb),
        'shares', COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', s.item_id, 'epoch', s.key_epoch, 'sealed', s.sealed))
            FROM identity.password_vault_shares s WHERE s.owner_user_id = owner_id AND s.device_id = p_device_id AND s.key_epoch = head.key_epoch), '[]'::jsonb),
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId', i.item_id, 'version', i.version::text, 'epoch', i.key_epoch,
                'wrappedKey', i.wrapped_key, 'ciphertext', i.ciphertext, 'deleted', i.deleted_at IS NOT NULL, 'revision', i.revision::text) ORDER BY i.revision)
            FROM identity.password_vault_items i WHERE i.owner_user_id = owner_id AND i.revision > COALESCE(p_since, 0)
              AND (my_scope = 'full' OR (my_scope = 'granted' AND (i.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM identity.password_vault_shares s
                    WHERE s.owner_user_id = owner_id AND s.device_id = p_device_id AND s.item_id = i.item_id AND s.key_epoch = head.key_epoch))))), '[]'::jsonb))
    INTO result;
    RETURN result;
END;
$$;
-- Cheap poll: has anything changed since my revision?
CREATE FUNCTION identity.password_vault_revision(p_device_id text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id);
BEGIN
    RETURN COALESCE((SELECT revision::text FROM identity.password_vault_heads WHERE owner_user_id = owner_id), '0');
END;
$$;
-- The owner's first device creates the vault and holds its first key.
CREATE FUNCTION identity.password_vault_initialize(p_device_id text, p_public_key text, p_sealed_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id);
BEGIN
    INSERT INTO identity.password_vault_heads(owner_user_id, key_epoch) VALUES (owner_id, 1) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'PASSWORD_VAULT_STATE: vault already exists' USING ERRCODE = '55000'; END IF;
    INSERT INTO identity.password_vault_devices(owner_user_id, device_id, public_key, status, scope, approved_at)
    VALUES (owner_id, p_device_id, p_public_key, 'approved', 'full', clock_timestamp());
    PERFORM identity.password_vault_put_shares(owner_id, 1, jsonb_build_array(jsonb_build_object('deviceId', p_device_id, 'sealed', p_sealed_key)));
    RETURN jsonb_build_object('epoch', 1, 'revision', '1');
END;
$$;
-- A device asks to join, or asks again with a fresh key while still pending. An approved device is never replaced
-- here: the account alone (an email code) must not be able to push an approved device out. A reinstalled device whose
-- old entry is still approved is removed first on another approved device (password_vault_rotate) or through
-- remove_device.
CREATE FUNCTION identity.password_vault_request(p_device_id text, p_public_key text, p_commitment text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id); prior identity.password_vault_devices;
BEGIN
    PERFORM identity.password_vault_write(owner_id);
    SELECT * INTO prior FROM identity.password_vault_devices WHERE owner_user_id = owner_id AND device_id = p_device_id FOR UPDATE;
    -- Same key: already a member. Another key (the app was reinstalled and lost its device key): the device asks again
    -- like a new one, its old shares go with the old row, and deleting an approved row marks the vault for re-keying.
    IF FOUND AND prior.status = 'approved' AND prior.public_key = p_public_key THEN RETURN jsonb_build_object('status', 'approved'); END IF;
    IF p_commitment IS NULL THEN RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: commitment' USING ERRCODE = '22023'; END IF;
    DELETE FROM identity.password_vault_devices WHERE owner_user_id = owner_id AND device_id = p_device_id;
    INSERT INTO identity.password_vault_devices(owner_user_id, device_id, public_key, commitment, status)
    VALUES (owner_id, p_device_id, p_public_key, p_commitment, 'pending');
    RETURN jsonb_build_object('status', 'pending');
END;
$$;
-- Step 2: an approved full device posts its nonce, once per request.
CREATE FUNCTION identity.password_vault_challenge(p_approver_device_id text, p_device_id text, p_approver_nonce text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_approver_device_id);
BEGIN
    PERFORM identity.password_vault_member(owner_id, p_approver_device_id, true);
    PERFORM identity.password_vault_write(owner_id);
    UPDATE identity.password_vault_devices SET approver_device_id = p_approver_device_id, approver_nonce = p_approver_nonce
     WHERE owner_user_id = owner_id AND device_id = p_device_id AND status = 'pending' AND approver_nonce IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PASSWORD_VAULT_STATE: request is not waiting for a challenge' USING ERRCODE = '55000'; END IF;
END;
$$;
-- Step 3: the requesting device reveals its nonce after seeing the approver's.
CREATE FUNCTION identity.password_vault_reveal(p_device_id text, p_device_nonce text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id);
BEGIN
    PERFORM identity.password_vault_write(owner_id);
    UPDATE identity.password_vault_devices SET device_nonce = p_device_nonce
     WHERE owner_user_id = owner_id AND device_id = p_device_id AND status = 'pending' AND approver_nonce IS NOT NULL AND device_nonce IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PASSWORD_VAULT_STATE: request is not waiting for a reveal' USING ERRCODE = '55000'; END IF;
END;
$$;
-- Step 4: the person compared the codes on both screens. The approver seals keys to exactly the key it compared.
CREATE FUNCTION identity.password_vault_approve(p_approver_device_id text, p_device_id text, p_public_key text, p_scope text,
    p_epoch integer, p_shares jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_approver_device_id);
BEGIN
    PERFORM identity.password_vault_member(owner_id, p_approver_device_id, true);
    PERFORM identity.password_vault_write(owner_id);
    IF p_scope IS NULL OR p_scope NOT IN ('full','granted') THEN RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: scope' USING ERRCODE = '22023'; END IF;
    IF p_epoch IS DISTINCT FROM (SELECT key_epoch FROM identity.password_vault_heads WHERE owner_user_id = owner_id) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_STALE: key epoch changed' USING ERRCODE = '40001';
    END IF;
    UPDATE identity.password_vault_devices SET status = 'approved', scope = p_scope, approved_at = clock_timestamp()
     WHERE owner_user_id = owner_id AND device_id = p_device_id AND status = 'pending' AND public_key = p_public_key
       AND approver_device_id = p_approver_device_id AND device_nonce IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PASSWORD_VAULT_STATE: request is not ready for approval' USING ERRCODE = '55000'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_shares, '[]'::jsonb)) s WHERE s->>'deviceId' IS DISTINCT FROM p_device_id) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: approval shares belong to the approved device' USING ERRCODE = '22023';
    END IF;
    PERFORM identity.password_vault_put_shares(owner_id, p_epoch, p_shares);
    IF p_scope = 'full' AND NOT EXISTS (SELECT 1 FROM identity.password_vault_shares WHERE owner_user_id = owner_id
        AND device_id = p_device_id AND key_epoch = p_epoch AND item_id IS NULL) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: a full device receives the vault key' USING ERRCODE = '22023';
    END IF;
END;
$$;
-- Nobody can open the vault any more (every approved device is gone, no recovery code): the person starts an empty one.
-- While an approved device or a recovery code exists this is refused; with the code, recover instead.
CREATE FUNCTION identity.password_vault_reset(p_device_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id);
BEGIN
    PERFORM identity.password_vault_write(owner_id);
    IF EXISTS (SELECT 1 FROM identity.password_vault_devices WHERE owner_user_id = owner_id AND status = 'approved')
        OR EXISTS (SELECT 1 FROM identity.password_vault_heads WHERE owner_user_id = owner_id AND recovery_public_key IS NOT NULL) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_STATE: an approved device or the recovery code can still open the vault' USING ERRCODE = '55000';
    END IF;
    DELETE FROM identity.password_vault_heads WHERE owner_user_id = owner_id;
END;
$$;
CREATE FUNCTION identity.password_vault_dismiss(p_caller_device_id text, p_device_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_caller_device_id);
BEGIN
    PERFORM identity.password_vault_write(owner_id);
    DELETE FROM identity.password_vault_devices WHERE owner_user_id = owner_id AND device_id = p_device_id AND status = 'pending';
END;
$$;
-- Create or edit one item. p_expected_version 0 = new. A full device replaces the item's shares for limited devices
-- with p_shares. A limited device holds only item keys: it may rewrite an item it can already read, under the same
-- wrapped key, and leaves every share as it was.
CREATE FUNCTION identity.password_vault_save(p_device_id text, p_item_id uuid, p_expected_version bigint, p_epoch integer,
    p_wrapped_key text, p_ciphertext text, p_shares jsonb DEFAULT '[]'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id); next_revision bigint; current identity.password_vault_items;
    next_version bigint; my_scope text;
BEGIN
    PERFORM identity.password_vault_member(owner_id, p_device_id, false);
    next_revision := identity.password_vault_write(owner_id);
    IF p_epoch IS DISTINCT FROM (SELECT key_epoch FROM identity.password_vault_heads WHERE owner_user_id = owner_id) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_STALE: key epoch changed' USING ERRCODE = '40001';
    END IF;
    IF p_item_id IS NULL OR p_expected_version IS NULL OR p_wrapped_key IS NULL OR p_ciphertext IS NULL THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: item' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO current FROM identity.password_vault_items WHERE owner_user_id = owner_id AND item_id = p_item_id FOR UPDATE;
    IF COALESCE(current.version, 0) <> p_expected_version THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_STALE: item changed' USING ERRCODE = '40001';
    END IF;
    SELECT scope INTO my_scope FROM identity.password_vault_devices WHERE owner_user_id = owner_id AND device_id = p_device_id;
    IF my_scope = 'granted' AND (current.wrapped_key IS NULL OR current.wrapped_key <> p_wrapped_key OR NOT EXISTS (
        SELECT 1 FROM identity.password_vault_shares WHERE owner_user_id = owner_id AND device_id = p_device_id
           AND item_id = p_item_id AND key_epoch = p_epoch)) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_DEVICE: this device may only edit items it holds' USING ERRCODE = '42501';
    END IF;
    IF current.item_id IS NULL AND (SELECT count(*) FROM identity.password_vault_items WHERE owner_user_id = owner_id) >= 10000 THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_LIMIT: too many items' USING ERRCODE = '54000';
    END IF;
    next_version := p_expected_version + 1;
    INSERT INTO identity.password_vault_items(owner_user_id, item_id, version, key_epoch, wrapped_key, ciphertext, revision, updated_by_device_id)
    VALUES (owner_id, p_item_id, next_version, p_epoch, p_wrapped_key, p_ciphertext, next_revision, p_device_id)
    ON CONFLICT (owner_user_id, item_id) DO UPDATE SET version = EXCLUDED.version, key_epoch = EXCLUDED.key_epoch,
        wrapped_key = EXCLUDED.wrapped_key, ciphertext = EXCLUDED.ciphertext, deleted_at = NULL, revision = EXCLUDED.revision,
        updated_by_device_id = EXCLUDED.updated_by_device_id, updated_at = clock_timestamp();
    IF my_scope = 'full' THEN
        DELETE FROM identity.password_vault_shares WHERE owner_user_id = owner_id AND item_id = p_item_id;
        PERFORM identity.password_vault_put_shares(owner_id, p_epoch, (SELECT COALESCE(jsonb_agg(s || jsonb_build_object('itemId', p_item_id)), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(p_shares, '[]'::jsonb)) s));
    END IF;
    RETURN jsonb_build_object('version', next_version::text, 'revision', next_revision::text);
END;
$$;
CREATE FUNCTION identity.password_vault_delete(p_device_id text, p_item_id uuid, p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id); next_revision bigint;
BEGIN
    PERFORM identity.password_vault_member(owner_id, p_device_id, true);
    next_revision := identity.password_vault_write(owner_id);
    UPDATE identity.password_vault_items SET version = version + 1, wrapped_key = NULL, ciphertext = NULL, deleted_at = clock_timestamp(),
        revision = next_revision, updated_by_device_id = p_device_id, updated_at = clock_timestamp()
     WHERE owner_user_id = owner_id AND item_id = p_item_id AND version = p_expected_version AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PASSWORD_VAULT_STALE: item changed' USING ERRCODE = '40001'; END IF;
    DELETE FROM identity.password_vault_shares WHERE owner_user_id = owner_id AND item_id = p_item_id;
    RETURN jsonb_build_object('revision', next_revision::text);
END;
$$;
-- Re-key: remove devices, move every live item to epoch+1 and replace every share, all or nothing.
-- p_items: [{itemId, expectedVersion, wrappedKey, ciphertext}] must cover every live item exactly once.
-- p_recovery: NULL drops the recovery code; {sealed} keeps it, re-sealed to its public key; {publicKey, verifier, sealed}
-- replaces it with a new code.
CREATE FUNCTION identity.password_vault_rotate(p_device_id text, p_epoch integer, p_remove_device_ids text[], p_items jsonb, p_shares jsonb,
    p_recovery jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id); next_revision bigint; next_epoch integer; live integer; item jsonb;
BEGIN
    PERFORM identity.password_vault_member(owner_id, p_device_id, true);
    IF p_device_id = ANY(COALESCE(p_remove_device_ids, '{}')) THEN RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: cannot remove itself' USING ERRCODE = '22023'; END IF;
    next_revision := identity.password_vault_write(owner_id);
    IF p_epoch IS DISTINCT FROM (SELECT key_epoch FROM identity.password_vault_heads WHERE owner_user_id = owner_id) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_STALE: key epoch changed' USING ERRCODE = '40001';
    END IF;
    SELECT count(*) INTO live FROM identity.password_vault_items WHERE owner_user_id = owner_id AND deleted_at IS NULL;
    IF jsonb_typeof(COALESCE(p_items, '[]'::jsonb)) <> 'array' OR live <> jsonb_array_length(COALESCE(p_items, '[]'::jsonb))
        OR live <> (SELECT count(DISTINCT x->>'itemId') FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) x) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_STALE: items changed' USING ERRCODE = '40001';
    END IF;
    next_epoch := p_epoch + 1;
    DELETE FROM identity.password_vault_devices WHERE owner_user_id = owner_id AND device_id = ANY(COALESCE(p_remove_device_ids, '{}'));
    DELETE FROM identity.password_vault_shares WHERE owner_user_id = owner_id;
    FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
        UPDATE identity.password_vault_items SET version = version + 1, key_epoch = next_epoch, wrapped_key = item->>'wrappedKey',
            ciphertext = item->>'ciphertext', revision = next_revision, updated_by_device_id = p_device_id, updated_at = clock_timestamp()
         WHERE owner_user_id = owner_id AND item_id = (item->>'itemId')::uuid AND deleted_at IS NULL AND version = (item->>'expectedVersion')::bigint;
        IF NOT FOUND THEN RAISE EXCEPTION 'PASSWORD_VAULT_STALE: item changed' USING ERRCODE = '40001'; END IF;
    END LOOP;
    UPDATE identity.password_vault_heads SET key_epoch = next_epoch, rotation_required = false,
        recovery_public_key = CASE WHEN p_recovery IS NULL THEN NULL ELSE COALESCE(p_recovery->>'publicKey', recovery_public_key) END,
        recovery_verifier = CASE WHEN p_recovery IS NULL THEN NULL ELSE COALESCE(p_recovery->>'verifier', recovery_verifier) END,
        recovery_sealed = p_recovery->>'sealed'
     WHERE owner_user_id = owner_id;
    PERFORM identity.password_vault_put_shares(owner_id, next_epoch, p_shares);
    -- Every full device that stays (the rotating one included) receives the new vault key.
    IF EXISTS (SELECT 1 FROM identity.password_vault_devices v WHERE v.owner_user_id = owner_id AND v.status = 'approved' AND v.scope = 'full'
        AND NOT EXISTS (SELECT 1 FROM identity.password_vault_shares s WHERE s.owner_user_id = owner_id AND s.device_id = v.device_id
            AND s.key_epoch = next_epoch AND s.item_id IS NULL)) THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_INPUT: every remaining full device receives the new key' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('epoch', next_epoch, 'revision', next_revision::text);
END;
$$;

-- First recovery code (none yet): a full device seals the current vault key to the code's public key. Replacing or
-- dropping an existing code goes through password_vault_rotate, so the old code stops opening anything.
CREATE FUNCTION identity.password_vault_set_recovery(p_device_id text, p_epoch integer, p_public_key text, p_verifier text, p_sealed text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id);
BEGIN
    PERFORM identity.password_vault_member(owner_id, p_device_id, true);
    PERFORM identity.password_vault_write(owner_id);
    UPDATE identity.password_vault_heads SET recovery_public_key = p_public_key, recovery_verifier = p_verifier, recovery_sealed = p_sealed
     WHERE owner_user_id = owner_id AND key_epoch = p_epoch AND recovery_public_key IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'PASSWORD_VAULT_STALE: epoch changed or a recovery code exists' USING ERRCODE = '40001'; END IF;
END;
$$;
CREATE FUNCTION identity.password_vault_recovery_proven(p_owner text, p_proof text) RETURNS identity.password_vault_heads
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE head identity.password_vault_heads;
BEGIN
    SELECT * INTO head FROM identity.password_vault_heads WHERE owner_user_id = p_owner;
    IF head.recovery_verifier IS NULL OR p_proof IS NULL OR p_proof !~ '^[A-Za-z0-9+/]{43}=$'
        OR encode(sha256(decode(p_proof, 'base64')), 'hex') <> head.recovery_verifier THEN
        RAISE EXCEPTION 'PASSWORD_VAULT_RECOVERY: recovery code does not match' USING ERRCODE = '42501';
    END IF;
    RETURN head;
END;
$$;
-- Recovery, step 1: with the account and the code's proof, a device receives the vault key sealed to the code.
CREATE FUNCTION identity.password_vault_recovery_begin(p_device_id text, p_proof text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE head identity.password_vault_heads := identity.password_vault_recovery_proven(identity.password_vault_owner(p_device_id), p_proof);
BEGIN
    RETURN jsonb_build_object('epoch', head.key_epoch, 'sealed', head.recovery_sealed);
END;
$$;
-- Step 2: the device joins as a full member holding the key it opened, replacing any earlier entry of its own, and the
-- code is used up.
CREATE FUNCTION identity.password_vault_recover(p_device_id text, p_proof text, p_public_key text, p_epoch integer, p_sealed_key text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE owner_id text := identity.password_vault_owner(p_device_id); head identity.password_vault_heads; next_revision bigint;
BEGIN
    next_revision := identity.password_vault_write(owner_id);
    head := identity.password_vault_recovery_proven(owner_id, p_proof);
    IF p_epoch IS DISTINCT FROM head.key_epoch THEN RAISE EXCEPTION 'PASSWORD_VAULT_STALE: key epoch changed' USING ERRCODE = '40001'; END IF;
    DELETE FROM identity.password_vault_devices WHERE owner_user_id = owner_id AND device_id = p_device_id;
    INSERT INTO identity.password_vault_devices(owner_user_id, device_id, public_key, status, scope, approved_at)
    VALUES (owner_id, p_device_id, p_public_key, 'approved', 'full', clock_timestamp());
    PERFORM identity.password_vault_put_shares(owner_id, p_epoch, jsonb_build_array(jsonb_build_object('deviceId', p_device_id, 'sealed', p_sealed_key)));
    UPDATE identity.password_vault_heads SET recovery_public_key = NULL, recovery_verifier = NULL, recovery_sealed = NULL
     WHERE owner_user_id = owner_id;
    RETURN jsonb_build_object('epoch', p_epoch, 'revision', next_revision::text);
END;
$$;

REVOKE ALL ON FUNCTION identity.password_vault_owner(text), identity.password_vault_write(text),
    identity.password_vault_member(text,text,boolean), identity.password_vault_put_shares(text,integer,jsonb),
    identity.password_vault_device_gone(), identity.password_vault_state(text,bigint), identity.password_vault_revision(text),
    identity.password_vault_initialize(text,text,text), identity.password_vault_request(text,text,text),
    identity.password_vault_challenge(text,text,text), identity.password_vault_reveal(text,text),
    identity.password_vault_approve(text,text,text,text,integer,jsonb), identity.password_vault_dismiss(text,text),
    identity.password_vault_reset(text),
    identity.password_vault_save(text,uuid,bigint,integer,text,text,jsonb), identity.password_vault_delete(text,uuid,bigint),
    identity.password_vault_rotate(text,integer,text[],jsonb,jsonb,jsonb),
    identity.password_vault_set_recovery(text,integer,text,text,text), identity.password_vault_recovery_proven(text,text),
    identity.password_vault_recovery_begin(text,text), identity.password_vault_recover(text,text,text,integer,text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION identity.password_vault_state(text,bigint), identity.password_vault_revision(text),
    identity.password_vault_initialize(text,text,text), identity.password_vault_request(text,text,text),
    identity.password_vault_challenge(text,text,text), identity.password_vault_reveal(text,text),
    identity.password_vault_approve(text,text,text,text,integer,jsonb), identity.password_vault_dismiss(text,text),
    identity.password_vault_reset(text),
    identity.password_vault_save(text,uuid,bigint,integer,text,text,jsonb), identity.password_vault_delete(text,uuid,bigint),
    identity.password_vault_rotate(text,integer,text[],jsonb,jsonb,jsonb),
    identity.password_vault_set_recovery(text,integer,text,text,text), identity.password_vault_recovery_begin(text,text),
    identity.password_vault_recover(text,text,text,integer,text)
    TO authenticated;
