-- The storage panel states the idle-expiry policy it is subject to: chat.file_storage_overview_as also returns
-- `expiry` ({large_file_bytes, idle_seconds} from the global file transfer limits, or null when none is set), so the
-- client's wording comes from the same settings chat.file_transfer_expire reads. Same function, one more field;
-- CREATE OR REPLACE, so applying it again changes nothing.
CREATE OR REPLACE FUNCTION chat.file_storage_overview_as() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE me text:=auth.uid()::text; result jsonb;
BEGIN
    IF me IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING HINT='file_transfer_denied'; END IF;
    WITH mine AS (
        SELECT ref.storage_id,ref.chat_id,ref.expires_at,o.size_bytes,o.blob_id,
            CASE WHEN b.content_type LIKE 'image/%' THEN 'image' WHEN ref.expires_at IS NOT NULL THEN 'temporary' ELSE 'kept' END AS class
        FROM chat.file_transfer_storage_refs ref JOIN chat.file_transfer_storage o ON o.id=ref.storage_id JOIN chat.file_blobs b ON b.id=o.blob_id
        WHERE ref.account_id=me AND ref.expired_at IS NULL AND o.state='ready'
    ), devices AS (SELECT device_id,label FROM identity.gugu_devices WHERE user_id::text=me)
    SELECT jsonb_build_object(
        'total_bytes',COALESCE((SELECT sum(size_bytes) FROM (SELECT DISTINCT ON (storage_id) storage_id,size_bytes FROM mine) d),0),
        'count',(SELECT count(*) FROM mine),
        'expiring_7d_bytes',COALESCE((SELECT sum(size_bytes) FROM mine WHERE expires_at<=now()+interval '7 days'),0),
        -- The idle-expiry policy chat.file_transfer_expire applies (larger than large_file_bytes, unopened for
        -- large_file_idle_seconds, project chats exempt); null when the deployment sets no such policy.
        'expiry',(SELECT CASE WHEN l.settings ?& ARRAY['large_file_bytes','large_file_idle_seconds'] THEN jsonb_build_object(
            'large_file_bytes',chat.file_transfer_parameter(l.settings,'large_file_bytes'),
            'idle_seconds',chat.file_transfer_parameter(l.settings,'large_file_idle_seconds')) END
            FROM chat.file_transfer_limits l WHERE l.scope='global' AND l.scope_id='*'),
        'classes',(SELECT jsonb_object_agg(c.class,jsonb_build_object('bytes',COALESCE(s.bytes,0),'count',COALESCE(s.n,0)))
            FROM (VALUES('image'),('temporary'),('kept')) c(class)
            LEFT JOIN (SELECT class,sum(size_bytes) bytes,count(*) n FROM mine GROUP BY class) s ON s.class=c.class),
        'groups',COALESCE((SELECT jsonb_agg(g ORDER BY (g->>'bytes')::bigint DESC) FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'name',c.name,'project',EXISTS(SELECT 1 FROM identity.device_projects dp WHERE dp.chat_id=m.chat_id),
                'bytes',sum(m.size_bytes),'count',count(*)) g
            FROM mine m JOIN chat.chats c ON c.id=m.chat_id GROUP BY m.chat_id,c.name) gs),'[]'::jsonb),
        'expiring',COALESCE((SELECT jsonb_agg(e ORDER BY e->>'expires_at') FROM (
            SELECT jsonb_build_object('chat_id',m.chat_id,'expires_at',m.expires_at,'bytes',m.size_bytes,'class',m.class,
                'item_id',w.id,'file_name',w.filename) e
            FROM mine m LEFT JOIN LATERAL (SELECT i.id,i.filename FROM chat.workspace_items i WHERE i.chat_id=m.chat_id AND i.blob_id=m.blob_id LIMIT 1) w ON true
            WHERE m.expires_at IS NOT NULL ORDER BY m.expires_at LIMIT 20) es),'[]'::jsonb),
        'machines',COALESCE((SELECT jsonb_agg(jsonb_build_object('device_id',d.device_id,'label',d.label,'files',s.files,'bytes',s.bytes,
                'temporary_copy_bytes',s.copies))
            FROM devices d JOIN LATERAL (
                SELECT count(*) files,COALESCE(sum(r.size_bytes),0) bytes,
                    COALESCE((SELECT sum(t.ciphertext_bytes) FROM chat.file_temporary_transfers t
                        WHERE t.host_device_id=d.device_id AND t.state IN ('uploading','ready')),0) copies
                FROM chat.file_device_revisions r JOIN chat.workspace_items w ON w.id=r.item_id AND w.version=r.version
                WHERE r.host_device_id=d.device_id) s ON true),'[]'::jsonb)
    ) INTO result;
    RETURN result;
END $$;

-- The installation DDL guard closes every replaced function; restore its intended grant.
REVOKE ALL ON FUNCTION chat.file_storage_overview_as() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION chat.file_storage_overview_as() TO authenticated;

NOTIFY pgrst,'reload schema';
