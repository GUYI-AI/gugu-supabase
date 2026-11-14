-- gugu:transaction off
-- Validate existing rows after the schema transaction releases its strong locks.
ALTER TABLE identity.feedback VALIDATE CONSTRAINT feedback_screenshot_paths_count;
