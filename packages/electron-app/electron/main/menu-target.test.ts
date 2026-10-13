import assert from "node:assert/strict"
import test from "node:test"
import { resolveFocusedLocalTarget, resolveWindowTarget } from "./menu-target"

test("menu actions target focused then MRU local windows", () => {
  const local = { kind: "local" }
  const other = { kind: "local" }
  const remote = { kind: "remote" }
  const isLocal = (window: { kind: string }) => window.kind === "local"
  assert.equal(resolveFocusedLocalTarget(local, other, isLocal), local)
  assert.equal(resolveFocusedLocalTarget(remote, other, isLocal), null)
  assert.equal(resolveFocusedLocalTarget(remote, remote, isLocal), null)
  assert.equal(resolveFocusedLocalTarget(null, other, isLocal), other)
  assert.equal(resolveWindowTarget(remote, other), remote)
  assert.equal(resolveWindowTarget(null, other), other)
})
