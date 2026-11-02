# Community backend

This repository owns identity, messaging, sync, device RPC, permissions and basic file services. Official hosting, model gateway and payment implementations are maintained privately and do not belong here.

Use Node 24 and the pinned pnpm version. Tests that write data require a disposable loopback database. Preserve old deployment schemas and migration ledgers. Never apply the new foundation to an existing deployment or reset a database to make a test pass.

Functions start closed to API roles; each migration must grant only intended access. Preserve RLS, device ownership, message scope and file authorization. Do not turn denied or unavailable services into successful empty responses.

No credentials, tokens, user data or private deployment configuration in source, issues or logs.

Account revision events must remain backward compatible: new events may only add information. Existing state changes must continue using existing events without changing their payload meanings. Do not add new revision events until clients that skip unknown events have shipped and older clients have been retired. New handlers must be idempotent and act only on their own state, so upgrade replay can safely follow already-applied events.
