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
// Exit status is conclusive or nonzero. In write mode every event must return
// 200. In `--no-write` mode the route answers 500 whether the signature failed
// or the validator rejected the missing id, and production redacts the body,
// so the script reads the deployment's function log through `bunx convex logs`
// (the operator's CLI login) and exits 0 only when the newest webhook entry is
// the expected `ValidationError` for `id`. A `SignatureVerificationException`
// exits 1; anything else exits 2 as inconclusive with the request id to look up.
import { spawn } from "node:child_process"
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

const EXPECTED_NO_WRITE = "Validator error for id"
const SIGNATURE_FAILURE = "SignatureVerificationException"

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
  const text = (await res.text()).slice(0, 300).replace(/\s+/g, " ")
  const requestId = text.match(/Request ID: ([0-9a-f]+)/)?.[1]
  console.log(JSON.stringify({ probe: label, status: res.status, requestId }))
  return { status: res.status, text, requestId }
}

/** Newest `/workos/webhook` entry from the deployment's function log. */
function latestWebhookLogEntry(deployment) {
  return new Promise((resolve) => {
    const child = spawn(
      "bunx",
      ["convex", "logs", "--deployment", deployment, "--history", "60"],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.stderr.on("data", (chunk) => (out += chunk))
    const done = () => {
      const lines = out.split("\n")
      let entry = null
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("H(POST /workos/webhook)")) continue
        entry = lines.slice(i, i + 3).join("\n")
      }
      resolve(entry)
    }
    setTimeout(() => {
      child.kill()
      done()
    }, 8000)
    child.on("error", done)
  })
}

if (noWrite) {
  const payload = event("user.created", user())
  delete payload.id
  const { status, text, requestId } = await send("no-write (missing event id)", payload)
  if (status !== 500) {
    console.error(`unexpected status ${status}; the route should reject the missing id`)
    process.exit(2)
  }
  let evidence = text
  if (!text.includes(EXPECTED_NO_WRITE) && !text.includes(SIGNATURE_FAILURE)) {
    // Redacted body (production). Read the function log instead.
    const deployment = new URL(base).hostname.split(".")[0]
    evidence = (await latestWebhookLogEntry(deployment)) ?? ""
  }
  if (evidence.includes(EXPECTED_NO_WRITE)) {
    console.log(JSON.stringify({ verdict: "secret verified", requestId }))
    process.exit(0)
  }
  if (evidence.includes(SIGNATURE_FAILURE)) {
    console.error(
      JSON.stringify({ verdict: "signature rejected: WORKOS_WEBHOOK_SECRET is not this endpoint's secret", requestId })
    )
    process.exit(1)
  }
  console.error(
    JSON.stringify({ verdict: "inconclusive: look up the request id in the function log", requestId })
  )
  process.exit(2)
}

const created = await send("user.created", event("user.created", user()))
const updated = await send(
  "user.updated",
  event("user.updated", user({ first_name: "Probe", updated_at: nowIso() }))
)
const deleted = await send("user.deleted", event("user.deleted", user()))
console.log(JSON.stringify({ probeUserId: userId }))
process.exit([created, updated, deleted].every((r) => r.status === 200) ? 0 : 1)
