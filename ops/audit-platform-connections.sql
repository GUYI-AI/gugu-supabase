-- Run as the authenticated owner in a disposable database or through an
-- explicitly approved read-only maintenance session. No migration is performed.
-- Export the single JSON result without psql headers/footers; body bytes must
-- separately be downloaded through the existing owner's authorized file API.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '2s';
SET LOCAL lock_timeout = '250ms';
DO $audit$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Connection audit requires an authenticated owner' USING ERRCODE = '42501';
    END IF;
END;
$audit$;

WITH assistants AS (
    SELECT DISTINCT u.id
    FROM identity.users u
    JOIN identity.agent_provisions p ON p.agent_user_id = u.id
    WHERE u.owner_user_id = auth.uid()::text AND u.type = 'agent'
      AND p.owner_user_id = auth.uid()::text AND p.member_key = 'assistant'
      AND p.phase IN ('ready', 'completed')
), chosen AS (
    SELECT count(*) AS n, min(id) AS id FROM assistants
), inventory AS (
SELECT jsonb_build_object(
    'version', 1, 'complete', true, 'ownerId', auth.uid()::text,
    'identityState', CASE chosen.n WHEN 0 THEN 'none' WHEN 1 THEN 'found' ELSE 'ambiguous' END,
    'assistantId', chosen.id,
    'headRevision', COALESCE((SELECT revision::text FROM identity.assistant_panel_items
        WHERE assistant_user_id = chosen.id AND owner_user_id = auth.uid()::text
          AND domain = 'control' AND resource_key = '__head__'), '0'),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(i) || jsonb_build_object('revision', i.revision::text)
        ORDER BY i.resource_key) FROM identity.assistant_panel_items i
        WHERE i.assistant_user_id = chosen.id AND i.owner_user_id = auth.uid()::text
          AND i.domain = 'integrations'), '[]'::jsonb),
    'operations', COALESCE((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object(
        'revision', c.revision::text, 'expected_item_revision', c.expected_item_revision::text) ORDER BY c.revision)
        FROM identity.assistant_panel_changes c
        WHERE c.assistant_user_id = chosen.id AND c.owner_user_id = auth.uid()::text
          AND c.domain = 'integrations' AND c.source = 'panel' AND c.status IN ('pending', 'failed')), '[]'::jsonb)
) AS snapshot FROM chosen
)
SELECT snapshot || jsonb_build_object('databaseDigest',
    encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex')) AS inventory FROM inventory;
ROLLBACK;
