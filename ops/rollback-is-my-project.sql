-- Roll back 20261112120000_is_my_project: the function goes (clients that call it fall back to nothing: roll the
-- desktop build back first). Run on that release's schema only.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP FUNCTION identity.is_my_project(text);
COMMIT;
