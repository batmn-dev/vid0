// Probe a Convex deployment's WorkOS webhook route with a correctly signed
// synthetic event. Proves the deployment's WORKOS_WEBHOOK_SECRET verifies a
// WorkOS-style signature and that the component's event pipeline runs, without
// touching the WorkOS dashboard and without printing the secret.
//
//   Dev (writes a synthetic user, then soft-deletes it):
//     WORKOS_WEBHOOK_SECRET="$(bunx convex env get WORKOS_WEBHOOK_SECRET)" \
//       bun scripts/workos-webhook-probe.mjs https://<dev-slug>.convex.site
//
//   Production (no writes: the signature verifies, then the component's
//   validator rejects the missing event id before any mutation runs):
//     WORKOS_WEBHOOK_SECRET="$(bunx convex env get --prod WORKOS_WEBHOOK_SECRET)" \
//       bun scripts/workos-webhook-probe.mjs https://<prod-slug>.convex.site --no-write
//
// Reading the result: HTTP 200 means the secret verified and the event was
// processed. A 500 whose log line reads `SignatureVerificationException` means
// the deployment's secret is not the signing secret of the WorkOS endpoint
// that targets this URL. In `--no-write` mode the expected outcome is a 500
// whose log line reads `ValidationError: Validator error for id`; production
// redacts response bodies, so read the deployment's function log.
import { createHmac, randomUUID } from "node:crypto"

const secret = process.env.WORKOS_WEBHOOK_SECRET
const base = process.argv[2]
const noWrite = process.argv.includes("--no-write")
if (!secret || !base) {
  console.error(
    "usage: WORKOS_WEBHOOK_SECRET=... bun scripts/workos-webhook-probe.mjs https://<slug>.convex.site [--no-write]"
  )
  process.exit(2)
}

const nowIso = () => new Date().toISOString()
const tag = randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()
const userId = `user_01PROBE${tag}`
const user = (overrides = {}) => ({
  object: "user",
  id: userId,
  email: `webhook-probe+${tag.slice(-6).toLowerCase()}@example.com`,
  email_verified: true,
  first_name: null,
  last_name: null,
  profile_picture_url: null,
  last_sign_in_at: null,
  external_id: null,
  metadata: {},
  locale: null,
  created_at: nowIso(),
  updated_at: nowIso(),
  ...overrides,
})
const event = (name, data) => ({
  id: `event_01PROBE${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`,
  event: name,
  created_at: nowIso(),
  data,
})

async function send(label, payload) {
  const body = JSON.stringify(payload)
  const ts = Date.now()
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")
  const res = await fetch(`${base}/workos/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "workos-signature": `t=${ts}, v1=${sig}`,
    },
    body,
  })
  const text = (await res.text()).slice(0, 200).replace(/\s+/g, " ")
  console.log(JSON.stringify({ probe: label, status: res.status, body: text }))
  return res.status
}

if (noWrite) {
  const payload = event("user.created", user())
  delete payload.id
  const status = await send("no-write (missing event id)", payload)
  process.exit(status === 500 ? 0 : 1)
}

const created = await send("user.created", event("user.created", user()))
const updated = await send(
  "user.updated",
  event("user.updated", user({ first_name: "Probe", updated_at: nowIso() }))
)
const deleted = await send("user.deleted", event("user.deleted", user()))
console.log(JSON.stringify({ probeUserId: userId }))
process.exit([created, updated, deleted].every((s) => s === 200) ? 0 : 1)
