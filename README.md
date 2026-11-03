# Gugu backend

English | [简体中文](README.zh-CN.md)

The community backend of [Gugu](https://github.com/OpenDCAI/gugu): identity, messaging, sync, device communication, permissions and basic file services, running on your own Supabase project. Official cloud hosting, plans, the model gateway and payments are operated separately, are not part of the open-source release, and are not needed for a community installation.

Licensed under a modified Apache License 2.0 — see [LICENSE](LICENSE). Personal use and use inside one organization need no commercial license; operating a hosted multi-tenant service for unrelated customers does. The full Apache 2.0 text is in [LICENSE-APACHE-2.0](LICENSE-APACHE-2.0).

## Install on your own Supabase Cloud project

Step-by-step guide: [docs/self-hosting.md](docs/self-hosting.md); SMTP setup: [docs/self-hosting-smtp.md](docs/self-hosting-smtp.md); free plan and troubleshooting: [docs/self-hosting-free-plan.md](docs/self-hosting-free-plan.md).

You need Node 24, pnpm 10.28.2, your own Supabase account and a brand-new dedicated Postgres 17 project.

```sh
pnpm install --frozen-lockfile
# Set SUPABASE_PROJECT_REF and SUPABASE_ACCESS_TOKEN locally; never paste them into chat or commit them.
pnpm run setup --client-dir /path/to/gugu
```

The tool checks that the project is empty, installs the foundation in one transaction and then the later releases in order; it configures the API schemas, deploys the server-login and attachments functions, schedules attachment cleanup, and finally writes the client's `.envs/local.env`. The client file holds only the public URL and anon key; official hosting, official models and the official relay stay disabled. Models are configured in the client with your own Claude account or API key.

Re-running only accepts an installation with matching versions and digests; an unknown schema or a different installation digest is refused without deleting data or rewriting the installation ledger. SMTP and project administration are up to the installer; sign-in needs custom SMTP because the client signs in with an emailed code.

## Foundation, releases and permissions

- `supabase/migrations/20261021000000_foundation.sql` is the foundation: RLS, Auth triggers, Realtime authorization, Storage policies and three maintenance jobs. It is for new projects only.
- Every later `supabase/migrations/<version>_<name>.sql` is a release, installed in order and recorded in `gugu_install.releases`. Published files are never edited, except for the explicitly checked [workspace index split](docs/concurrent-index-releases.md); other changes ship as new files.
- New API functions are closed to clients by default and granted explicitly in the release that adds them.
- `identity.machine_limits_for(uuid)` is the installation policy hook; the community edition uses installation-level settings. Device ownership, group membership, message and file permissions are all enforced by the database.

The topic-resource release requires coordinated file-service and client updates; see [topic resource containers and upgrade behavior](docs/topic-resources.md).

The archived-device CHECK is replaced without scanning under its strong lock, then
validated after COMMIT; see [constraint validation releases](docs/constraint-validation-releases.md).

## File service

Attachment upload, commit and signed download use your own Supabase Storage.

Managed transfers require explicit storage/download budgets, trusted inventory and compatible provider limits; see [file transfer budgets and operations](docs/file-transfer-budgets.md). Upload requests must supply their declared size, actor and group scope. Missing configuration refuses issuance, and short bearer URLs are not a hard total-byte cap.

Collaborative file editing needs the long-running Node service in `services/files`; Supabase Cloud does not run it for you. It uses a dedicated `gugu_files` database role, the project's JWKS and an HTTPS/WebSocket endpoint; see `services/files/src/config.mjs` and `docs/files-service.md`.

## Local verification

For a self-managed Kong gateway, the versioned [gateway policies](deploy/kong/README.md)
define REST preflight caching, Storage range-response header exposure, and the
admin routes that only the service-role key may use.

On a development machine with Docker:

```sh
pnpm test:db:start
export GUGU_INSTALL_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable'
export GUGU_INTEGRATION_DATABASE_URL="$GUGU_INSTALL_TEST_DATABASE_URL"
pnpm test:installation
pnpm test
pnpm test:integration
pnpm test:db:stop
```

`GUGU_TEST_DB_PORT` selects a free port. The script manages only the test project tagged for this checkout and binds the database to loopback; `stop` deletes this disposable database's volume. Installation tests require an empty database.

The client repository's `supabase-contract` test project connects to this test database to verify the client–backend contract.
