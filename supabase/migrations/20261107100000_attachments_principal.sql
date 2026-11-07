-- The attachments function asked Auth (getUser) who was calling on every request: a second server round trip, about
-- 110 ms as the client sees it. PostgREST has already verified the JWT's signature and expiry before this runs; this
-- answers the rest: the token's session must still exist (a revoked or signed-out session is refused at once, not when
-- the token expires), and the account must be neither banned nor deleted.
CREATE FUNCTION chat.attachments_principal() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT u.id::text FROM auth.users u
    WHERE u.id=auth.uid() AND u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=now())
      AND (NULLIF(auth.jwt()->>'session_id','') IS NULL OR EXISTS(SELECT 1 FROM auth.sessions s
          WHERE s.id=(auth.jwt()->>'session_id')::uuid AND s.user_id=u.id AND (s.not_after IS NULL OR s.not_after>now())))
$$;
REVOKE ALL ON FUNCTION chat.attachments_principal() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.attachments_principal() TO authenticated;
