import assert from "node:assert/strict"
import { test } from "node:test"
import { makeNativeHotkeySnapshot, matchNativeHotkey, nativeHotkeyAccelerator, NATIVE_HOTKEY_ACTIONS, normalizeNativeHotkeySnapshot } from "./hotkeys-contract"
import { getHotkeyDefinitions } from "../hotkey-definitions"
import { hotkeyEventKey } from "../hotkey-bindings"

const event = (key: string, modifiers = {}) => ({ key, code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers })

test("native snapshots are complete, bounded, portable and detached from caller data", () => {
  for (const mac of [false, true]) {
    const snapshot = makeNativeHotkeySnapshot({}, true, { host: "electron", mac }, false)
    const accepted = normalizeNativeHotkeySnapshot(snapshot)!
    assert.deepEqual(Object.keys(accepted.bindings), NATIVE_HOTKEY_ACTIONS)
    assert.equal(accepted.bindings["window-new"][0].ctrl, !mac)
    assert.equal(accepted.bindings["window-new"][0].meta, mac)
    snapshot.bindings["window-new"][0].key = "changed"
    assert.equal(accepted.bindings["window-new"][0].key, "n")
    assert.deepEqual(normalizeNativeHotkeySnapshot({ ...accepted, version: 2 }), null)
    assert.deepEqual(normalizeNativeHotkeySnapshot({ ...accepted, recording: "yes" }), null)
    assert.deepEqual(normalizeNativeHotkeySnapshot({ ...accepted, target: "another-window" }), null)
    assert.deepEqual(normalizeNativeHotkeySnapshot({ ...accepted, bindings: { ...accepted.bindings, "arbitrary-action": [] } }), null)
  }
})

test("native validation rejects missing flags, invalid keys and oversized/missing action records", () => {
  const good = makeNativeHotkeySnapshot({}, true, { host: "tauri" }, false)
  const binding = { key: "f9", ctrl: false, meta: false, shift: false, alt: false }
  for (const bad of [{ ...binding, mod: true }, { ...binding, ctrl: 1 }, { ...binding, key: "" },
    { ...binding, key: "x".repeat(41) }, { ...binding, key: "\n" }, { ...binding, key: "\u0085" }, { ...binding, key: "Control" }, { key: "f9" }]) {
    assert.equal(normalizeNativeHotkeySnapshot({ ...good, bindings: { ...good.bindings, "window-new": [bad] } }), null)
  }
  assert.equal(normalizeNativeHotkeySnapshot({ ...good, bindings: { ...good.bindings, "window-new": Array(9).fill(binding) } }), null)
  for (const id of NATIVE_HOTKEY_ACTIONS) {
    const missing: any = { ...good.bindings }; delete missing[id]
    assert.equal(normalizeNativeHotkeySnapshot({ ...good, bindings: missing }), null, id)
  }
})

test("registered remote roots configure only their own window, not global app authority", () => {
  const snapshot = makeNativeHotkeySnapshot({ "window-new": [{ key: "F9" }], "app-quit": [{ key: "F10" }],
    "window-hide": [{ key: "h", mod: true }], "window-hide-others": [{ key: "h", mod: true, alt: true }],
    "window-close": [{ key: "F8" }] }, true, { host: "electron", mac: true, windowContext: "remote" }, false)
  assert.deepEqual(snapshot.bindings["window-new"], [])
  assert.deepEqual(snapshot.bindings["app-quit"], [])
  assert.deepEqual(snapshot.bindings["window-hide"], [])
  assert.deepEqual(snapshot.bindings["window-hide-others"], [])
  assert.ok(getHotkeyDefinitions({ host: "electron", windowContext: "remote" }).every(item => !["window-hide", "window-hide-others"].includes(item.id)))
  assert.equal(matchNativeHotkey(snapshot, event("F8")), "window-close")
})

test("Mac Hide effective accelerators follow defaults, remap, reset, disable and capture on both hosts", () => {
  for (const host of ["electron", "tauri"]) {
    const context = { host, mac: true, windowContext: "preferences" }
    const defaults = makeNativeHotkeySnapshot({}, true, context, false)
    assert.equal(nativeHotkeyAccelerator(defaults.bindings["window-hide"][0]), "Super+H")
    assert.equal(nativeHotkeyAccelerator(defaults.bindings["window-hide-others"][0]), "Super+Alt+H")
    for (const [id, altKey] of [["window-hide", false], ["window-hide-others", true]] as const) {
      const key = event("h", { metaKey: true, altKey })
      assert.equal(matchNativeHotkey(defaults, key), id)
      const remapped = makeNativeHotkeySnapshot({ [id]: [{ key: "F9" }] }, true, context, false)
      assert.equal(nativeHotkeyAccelerator(remapped.bindings[id][0]), "F9")
      assert.equal(matchNativeHotkey(remapped, key), null)
      assert.equal(matchNativeHotkey(remapped, event("F9")), id)
      assert.equal(matchNativeHotkey(makeNativeHotkeySnapshot({}, true, context, false), key), id, "reset restores the default")
      assert.equal(matchNativeHotkey(makeNativeHotkeySnapshot({ [id]: [] }, true, context, false), key), null)
      assert.equal(matchNativeHotkey({ ...defaults, recording: true }, key), null)
      assert.deepEqual(makeNativeHotkeySnapshot({}, true, { host, mac: false }, false).bindings[id], [])
    }
  }
})

test("native routing never consumes renderer bindings, disabled actions or capture keys", () => {
  const snapshot = makeNativeHotkeySnapshot({}, true, { host: "electron" }, false)
  assert.equal(matchNativeHotkey(snapshot, event("n", { ctrlKey: true })), null)
  assert.equal(matchNativeHotkey(snapshot, event("p", { ctrlKey: true, shiftKey: true })), null)
  assert.equal(matchNativeHotkey(snapshot, event("n", { ctrlKey: true, shiftKey: true })), null)
  assert.equal(matchNativeHotkey(snapshot, event("w", { ctrlKey: true })), null)
  assert.equal(matchNativeHotkey(snapshot, event("n", { ctrlKey: true, altKey: true })), "window-new")
  assert.equal(matchNativeHotkey(snapshot, event("w", { ctrlKey: true, altKey: true })), "window-close")
  assert.equal(matchNativeHotkey({ ...snapshot, recording: true }, event("n", { ctrlKey: true, altKey: true })), null)
  const remapped = makeNativeHotkeySnapshot({ "window-new": [{ key: "F9" }], "window-close": [] }, true, { host: "electron" }, false)
  assert.equal(matchNativeHotkey(remapped, event("n", { ctrlKey: true, altKey: true })), null)
  assert.equal(matchNativeHotkey(remapped, event("F9")), "window-new")
  assert.equal(matchNativeHotkey(remapped, event("w", { ctrlKey: true, altKey: true })), null)
})

test("key-only native snapshots share captured non-US physical identities and legacy semantics (#1)", () => {
  for (const host of ["electron", "tauri"]) for (const mac of [false, true]) {
    for (const [key, code, physical] of [["&", "Digit1", "1"], ["ü", "BracketLeft", "["]]) {
      const keyEvent = event(key, { code, ctrlKey: !mac, metaKey: mac })
      const snapshot = makeNativeHotkeySnapshot({ "window-new": [{ key: hotkeyEventKey(keyEvent), mod: true }] },
        true, { host, mac }, false)
      const accepted = normalizeNativeHotkeySnapshot(snapshot)!
      assert.deepEqual(accepted.bindings["window-new"], [{ key: physical, ctrl: !mac, meta: mac, shift: false, alt: false }])
      assert.equal(matchNativeHotkey(accepted, keyEvent), "window-new")
      const legacy = makeNativeHotkeySnapshot({ "window-new": [{ key, mod: true }] }, true, { host, mac }, false)
      assert.equal(matchNativeHotkey(legacy, keyEvent), null)
      assert.equal(matchNativeHotkey(legacy, { ...keyEvent, code: "Quote" }), "window-new")
    }
  }
})
