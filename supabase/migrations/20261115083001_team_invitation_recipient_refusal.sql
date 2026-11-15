-- Refuse unapproved recipients without taking a send lease or quota slot.
-- Preserve the previous mail receipt and locking rules in this forward change.
ALTER TABLE team_private.mail_deliveries DROP CONSTRAINT mail_deliveries_reason_code_check;
ALTER TABLE team_private.mail_deliveries ADD CONSTRAINT mail_deliveries_reason_code_check
  CHECK(reason_code IS NULL OR reason_code IN ('smtp_accepted','smtp_rejected','smtp_result_unknown',
    'identity_unavailable','code_accepted','code_result_unknown','lease_expired','recipient_not_allowed'));
DO $recipient_refusal$
DECLARE definition text; anchor text;
BEGIN
  SELECT pg_get_functiondef('public.team_mail_delivery(text,jsonb,uuid,uuid,inet)'::regprocedure) INTO definition;
  anchor:=$needle$  IF p_action NOT IN ('prepare','claim','complete_code')$needle$;
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected mail admission predecessor'; END IF;
  definition:=replace(definition,anchor,$replacement$  IF p_action NOT IN ('prepare','claim','complete_code','reject_recipient')
    OR p_action='reject_recipient' AND p_input->>'kind' IS DISTINCT FROM 'invitation'$replacement$);
  anchor:=$needle$('smtp_accepted','smtp_rejected','smtp_result_unknown','identity_unavailable','code_accepted','code_result_unknown')$needle$;
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected mail result predecessor'; END IF;
  definition:=replace(definition,anchor,$replacement$('smtp_accepted','smtp_rejected','smtp_result_unknown','identity_unavailable','code_accepted','code_result_unknown','recipient_not_allowed')$replacement$);
  anchor:=$needle$('smtp_rejected','identity_unavailable')$needle$;
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected mail failure predecessor'; END IF;
  definition:=replace(definition,anchor,$replacement$('smtp_rejected','identity_unavailable','recipient_not_allowed')$replacement$);
  anchor:=$needle$  IF delivery.state='sending' AND delivery.lease_expires_at<=stamp THEN$needle$;
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unexpected mail lease predecessor'; END IF;
  definition:=replace(definition,anchor,$replacement$  IF p_action='reject_recipient' AND delivery.state='pending' THEN
    UPDATE team_private.mail_deliveries SET state='failed',reason_code='recipient_not_allowed',finished_at=stamp
      WHERE id=delivery.id RETURNING * INTO delivery;
  END IF;
$replacement$||anchor);
  EXECUTE definition;
END $recipient_refusal$;
