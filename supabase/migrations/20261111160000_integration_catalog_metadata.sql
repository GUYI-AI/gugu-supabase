-- Provider directory rows (integrations `catalog:<provider>`) may carry the
-- provider's public category and search aliases: `catalog` =
-- `{categoryId, aliases?}`. Clients since 0.3.2 (GUYI-AI/gugu#1936) send it on
-- every directory row, legacy panel and owner connection writes alike. The
-- previous allowlist refused those rows, so the device's integrations
-- collection stayed in `error` and the connection cutover kept the account
-- legacy (CONNECTION_CUTOVER_COLLECTION_NOT_READY).
-- The field is stored, not stripped: those clients compare the stored metadata
-- with what they observe and would rewrite every directory row on each pass.
-- It is accepted only on directory rows and only in that bounded shape; account
-- rows, other domains and every other nested value are still refused.
-- identity.assistant_panel_validate is patched in place (one anchored span per
-- step), so all three callers (assistant_panel_commit, connection_prepare_import,
-- connection_commit) accept the same shape.
DO $catalog_metadata$
DECLARE fn regprocedure := to_regprocedure('identity.assistant_panel_validate(text,text,jsonb)'); v_definition text; spec record;
BEGIN
    IF fn IS NULL THEN RAISE EXCEPTION 'Install the assistant panel release first'; END IF;
    v_definition := pg_get_functiondef(fn);
    FOR spec IN SELECT * FROM (VALUES
      (1,$anchor$'checkResult','checkedAt','permission','enabled']$anchor$,
         $patch$'checkResult','checkedAt','permission','enabled','catalog']$patch$),
      (2,$anchor$AND e.key NOT IN ('assistantSessionIds','sourceLinks','lastRun')) THEN$anchor$,
         $patch$AND e.key NOT IN ('assistantSessionIds','sourceLinks','lastRun','catalog')) THEN$patch$),
      (3,$anchor$    IF p_data ? 'enabled' AND jsonb_typeof(p_data->'enabled') <> 'boolean' THEN$anchor$,
         $patch$    -- A provider directory row's public category and search aliases; nowhere else.
    IF p_data ? 'catalog' AND (p_domain <> 'integrations' OR NOT starts_with(p_key,'catalog:')
        OR p_data->'catalog' <> 'null'::jsonb AND (
            jsonb_typeof(p_data->'catalog') <> 'object'
            OR EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_data->'catalog') = 'object'
                THEN p_data->'catalog' ELSE '{}'::jsonb END) k WHERE k NOT IN ('categoryId','aliases'))
            OR jsonb_typeof(p_data->'catalog'->'categoryId') IS DISTINCT FROM 'string'
            OR p_data->'catalog'->>'categoryId' !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
            OR p_data->'catalog' ? 'aliases' AND (
                jsonb_typeof(p_data->'catalog'->'aliases') IS DISTINCT FROM 'array'
                OR CASE WHEN jsonb_typeof(p_data->'catalog'->'aliases') = 'array'
                    THEN jsonb_array_length(p_data->'catalog'->'aliases') > 32 ELSE false END
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'catalog'->'aliases') = 'array'
                    THEN p_data->'catalog'->'aliases' ELSE '[]'::jsonb END) a
                    WHERE jsonb_typeof(a) <> 'string' OR length(a #>> '{}') NOT BETWEEN 1 AND 128 OR a #>> '{}' ~ '[[:cntrl:]]')))) THEN
        RAISE EXCEPTION 'Panel catalog must be a provider directory category with search aliases' USING ERRCODE = '22023';
    END IF;
    IF p_data ? 'enabled' AND jsonb_typeof(p_data->'enabled') <> 'boolean' THEN$patch$)
    ) AS patches(step,anchor,replacement) ORDER BY step
    LOOP
        IF (length(v_definition)-length(replace(v_definition,spec.anchor,'')))/length(spec.anchor) <> 1 THEN
            RAISE EXCEPTION 'Assistant panel validation has an unexpected body (step %)',spec.step;
        END IF;
        v_definition := replace(v_definition,spec.anchor,spec.replacement);
    END LOOP;
    EXECUTE v_definition;
END;
$catalog_metadata$;
