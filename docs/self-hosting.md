# Self-hosting Gugu on Supabase Cloud

This guide takes you from nothing to a working Gugu: the community backend on your own Supabase Cloud project, the desktop client built from source and connected to it. It was written from a full run on a new **free-plan** project. Plan limits and troubleshooting are in [self-hosting-free-plan.md](self-hosting-free-plan.md).

## What you get

| Included | Not included |
| --- | --- |
| Email sign-in, profiles, contacts and friend requests | Official cloud hosting (cloud computers) |
| Direct and group chat, agents in groups, real-time updates | Official models and model gateway |
| Attachments on your own Supabase Storage | Plans, payments and memberships |
| Local agent sessions using your own Claude / Codex / other CLI login | The remote-tunnel relay (remote terminal, browser, ports) |
| Device registration and permissions enforced by the database | Collaborative file editing, unless you also run `services/files` ([files-service.md](files-service.md)) |

Models run through the agent CLIs on your machine with your own account or API key.

## Prerequisites

- Node 24 and pnpm 10.28.2 (check `node -v`; a system Node 22/23 will not do).
- Git, and on macOS the Xcode command line tools (native modules are rebuilt for Electron).
- A Supabase account. A brand-new, empty project dedicated to Gugu (Postgres 17). Do not reuse a project that has other data.
- An SMTP provider for sign-in email ([self-hosting-smtp.md](self-hosting-smtp.md)). Without it nobody can sign in.

## 1. Create the Supabase project

In the [dashboard](https://supabase.com/dashboard) create a project in the region closest to your users. Save the database password somewhere safe; Gugu's setup does not need it. Note the **project ref**: the `<ref>` in `https://<ref>.supabase.co`.

## 2. Create an access token

Setup talks to the Supabase Management API and CLI, so it needs a personal access token. Signing in to the dashboard is not enough.

1. Open [Account → Access Tokens](https://supabase.com/dashboard/account/tokens) → **Generate new token**.
2. Scope: **Project**, pick your organization and **only the Gugu project**. Check the project list: the form may pre-select another project. Permissions: **Full access** (setup writes SQL, deploys functions, sets secrets and reads API keys). Short expiry is fine, as setup only runs while you install or upgrade.
3. Keep the token in a local file with mode `0600` or in your shell only. Never commit it or paste it into chat. Delete it when you are done.

## 3. Configure SMTP

The client signs in with a 6-digit code sent by email, so you need your own SMTP service. Supabase's built-in sender only delivers to members of your Supabase organization, at 2 emails per hour, and its templates carry no code.

Follow [self-hosting-smtp.md](self-hosting-smtp.md): pick a provider (guides for Resend, Brevo, AWS SES and others), enable custom SMTP under **Authentication → Emails → SMTP Settings**, and raise the email rate limit.

You can also run setup first and add SMTP later, but sign-in will not work until you re-run setup after configuring SMTP.

## 4. Install the backend

```sh
git clone https://github.com/OpenDCAI/gugu-supabase.git
git clone https://github.com/OpenDCAI/gugu.git
cd gugu-supabase
pnpm install --frozen-lockfile
export SUPABASE_PROJECT_REF=<ref>
export SUPABASE_ACCESS_TOKEN="$(cat /path/to/token-file)"
pnpm run setup --client-dir ../gugu
```

Use `pnpm run setup`: plain `pnpm setup` is pnpm's own built-in command and fails with `Unknown option: 'client-dir'`.

Setup installs the database foundation and every release, exposes the `identity`, `chat` and `moments` API schemas, and deploys the `server-login` and `attachments` functions. It also schedules attachment clean-up and sets sign-in codes to 6 digits. With SMTP configured, it adds the code to the sign-in and sign-up email templates. Finally it writes `../gugu/.envs/local.env` with the project URL and the public anon key, with official hosting, official models and the relay turned off.

**Attachment size.** The `attachments` function hashes every uploaded file inside its Edge worker, and Supabase Edge Functions allow 2 seconds of CPU per request. On a CPU without SHA extensions, SHA-256 alone takes 1.1–1.5 s of CPU per 200 MiB, and reading the stream adds to it, so 100 MiB sits at the limit: the same 100 MiB commit sometimes finishes and sometimes is stopped by the CPU limit, and 200 MiB is always stopped. Supabase Cloud hardware may differ, so keep the `attachments` bucket's file size limit and `file_max_bytes` at or below 50 MiB. Larger files upload and then fail to send.

Expected output ends with `Database and functions configured.` A `WARNING: sign-in emails do not contain the 6-digit code yet` line means SMTP is missing: configure it and run setup again. Re-running is safe; it refuses only an unknown or different installation.

## 5. Run the client from source

```sh
cd ../gugu
pnpm install --frozen-lockfile
pnpm rebuild:native            # once after each install: native modules for Electron
GUGU_DB_TARGET=local bash scripts/dev-app.sh
```

`dev-app.sh` starts an isolated instance (its own `GUGU_HOME` and user-data directory) and prints their paths and the log file. `GUGU_DB_TARGET=local` selects `.envs/local.env`. `bash scripts/dev-app.sh --web` serves a browser build instead, which is handy for a second test user.

## 6. First run checklist

1. Enter your email, then the 6-digit code from the email (one request per address per 60 seconds).
2. Finish the profile, pick the agent CLIs to install, and choose **Look around first** on the assistant intro.
3. **New Task** → pick Claude Code (or another installed CLI) → send a message. The CLI uses your own login on this machine.
4. Sign in a second user, add each other by Gugu number under **Contacts**, create a group, and exchange messages and a file. Requests, contacts and messages should appear without reloading.

## Upgrading

Pull both repositories, then run `pnpm run setup --client-dir ../gugu` again. It applies new release files in order and redeploys the functions; published releases are never edited.
