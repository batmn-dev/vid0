# Environment Setup

This app uses WorkOS AuthKit for identity, Convex for app data and auth token
validation, and Vercel for preview and production hosting. Keep secrets out of
`NEXT_PUBLIC_*` variables.

> To **read or query** Convex data (deployment map, dashboard/CLI/MCP, and the
> MCP "wrong empty backend" gotcha), see `docs/convex-access.md`.

## Local Setup

```bash
bun install
cp .env.example .env.local
bunx convex dev
bun run env:check
bun run dev
```

Required local `.env.local` values:

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `CONVEX_DEPLOYMENT`
- `NEXT_PUBLIC_CONVEX_URL`
- `CSRF_SECRET`
- `CHAT_ADMISSION_SECRET`
- `ENCRYPTION_KEY`
- at least one AI provider key

`WORKOS_COOKIE_PASSWORD` must be at least 32 characters.
`CHAT_ADMISSION_SECRET` signs both durable chat admission and platform-usage
reservation authorization. It must be at least 32 bytes and must use the same
value in `.env.local` and the target Convex deployment. Use a different secret
for Production and Preview; use a per-preview secret when sibling-preview
isolation is required. Generate it with:

```bash
openssl rand -base64 32
```

`ENCRYPTION_KEY` must be base64 and decode to exactly 32 bytes:

```bash
openssl rand -base64 32
```

To rotate `ENCRYPTION_KEY` without downtime, move the current value to
`ENCRYPTION_KEY_PREVIOUS` (optional, comma-separated for multiple old keys) and
set `ENCRYPTION_KEY` to the new key. Decryption tries the new key first, then each
previous key, so saved secrets keep working while they are lazily re-encrypted on
next write; drop `ENCRYPTION_KEY_PREVIOUS` once every row has been re-encrypted.
Rotating without keeping the old key in `ENCRYPTION_KEY_PREVIOUS` makes existing
encrypted secrets undecryptable (owners must re-enter them).

Stored secrets are also bound (AES-GCM AAD) to their owner + provider/purpose, so
ciphertext copied to another user or provider fails to decrypt rather than
leaking. Ciphertext is versioned (`v2`); rows written before this format must be
re-entered.

For local WorkOS AuthKit, configure:

- Redirect URI: `http://localhost:3000/callback`
- App homepage URL: `http://localhost:3000`
- CORS origin: `http://localhost:3000`

## Retained chat streaming

Hard-refresh streaming uses a short-lived Redis Stream alongside Convex checkpoints
([ADR-0039](adr/0039-resumable-generation-stream.md)). Run Redis locally on
`127.0.0.1:6379`, or set the server-only `CHAT_STREAM_REDIS_URL` to a Redis
TCP/TLS endpoint. An HTTP-only Redis REST endpoint is insufficient. Preview and
production require the variable explicitly; use separate Redis instances or
databases for deployment environments. Place Redis near the Vercel function region.

On macOS with Homebrew, use `brew services start redis` to keep the local service
running across logins, then confirm `redis-cli ping` returns `PONG`. `bun run dev`
starts Next.js and Convex only. A successful page load does not verify Redis.
If the service exits, inspect `$(brew --prefix)/var/log/redis.log`; missing optional
module files in `redis.conf` can prevent startup. Core Redis Streams need no modules.
After restoring Redis, start a new response: output generated while Redis was down
has checkpoints but no retained token log to recover.

Keep Redis private and use TLS/authentication for hosted connections. Replay logs
contain assistant text, reasoning and tool events. They expire ten minutes after
completion; active logs renew a one-hour TTL and have a 16 MiB per-run limit.
Individual records and starting assistant state are limited to 1 MiB before
transmission, so oversized output cannot exceed hosted Redis request limits.
Missing or unavailable replay leaves Convex checkpoint recovery active. A reconnect
retries transient failures with bounded backoff, then falls back after five failures
without new output. Redis does not make the existing model worker survive a crash.

## Convex Env

Convex functions do not read secrets from `.env.local`. Set WorkOS values on
the target Convex deployment:

```bash
bunx convex env set WORKOS_CLIENT_ID <client_id>
bunx convex env set WORKOS_API_KEY <api_key>
bunx convex env set WORKOS_WEBHOOK_SECRET <secret>
bunx convex env set CHAT_ADMISSION_SECRET <same_value_as_vercel>
```

`WORKOS_ACTION_SECRET` is only needed if WorkOS actions are added later.
`WORKOS_WEBHOOK_SECRET` belongs in Convex env, not Vercel. The Convex app
declares `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_WEBHOOK_SECRET`, and
`CHAT_ADMISSION_SECRET` as required deployment env vars in
`convex/convex.config.ts`. Set `CHAT_ADMISSION_SECRET` to the exact same value
in the Next.js server and Convex; a mismatch makes durable chat admission and
platform-usage reservation fail closed before any run is created.

To inspect configured Convex env names, use:

```bash
bunx convex env list
```

This command prints values. Do not paste raw output into issues, docs, PRs, or
logs. Redact values before sharing command output.

## WorkOS Webhook

Create a WorkOS webhook endpoint for each Convex deployment that should receive
identity lifecycle events.

Endpoint:

```text
https://<your-convex-deployment>.convex.site/workos/webhook
```

Required events:

- `user.created`
- `user.updated`
- `user.deleted`

Copy the webhook signing secret into Convex env as `WORKOS_WEBHOOK_SECRET`.
Do not set `WORKOS_WEBHOOK_SECRET` in Vercel; the webhook handler runs in
Convex.

Each endpoint has its own signing secret, and the secret must belong to the
endpoint whose URL targets that deployment. A mismatch fails every delivery
with `Uncaught SignatureVerificationException` in the deployment's function log
and a 500 in WorkOS's delivery log; WorkOS keeps retrying, and no user event
reaches the app. Prove a deployment's secret without opening the WorkOS
dashboard and without printing the value:

```bash
# dev: writes one synthetic user through the full pipeline, then soft-deletes it
WORKOS_WEBHOOK_SECRET="$(bunx convex env get WORKOS_WEBHOOK_SECRET)" \
  bun scripts/workos-webhook-probe.mjs https://<dev-slug>.convex.site

# production: no writes; expect a 500 whose log line is a ValidationError, not a
# SignatureVerificationException
WORKOS_WEBHOOK_SECRET="$(bunx convex env get --prod WORKOS_WEBHOOK_SECRET)" \
  bun scripts/workos-webhook-probe.mjs https://<prod-slug>.convex.site --no-write
```

The AuthKit component (`@convex-dev/workos-authkit` 0.2.9+) processes every
event inline from the signature-verified payload and inserts a user it has not
seen when a `user.updated` arrives first. A `user.deleted` for a user the
component has never seen is still skipped, so after wiping a deployment, or
when its component tables are empty while WorkOS already has users, seed them
once from WorkOS (this also upserts the app's `users` rows):

```bash
bunx convex run workosAuth:backfillUsers        # dev
bunx convex run --prod workosAuth:backfillUsers # production
```

```bash
bunx convex env set WORKOS_WEBHOOK_SECRET "<secret>"
```

## Vercel Preview

Set these Vercel Preview environment variables:

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `CONVEX_DEPLOY_KEY`
- `CSRF_SECRET`
- `CHAT_ADMISSION_SECRET`
- `ENCRYPTION_KEY`
- `CHAT_STREAM_REDIS_URL` for retained streaming (a separate Preview Redis endpoint)
- AI provider keys needed by the deployment
- optional analytics and observability keys
- optional `SCHEMA_GUARD_REPO_URL` when Vercel cannot fetch the base branch
  from `origin`
- optional `SCHEMA_GUARD_ALLOW_VERCEL_GITHUB_FALLBACK=1` only for public GitHub
  repositories that can be fetched without credentials

Use a Convex preview deploy key for `CONVEX_DEPLOY_KEY`.
`CONVEX_SCHEMA_PREFLIGHT_DEPLOY_KEY` is not needed for normal previews because
preview deploys run a dry-run schema preflight. Set it only if
`CONVEX_SCHEMA_PREFLIGHT_MODE=prod` is deliberately enabled for a preview.

Vercel variables are not copied into Convex. Before creating a preview, set
every required Convex variable declared in `convex/convex.config.ts` as a
[project Preview default](https://docs.convex.dev/production/environment-variables#project-environment-variable-defaults).
In particular, `CHAT_ADMISSION_SECRET` must use the exact Vercel Preview value:

```bash
pbpaste | bunx convex env default set CHAT_ADMISSION_SECRET --type preview
```

Defaults apply only to new deployments. Update any existing preview directly,
then redeploy it:

```bash
pbpaste | bunx convex env set --deployment <preview-deployment> CHAT_ADMISSION_SECRET
```

The shared Preview default makes all previews one signer trust domain. Usage
reservation proofs still bind the exact `NEXT_PUBLIC_CONVEX_URL` and cannot be
replayed across previews, but a preview with a per-deployment trust requirement
must override both its Vercel and Convex values with a unique secret. Never use
the Production secret as a Preview default.

Vercel provides `VERCEL_BRANCH_URL` and
`VERCEL_PROJECT_PRODUCTION_URL`. `convex.json` uses those values to configure
preview redirect URIs and CORS origins. The Vercel build command runs:

```bash
bun run convex:deploy
```

This injects the preview Convex URL into `NEXT_PUBLIC_CONVEX_URL` during the
Next.js build. In Vercel preview/development deploys, the shared deploy script
fetches the schema diff base, requires it to be readable, and runs a dry-run
schema/manifest check before `convex deploy`. It does not query production data
from preview builds, because the Convex preview deployment may not exist until
`convex deploy` claims or creates it.

Vercel build checkouts may not expose a usable `origin` remote. The schema
preflight first uses an explicit `SCHEMA_GUARD_REPO_URL`, then the checkout's
existing `origin`, and only falls back to Vercel's public GitHub metadata when
no origin remote is present and `SCHEMA_GUARD_ALLOW_VERCEL_GITHUB_FALLBACK=1`
is set.
Private forks, renamed repositories, non-GitHub sources, and projects where the
base ref requires credentials must either make `origin` fetchable or set
`SCHEMA_GUARD_REPO_URL` in Vercel to a read-capable repository URL. Public
GitHub repos may opt into the Vercel metadata fallback. Keep credential-bearing
URLs in private Vercel env settings only; never put them in `NEXT_PUBLIC_*`
variables.

`NEXT_PUBLIC_WORKOS_REDIRECT_URI` must still match the preview callback URL that
WorkOS will redirect to. For branch previews, use the Vercel preview callback
URL for that deployment or configure dynamic redirect URI handling before
depending on arbitrary branch URLs.

## Production

Set these Vercel Production environment variables:

- `WORKOS_CLIENT_ID`
- `WORKOS_API_KEY`
- `WORKOS_COOKIE_PASSWORD`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`
- `CONVEX_DEPLOY_KEY`
- `CONVEX_SCHEMA_PREFLIGHT_DEPLOY_KEY`
- `CSRF_SECRET`
- `CHAT_ADMISSION_SECRET`
- `ENCRYPTION_KEY`
- `CHAT_STREAM_REDIS_URL` for retained streaming (the Production Redis endpoint)
- AI provider keys needed by the deployment
- optional analytics and observability keys
- optional `SCHEMA_GUARD_REPO_URL` when the production deploy environment
  cannot fetch the base branch from `origin`
- optional `SCHEMA_GUARD_ALLOW_VERCEL_GITHUB_FALLBACK=1` only for public GitHub
  repositories that can be fetched without credentials

Use a Convex production deploy key with `deployment:deploy` for
`CONVEX_DEPLOY_KEY`.

Use a separate Convex production deploy key with
`deployment:functions:runTestQuery` for
`CONVEX_SCHEMA_PREFLIGHT_DEPLOY_KEY`. `bun run convex:deploy` passes this key
only to the read-only `convex run --inline-query --prod` schema preflight, then
passes `CONVEX_DEPLOY_KEY` to `convex deploy`.

GitHub Actions production Convex deploys also need the repository variable
`VERCEL_PROJECT_PRODUCTION_URL`, because they do not run inside Vercel and do
not receive Vercel system environment variables automatically. Set it to the
production host only, without `https://` and without a path. The deploy workflow
passes it through to `convex deploy` so `convex.json` can configure WorkOS
AuthKit redirect URIs and CORS origins.

GitHub Actions production Convex deploys also need two repository secrets:
`CONVEX_DEPLOY_KEY` for deployment and `CONVEX_SCHEMA_PREFLIGHT_DEPLOY_KEY` for
the query-capable preflight.

In WorkOS production, configure:

- Redirect URI: `https://<production-domain>/callback`
- App homepage URL: `https://<production-domain>`
- CORS origin: `https://<production-domain>`
- Webhook endpoint:
  `https://<production-convex-deployment>.convex.site/workos/webhook`

`NEXT_PUBLIC_CONVEX_URL` should not be manually set in Vercel. It is injected by
`convex deploy --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL`.

Production `convex deploy` must go through the shared deploy command:

```bash
bun run convex:deploy
```

> **Pre-launch scope.** Non-production data is disposable, but production deploys
> still run schema-contraction preflight because Convex rejects strict schemas
> when existing production documents contain removed fields. Set
> `CONVEX_PROD_DB_DISPOSABLE=true` only for an intentional production wipe or
> throwaway production deploy.

The read-only preflight uses `convex/migrations/` manifests to verify that
removed schema fields have zero legacy documents on the target deployment. It
prints only table names, field names, and aggregate counts, and blocks deploys
if the diff base or Convex aggregate counts cannot be verified. See
`docs/convex-migrations.md` for the expand/migrate/contract workflow.

For direct `bun run convex:schema-preflight` production runs, set
`CONVEX_SCHEMA_PREFLIGHT_DEPLOY_KEY`; the script maps it to the Convex CLI's
`CONVEX_DEPLOY_KEY` only for the inline query process.

For private production deployments, confirm that the production environment can
fetch the base schema before relying on deploy automation. Configure either a
fetchable `origin` remote or `SCHEMA_GUARD_REPO_URL`; production deploys fail
closed if neither can provide the configured base ref.

## Schema Preflight Repository Access

The schema preflight needs read access to the base schema ref.
For the default `origin/main` base, configure one of these:

- A checkout with a fetchable `origin` remote. This is normally enough for
  GitHub Actions using `actions/checkout`.
- `SCHEMA_GUARD_REPO_URL` in private GitHub Actions secrets/variables, Vercel
  environment variables, or the local shell. Use this for private forks,
  renamed repositories, mirrors, non-GitHub providers, or credential-required
  base refs.
- `SCHEMA_GUARD_ALLOW_VERCEL_GITHUB_FALLBACK=1`, only for public GitHub repos
  where an unauthenticated Vercel metadata URL is sufficient.

Do not commit credential-bearing repository URLs, place them in `NEXT_PUBLIC_*`
variables, or paste them into logs. If a token is embedded in
`SCHEMA_GUARD_REPO_URL`, store it only in the provider's private secret/env
settings.

## Troubleshooting

| Symptom                                                                 | Check                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_CONVEX_URL is required`                                    | Run `bunx convex dev` locally, or confirm Vercel uses the Convex deploy build command.                       |
| WorkOS login redirects fail                                             | Confirm `NEXT_PUBLIC_WORKOS_REDIRECT_URI` exactly matches the WorkOS redirect URI and ends in `/callback`.   |
| Convex auth returns unauthenticated                                     | Confirm `WORKOS_CLIENT_ID` is set in Convex env and redeploy with `bunx convex dev` or `bunx convex deploy`. |
| WorkOS webhook events fail                                              | Run `scripts/workos-webhook-probe.mjs` against the deployment (see WorkOS Webhook). `SignatureVerificationException` means `WORKOS_WEBHOOK_SECRET` is not that endpoint's secret; `user not found` on updates means the component table needs `workosAuth:backfillUsers`. |
| Saved API keys stop decrypting                                          | Restore the previous `ENCRYPTION_KEY` or migrate encrypted values before rotating it.                        |
| Durable chat admission or usage reservation rejects before run creation | Confirm `CHAT_ADMISSION_SECRET` is present and identical in Vercel/local and the target Convex deployment.   |
| `bun run env:check` rejects a custom local domain                       | Set `ALLOW_NON_LOCAL_WORKOS_REDIRECT_URI=1` only for that check.                                             |
| `CLERK_*` appears in env output                                         | Remove stale Clerk variables after confirming the deployment is on WorkOS AuthKit.                           |

Use `bun run test` for test validation. The configured test runner is Vitest;
raw `bun test` is not the project test command.
