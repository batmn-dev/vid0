import { isDeepStrictEqual } from "node:util"
import { parseConfigFileTextToJson } from "typescript"
import { z } from "zod"

const record = z.record(z.string(), z.unknown())

function parseObject(text: string) {
  const parsed = parseConfigFileTextToJson("dependencies.json", text)
  if (parsed.error) throw new Error("Invalid dependency JSON")
  return record.parse(parsed.config)
}

function assertUnchanged(base: unknown, head: unknown, label: string) {
  if (!isDeepStrictEqual(base, head))
    throw new Error(`${label} changed; dependency overlay only permits dependency additions and version changes`)
}

type SetDelta = { added: string[]; changed: string[]; removed: string[] }

/** Names added, changed, or removed between two name-keyed sets. */
function delta(base: Record<string, unknown>, head: Record<string, unknown>): SetDelta {
  const added = Object.keys(head).filter((name) => !Object.hasOwn(base, name)).sort()
  const changed: string[] = []
  const removed: string[] = []
  for (const [name, value] of Object.entries(base)) {
    if (!Object.hasOwn(head, name)) removed.push(name)
    else if (!isDeepStrictEqual(value, head[name])) changed.push(name)
  }
  return { added, changed: changed.sort(), removed: removed.sort() }
}

/** A direct dependency set may grow or change versions; the base product may still import a removed one. */
function directDelta(base: unknown, head: unknown, label: string) {
  const result = delta(record.parse(base ?? {}), record.parse(head ?? {}))
  if (result.removed.length > 0)
    throw new Error(`${label} removed (${result.removed.join(", ")}); dependency overlay only permits dependency additions and version changes`)
  return result
}

/**
 * Normalize dependency changes across both builds. The head manifest and lock
 * are installed in the baseline checkout too, so the comparison measures the
 * product change under common dependencies, never dependency-upgrade
 * performance on its own (the responsiveness targets still judge the head
 * run in absolute terms). Additions and version changes of direct
 * dependencies, and the locked package resolutions that follow from them, are
 * permitted and recorded. Removing a direct dependency, and any change outside
 * the dependency sets (scripts, lockfile settings, other workspaces), fails
 * closed.
 */
export function validateDependencyOverlay(input: {
  baseManifest: string
  headManifest: string
  baseLock: string
  headLock: string
}) {
  const { dependencies: baseDeps, devDependencies: baseDevDeps, ...baseManifest } = parseObject(input.baseManifest)
  const { dependencies: headDeps, devDependencies: headDevDeps, ...headManifest } = parseObject(input.headManifest)
  assertUnchanged(baseManifest, headManifest, "Package manifest outside dependencies")
  const dependencies = directDelta(baseDeps, headDeps, "Dependency")
  const devDependencies = directDelta(baseDevDeps, headDevDeps, "Dev dependency")
  const { workspaces: baseWorkspaces, packages: basePackages, ...baseLock } = parseObject(input.baseLock)
  const { workspaces: headWorkspaces, packages: headPackages, ...headLock } = parseObject(input.headLock)
  assertUnchanged(baseLock, headLock, "Lockfile settings")
  const { "": baseRoot, ...baseOtherWorkspaces } = record.parse(baseWorkspaces)
  const { "": headRoot, ...headOtherWorkspaces } = record.parse(headWorkspaces)
  assertUnchanged(baseOtherWorkspaces, headOtherWorkspaces, "Other workspaces")
  const { dependencies: baseRootDeps, devDependencies: baseRootDevDeps, ...baseRootSettings } = record.parse(baseRoot)
  const { dependencies: headRootDeps, devDependencies: headRootDevDeps, ...headRootSettings } = record.parse(headRoot)
  assertUnchanged(baseRootSettings, headRootSettings, "Root workspace settings")
  assertUnchanged(baseDeps, baseRootDeps, "Base manifest/lock dependency agreement")
  assertUnchanged(headDeps, headRootDeps, "Head manifest/lock dependency agreement")
  assertUnchanged(baseDevDeps, baseRootDevDeps, "Base manifest/lock dev dependency agreement")
  assertUnchanged(headDevDeps, headRootDevDeps, "Head manifest/lock dev dependency agreement")
  const headPackageRecords = record.parse(headPackages)
  // Transitive packages may come and go with a version change; a direct
  // dependency cannot disappear from the lock while the manifest keeps it.
  const packages = delta(record.parse(basePackages), headPackageRecords)
  for (const name of [...dependencies.added, ...dependencies.changed, ...devDependencies.added, ...devDependencies.changed])
    if (!Object.hasOwn(headPackageRecords, name))
      throw new Error(`Dependency ${name} has no locked package entry`)
  // Package deltas ride only on a reviewed manifest change. A lock-only
  // resolution refresh would otherwise install upgraded packages into both
  // builds without any direct dependency saying so.
  const directChanges = dependencies.added.length + dependencies.changed.length +
    devDependencies.added.length + devDependencies.changed.length
  if (directChanges === 0)
    throw new Error("Dependency overlay requires an added or changed direct dependency")
  return {
    addedDependencies: dependencies.added,
    changedDependencies: dependencies.changed,
    addedDevDependencies: devDependencies.added,
    changedDevDependencies: devDependencies.changed,
    addedPackages: packages.added,
    changedPackages: packages.changed,
    removedPackages: packages.removed,
  }
}
