import { describe, expect, it } from "vitest"
import { validateDependencyOverlay } from "./dependency-overlay"

const base = {
  dependencies: { react: "19" },
  devDependencies: { vitest: "4" },
  scripts: { build: "next build" },
}
const head = { ...base, dependencies: { ...base.dependencies, redis: "6" } }
const lock = (
  dependencies: Record<string, string>,
  packages: Record<string, unknown>,
  devDependencies: Record<string, string> = base.devDependencies
) => ({
  lockfileVersion: 1,
  workspaces: { "": { name: "app", dependencies, devDependencies } },
  packages,
})
const baseLock = lock(base.dependencies, {
  react: ["react@19", "integrity"],
  vitest: ["vitest@4", "integrity"],
})
const headLock = lock(head.dependencies, { ...baseLock.packages, redis: ["redis@6", "integrity"] })
const input = () => ({
  baseManifest: JSON.stringify(base), headManifest: JSON.stringify(head),
  baseLock: JSON.stringify(baseLock), headLock: JSON.stringify(headLock),
})
const none = {
  addedDependencies: [], changedDependencies: [], addedDevDependencies: [], changedDevDependencies: [],
  addedPackages: [], changedPackages: [], removedPackages: [],
}

describe("paired dependency overlay", () => {
  it("accepts additive packages while retaining all existing resolutions", () => {
    expect(validateDependencyOverlay(input())).toEqual({
      ...none, addedDependencies: ["redis"], addedPackages: ["redis"],
    })
  })

  it("accepts a new direct dependency already locked as a transitive dependency", () => {
    expect(validateDependencyOverlay({
      ...input(),
      baseLock: JSON.stringify({ ...baseLock, packages: headLock.packages }),
    })).toEqual({ ...none, addedDependencies: ["redis"] })
  })

  it("accepts a version change and the transitive churn that follows it", () => {
    const upgraded = { ...base, dependencies: { react: "20" } }
    const upgradedLock = lock(upgraded.dependencies, {
      react: ["react@20", "integrity"],
      scheduler: ["scheduler@1", "integrity"],
      vitest: ["vitest@4", "integrity"],
    })
    const baseWithTransitive = { ...baseLock, packages: { ...baseLock.packages, "old-helper": ["old-helper@1", "integrity"] } }
    expect(validateDependencyOverlay({
      baseManifest: JSON.stringify(base), headManifest: JSON.stringify(upgraded),
      baseLock: JSON.stringify(baseWithTransitive), headLock: JSON.stringify(upgradedLock),
    })).toEqual({
      ...none,
      changedDependencies: ["react"],
      addedPackages: ["scheduler"], changedPackages: ["react"], removedPackages: ["old-helper"],
    })
  })

  it("accepts a dev dependency version change", () => {
    const bumped = { ...base, devDependencies: { vitest: "5" } }
    const bumpedLock = lock(base.dependencies, { ...baseLock.packages, vitest: ["vitest@5", "integrity"] }, bumped.devDependencies)
    expect(validateDependencyOverlay({
      baseManifest: JSON.stringify(base), headManifest: JSON.stringify(bumped),
      baseLock: JSON.stringify(baseLock), headLock: JSON.stringify(bumpedLock),
    })).toEqual({ ...none, changedDevDependencies: ["vitest"], changedPackages: ["vitest"] })
  })

  it("rejects removing a direct dependency the base product may still import", () => {
    const removed = { ...base, dependencies: {} }
    const removedLock = lock({}, { vitest: ["vitest@4", "integrity"] })
    expect(() => validateDependencyOverlay({
      baseManifest: JSON.stringify(base), headManifest: JSON.stringify(removed),
      baseLock: JSON.stringify(baseLock), headLock: JSON.stringify(removedLock),
    })).toThrow(/Dependency removed \(react\)/)
  })

  it.each([
    { headManifest: JSON.stringify({ ...head, scripts: { build: "different build" } }) },
    { headLock: JSON.stringify(baseLock) },
    { headLock: JSON.stringify({ ...headLock, packages: baseLock.packages }) },
    { headLock: JSON.stringify({ ...headLock, lockfileVersion: 2 }) },
    { headLock: JSON.stringify({ ...headLock, workspaces: { "": { ...headLock.workspaces[""], name: "different" } } }) },
  ])("rejects changes outside the dependency sets instead of hiding them in the overlay", (change) => {
    expect(() => validateDependencyOverlay({ ...input(), ...change })).toThrow()
  })

  it("rejects identical dependencies as a no-op overlay", () => {
    expect(() => validateDependencyOverlay({
      ...input(), headManifest: JSON.stringify(base), headLock: JSON.stringify(baseLock),
    })).toThrow(/requires an added or changed direct dependency/)
  })

  it("rejects a lock-only resolution change with unchanged manifests", () => {
    const refreshedLock = lock(base.dependencies, { ...baseLock.packages, react: ["react@20", "integrity"] })
    expect(() => validateDependencyOverlay({
      ...input(), headManifest: JSON.stringify(base), headLock: JSON.stringify(refreshedLock),
    })).toThrow(/requires an added or changed direct dependency/)
  })
})
