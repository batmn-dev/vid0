/** Run the same measurement harness against two production builds on one CI runner. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { validateDependencyOverlay } from "./dependency-overlay"
import { validateDirectiveOverlay } from "./directive-overlay"
import { applySseCharsetOverlay } from "./sse-charset-overlay"
import { LEGACY_MEASUREMENT_BASE, MEASUREMENT_FILES, MEASUREMENT_HOOK_FILES, measurementBootstrap } from "./measurement-overlay"

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..")
const harnessDirectory = "benchmarks/chat-performance/browser"
const resultsDirectory = `${harnessDirectory}/results`

function command(cwd: string, program: string, args: string[], capture = false) {
  const result = spawnSync(program, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "")
    throw new Error(`${program} ${args.join(" ")} failed (${result.status})`)
  }
  return result.stdout?.trim() ?? ""
}

function digest(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function jsonFiles(directory: string) {
  return existsSync(directory)
    ? readdirSync(directory).filter((file) => file.endsWith(".json") && !file.endsWith(".trace.json"))
    : []
}

function capture(cwd: string, destination: string) {
  const directory = path.join(cwd, resultsDirectory)
  const existing = new Set(existsSync(directory) ? readdirSync(directory) : [])
  // Preserve a failed capture for diagnosis, but never compare it as valid evidence.
  let failure: unknown
  try {
    command(cwd, "bun", ["run", `${harnessDirectory}/harness.ts`])
  } catch (error) {
    failure = error
  }
  const fresh = jsonFiles(directory).filter((file) => !existing.has(file))
  if (fresh.length === 1) cpSync(path.join(directory, fresh[0]), destination)
  const traces = existsSync(directory) ? readdirSync(directory).filter((file) =>
    file.endsWith(".trace.json") && !existing.has(file)
  ) : []
  if (traces.length > 0) {
    const traceDirectory = path.join(path.dirname(destination), `${path.basename(destination, ".json")}-native-traces`)
    mkdirSync(traceDirectory, { recursive: true })
    for (const file of traces) cpSync(path.join(directory, file), path.join(traceDirectory, file))
  }
  if (failure) throw failure
  if (fresh.length !== 1) throw new Error(`Expected one new capture, received ${fresh.length}`)
}

function main() {
  if (process.env.CI !== "true" || !process.env.RUNNER_TEMP)
    throw new Error("Paired builds run only on the isolated CI runner, never alongside local bun dev")
  if (process.env.PERF_PROFILE === "true" || process.env.ONLY || process.env.PERF_CDP_URL)
    throw new Error("Paired comparison requires complete, unprofiled, isolated suites")
  if (Number(process.env.RUNS) < 5 || !Number.isFinite(Number(process.env.RUNS)))
    throw new Error("Paired comparison requires at least five measured runs")
  const baseRef = process.env.PERF_COMPARE_REF
  if (!baseRef) throw new Error("PERF_COMPARE_REF must identify the product baseline commit")
  const head = command(root, "git", ["rev-parse", "HEAD"], true)
  const base = command(root, "git", ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], true)
  if (head === base) throw new Error("A self-comparison cannot certify branch regression protection")
  command(root, "git", ["merge-base", "--is-ancestor", base, head])
  const suite = process.env.SUITE ?? "responsiveness"
  if (!["responsiveness", "smoke", "standard", "durable", "thread-switch"].includes(suite))
    throw new Error(`Unsupported suite: ${suite}`)
  const output = path.join(root, resultsDirectory, "paired", suite)
  mkdirSync(output, { recursive: true })
  const temporary = mkdtempSync(path.join(process.env.RUNNER_TEMP, "chat-perf-pair-"))
  const baselineRoot = path.join(temporary, "base")
  command(root, "git", ["worktree", "add", "--detach", baselineRoot, base])

  // Unrelated base-branch commits can advance the product without changing its hook layout.
  const legacy = !existsSync(path.join(baselineRoot, "lib/observability/chat-ui-observer.ts")) &&
    spawnSync("git", ["merge-base", "--is-ancestor", LEGACY_MEASUREMENT_BASE, base], { cwd: root }).status === 0 &&
    spawnSync("git", ["diff", "--quiet", LEGACY_MEASUREMENT_BASE, base, "--",
      ...MEASUREMENT_FILES, ...MEASUREMENT_HOOK_FILES], { cwd: root }).status === 0
  if (legacy) {
    command(baselineRoot, "git", ["apply", "--check", path.join(root, harnessDirectory, "measurement-overlay.patch")])
    command(baselineRoot, "git", ["apply", path.join(root, harnessDirectory, "measurement-overlay.patch")])
    for (const file of MEASUREMENT_FILES) {
      mkdirSync(path.dirname(path.join(baselineRoot, file)), { recursive: true })
      cpSync(path.join(root, file), path.join(baselineRoot, file))
    }
  } else {
    // A new instrumentation protocol needs a separately reviewed overlay, not mixed clocks.
    for (const file of MEASUREMENT_FILES) {
      if (!existsSync(path.join(baselineRoot, file)) || digest(path.join(root, file)) !== digest(path.join(baselineRoot, file)))
        throw new Error(`Measurement source differs at ${file}; review a measurement-only overlay before comparing`)
    }
  }
  // Product analytics may differ; observer installation and reporting must not.
  const bootstrap = "instrumentation-client.ts"
  if (measurementBootstrap(readFileSync(path.join(root, bootstrap), "utf8")) !==
      measurementBootstrap(readFileSync(path.join(baselineRoot, bootstrap), "utf8")))
    throw new Error("Measurement bootstrap differs; review a measurement-only overlay before comparing")
  // Both builds install the exact same dependencies. Only additive changes can
  // be overlaid; upgrades/removals and build configuration changes fail closed.
  const originalBaseDependencySha256 = digest(path.join(baselineRoot, "bun.lock"))
  let dependencyOverlay: ReturnType<typeof validateDependencyOverlay> | null = null
  if (originalBaseDependencySha256 !== digest(path.join(root, "bun.lock")) ||
      digest(path.join(baselineRoot, "package.json")) !== digest(path.join(root, "package.json"))) {
    dependencyOverlay = validateDependencyOverlay({
      baseManifest: readFileSync(path.join(baselineRoot, "package.json"), "utf8"),
      headManifest: readFileSync(path.join(root, "package.json"), "utf8"),
      baseLock: readFileSync(path.join(baselineRoot, "bun.lock"), "utf8"),
      headLock: readFileSync(path.join(root, "bun.lock"), "utf8"),
    })
    for (const file of ["package.json", "bun.lock"])
      cpSync(path.join(root, file), path.join(baselineRoot, file))
  }
  const providerFile = "app/api/chat/deterministic-provider.ts"
  const directiveOverlay = validateDirectiveOverlay(
    readFileSync(path.join(baselineRoot, providerFile), "utf8"),
    readFileSync(path.join(root, providerFile), "utf8"),
  )
  if (directiveOverlay) cpSync(path.join(root, providerFile), path.join(baselineRoot, providerFile))
  const runtimeFile = "app/api/chat/chat-turn-runtime.ts"
  if (applySseCharsetOverlay(readFileSync(path.join(root, runtimeFile), "utf8")).applied)
    throw new Error("Head SSE response must declare UTF-8 before comparing")
  const sseOverlay = applySseCharsetOverlay(readFileSync(path.join(baselineRoot, runtimeFile), "utf8"))
  if (sseOverlay.applied) writeFileSync(path.join(baselineRoot, runtimeFile), sseOverlay.source)
  // Copy the driver, not the product. Fixtures, dependencies and clocks must match.
  for (const file of ["bun.lock", "app/api/chat/deterministic-provider.ts", "benchmarks/chat-performance/fixtures.ts", "convex/lib/runTimingReceipt.ts"])
    if (digest(path.join(root, file)) !== digest(path.join(baselineRoot, file)))
      throw new Error(`${file} differs; this paired protocol requires identical dependencies, fixtures, and timing helpers`)
  const harnessFiles = readdirSync(path.join(root, harnessDirectory))
    // Next typechecks tests too; their protocol types must match the copied driver.
    .filter((file) => file.endsWith(".ts"))
  for (const file of harnessFiles)
    cpSync(path.join(root, harnessDirectory, file), path.join(baselineRoot, harnessDirectory, file))
  const measurementHashes = Object.fromEntries(
    [...MEASUREMENT_FILES, ...harnessFiles.map((file) => `${harnessDirectory}/${file}`)]
      .sort().map((file) => [file, digest(path.join(root, file))])
  )
  writeFileSync(path.join(output, "manifest.json"), JSON.stringify({
    protocol: "same-runner-pair-v1", baseCommit: base, headCommit: head,
    measurementCommit: head, suite, order: ["base", "head"],
    legacyOverlay: legacy,
    legacyHookLayoutCommit: legacy ? LEGACY_MEASUREMENT_BASE : null,
    overlaySha256: legacy ? digest(path.join(root, harnessDirectory, "measurement-overlay.patch")) : null,
    measurementHashes, timingHelperSha256: digest(path.join(root, "convex/lib/runTimingReceipt.ts")),
    dependencySha256: digest(path.join(root, "bun.lock")),
    originalBaseDependencySha256, dependencyOverlay, directiveOverlay,
    sseCharsetOverlay: sseOverlay.applied,
    hookSources: Object.fromEntries(MEASUREMENT_HOOK_FILES.map((file) => [file, {
      base: digest(path.join(baselineRoot, file)), head: digest(path.join(root, file)),
    }])),
    runner: { os: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length },
    runs: process.env.RUNS, warmups: process.env.WARMUPS,
  }, null, 2))
  writeFileSync(path.join(output, "baseline-instrumentation.diff"),
    command(baselineRoot, "git", ["diff", "--", ".", ":(exclude)benchmarks/chat-performance/browser"], true))
  writeFileSync(path.join(output, "product-hook-changes.diff"),
    command(root, "git", ["diff", base, head, "--", ...MEASUREMENT_HOOK_FILES], true))
  cpSync(path.join(root, ".env.local"), path.join(baselineRoot, ".env.local"))
  command(baselineRoot, "bun", ["install", "--frozen-lockfile"])
  process.env.NEXT_PUBLIC_CHAT_PERF_INSTRUMENTATION = "true"
  process.env.NEXT_DIST_DIR = ".next-perf"
  command(baselineRoot, "bun", ["run", "build:next"])
  capture(baselineRoot, path.join(output, "base.json"))
  command(root, "bun", ["run", `${harnessDirectory}/compare-results.ts`, "--regression-only",
    "--collect-baseline", path.join(output, "base.json")])
  command(root, "bun", ["run", "build:next"])
  capture(root, path.join(output, "head.json"))
  const comparison = spawnSync("bun", ["run", `${harnessDirectory}/compare-results.ts`, "--regression-only",
    path.join(output, "base.json"), path.join(output, "head.json")], { cwd: root, encoding: "utf8" })
  const report = `${comparison.stdout ?? ""}${comparison.stderr ?? ""}`
  process.stdout.write(report)
  writeFileSync(path.join(output, "comparison.txt"), report)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = `### ${suite}: same-runner comparison\n\nProduct base: \`${base}\`\n\nProduct head: \`${head}\`\n\nMeasurements: \`${head}\`${legacy ? " with audited measurement-only hooks on the original base" : ""}. Both captures use five or more runs; no profiled samples.\n\n\`\`\`text\n${report}\n\`\`\`\n`
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: "a" })
  }
  if (comparison.error) throw comparison.error
  if (comparison.status !== 0) throw new Error(`Paired comparison failed (${comparison.status}); see comparison.txt`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
