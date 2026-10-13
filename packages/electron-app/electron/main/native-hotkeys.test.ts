import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { NATIVE_HOTKEY_ACTIONS, normalizeNativeHotkeySnapshot, type NativeHotkeySnapshot } from "../../../ui/src/lib/native/hotkeys-contract"
import { installNativeHotkeys, isNativeHotkeyRecording, setNativeHotkeys, setupNativeHotkeyIPC } from "./native-hotkeys"
import { installWindowZoomInput } from "./window-state"

function snapshot(): NativeHotkeySnapshot {
  const bindings = Object.fromEntries(NATIVE_HOTKEY_ACTIONS.map(id => [id, []])) as unknown as NativeHotkeySnapshot["bindings"]
  bindings["window-zoom-in"] = [{ key: "z", ctrl: true, meta: false, shift: false, alt: false }]
  bindings["new-instance"] = [{ key: "n", ctrl: true, meta: false, shift: false, alt: false }]
  bindings["open-command-palette"] = [{ key: "p", ctrl: true, meta: false, shift: true, alt: false }]
  return { version: 1, recording: false, bindings }
}

function harness(allowGlobal = true) {
  const events = new Map<string, Function>()
  const calls: string[] = []
  const frame = { url: "http://localhost:3000/" }
  let trusted = true
  let destroyed = false
  const window = {
    isDestroyed: () => destroyed,
    on: (name: string, listener: Function) => events.set(name, listener),
    webContents: {
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => destroyed,
      on: (name: string, listener: Function) => events.set(name, listener),
      setIgnoreMenuShortcuts: (value: boolean) => calls.push(`ignore:${value}`),
    },
  } as unknown as BrowserWindow
  const execute = (_window: BrowserWindow, id: string) => calls.push(id)
  const changed = () => calls.push("menu")
  installNativeHotkeys(window, execute, () => trusted, changed, allowGlobal)
  const input = (key: string, extra = {}) => {
    let prevented = false
    events.get("before-input-event")!({ preventDefault: () => { prevented = true } }, {
      type: "keyDown", key, code: `Key${key.toUpperCase()}`, control: true, meta: false, shift: false, alt: false, ...extra,
    })
    return prevented
  }
  return { window, events, calls, frame, input, execute, changed,
    untrust: () => { trusted = false }, destroy: () => { destroyed = true },
  }
}

test("native actions execute once; renderer actions, old zoom keys and keyup pass through", () => {
  const h = harness()
  setNativeHotkeys(h.window, snapshot())
  h.calls.length = 0
  assert.equal(h.input("z"), true)
  assert.deepEqual(h.calls, ["window-zoom-in"])
  for (const [key, extra] of [["n", {}], ["p", { shift: true }], ["=", {}], ["z", { type: "keyUp" }], ["z", { alt: true }], ["z", { isComposing: true }]] as const) {
    assert.equal(h.input(key, extra), false)
  }
  assert.deepEqual(h.calls, ["window-zoom-in"])
  assert.equal(h.input("z", { isAutoRepeat: true }), true)
  assert.deepEqual(h.calls, ["window-zoom-in"], "repeated native mutations remain consumed but never repeat")
  installNativeHotkeys(h.window, h.execute, () => true, h.changed)
  assert.equal(h.input("z"), true)
  assert.deepEqual(h.calls, ["window-zoom-in", "window-zoom-in"])
})

test("capture acknowledgement suppresses menu shortcuts but delivers all keys to the recorder", () => {
  const h = harness()
  setNativeHotkeys(h.window, { ...snapshot(), recording: true })
  assert.deepEqual(h.calls, ["ignore:true", "menu"])
  assert.equal(isNativeHotkeyRecording(h.window), true)
  assert.equal(h.input("z"), false)
  assert.equal(h.input("n"), false)
  assert.deepEqual(h.calls, ["ignore:true", "menu"])
  setNativeHotkeys(h.window, snapshot())
  assert.equal(isNativeHotkeyRecording(h.window), false)
  assert.equal(h.input("z"), true)
})

test("invalid snapshots cannot replace a live map or end capture", () => {
  const h = harness()
  setNativeHotkeys(h.window, { ...snapshot(), recording: true })
  assert.throws(() => setNativeHotkeys(h.window, { ...snapshot(), version: 2 }), /Invalid native hotkey/)
  assert.equal(isNativeHotkeyRecording(h.window), true)
  assert.equal(h.input("z"), false)
  assert.deepEqual(h.calls, ["ignore:true", "menu"])
})

test("snapshots stay window-scoped and are cleared on top-frame reload, crash and close", () => {
  const a = harness()
  const b = harness()
  setNativeHotkeys(a.window, snapshot())
  setNativeHotkeys(b.window, { ...snapshot(), recording: true })
  a.events.get("did-start-navigation")!({}, "http://localhost:3000/", false, false)
  assert.equal(a.input("z"), true)
  a.events.get("did-start-navigation")!({}, "http://localhost:3000/#x", true, true)
  assert.equal(a.input("z"), true)
  a.events.get("did-start-navigation")!({}, "http://localhost:3000/", false, true)
  assert.equal(a.input("z"), false)
  assert.equal(isNativeHotkeyRecording(b.window), true)
  setNativeHotkeys(a.window, { ...snapshot(), recording: true })
  a.events.get("did-navigate")!()
  assert.equal(isNativeHotkeyRecording(a.window), false, "commit fences a late pre-navigation snapshot")
  b.events.get("render-process-gone")!()
  assert.equal(isNativeHotkeyRecording(b.window), false)
  setNativeHotkeys(a.window, snapshot())
  a.events.get("closed")!()
  assert.equal(a.input("z"), false)
  assert.throws(() => setNativeHotkeys(a.window, snapshot()), /owned application window/)
})

test("a renderer losing trusted ownership cannot execute its retained map", () => {
  const h = harness()
  setNativeHotkeys(h.window, snapshot())
  h.untrust()
  assert.equal(h.input("z"), false)
})

test("wheel/native zoom remains independent without another keyboard execution route", () => {
  const h = harness()
  let level = 0
  const contents = h.window.webContents as unknown as { getZoomLevel: () => number }
  contents.getZoomLevel = () => level
  const keyboardListener = h.events.get("before-input-event")
  installWindowZoomInput(h.window, value => { level = value })
  assert.equal(h.events.get("before-input-event"), keyboardListener)
  setNativeHotkeys(h.window, { ...snapshot(), recording: true })
  let prevented = 0
  h.events.get("zoom-changed")!({ preventDefault: () => prevented++ }, "in")
  assert.equal(level, 0.5)
  assert.equal(prevented, 1)
  assert.equal(h.input("z"), false)
})

test("IPC admits registered trusted primary and Preferences top frames, never guests/subframes", () => {
  const local = harness()
  const preferences = harness()
  const remote = harness(false)
  remote.frame.url = "https://remote.example/app"
  const windows = [local.window, preferences.window, remote.window]
  let handler: (event: IpcMainInvokeEvent, value: unknown) => void
  setupNativeHotkeyIPC({ handle: (channel, value) => { assert.equal(channel, "native-hotkeys:set"); handler = value } },
    sender => windows.find(window => sender === window.webContents),
    () => ["http://localhost:3000", "https://remote.example"])
  const event = (window: BrowserWindow, senderFrame = window.webContents.mainFrame) => ({ sender: window.webContents, senderFrame }) as IpcMainInvokeEvent
  for (const window of windows) handler!(event(window), snapshot())
  assert.equal(remote.input("z"), true)
  for (const id of ["window-new", "app-quit", "window-hide", "window-hide-others"] as const) {
    const global = snapshot()
    global.bindings[id] = [{ key: "h", ctrl: false, meta: true, shift: false, alt: false }]
    assert.throws(() => handler!(event(remote.window), global), /Global application hotkeys/, id)
    handler!(event(local.window), global)
    handler!(event(preferences.window), global)
  }
  assert.throws(() => handler!({ sender: {} } as IpcMainInvokeEvent, snapshot()), /owned application window/)
  assert.throws(() => handler!(event(local.window, { url: local.frame.url } as typeof local.window.webContents.mainFrame), snapshot()), /registered main frame/)
  local.frame.url = "https://extension.example/"
  assert.throws(() => handler!(event(local.window), snapshot()), /allowed renderer origin/)
  local.destroy()
  assert.throws(() => handler!(event(local.window), snapshot()), /registered main frame/)
})

test("shared snapshot validator rejects authority and bounded payload violations", () => {
  assert.ok(normalizeNativeHotkeySnapshot(snapshot()))
  const missing = snapshot()
  delete (missing.bindings as Record<string, unknown>)["app-quit"]
  const invalid: unknown[] = [null, { ...snapshot(), extra: true }, { ...snapshot(), recording: 1 }, missing,
    { ...snapshot(), bindings: { ...snapshot().bindings, unknown: [] } },
  ]
  const binding = snapshot().bindings["window-zoom-in"][0]
  for (const key of ["Control", "Shift", "Alt", "Meta", "", "x".repeat(41), "\n", "\u0085"]) {
    invalid.push({ ...snapshot(), bindings: { ...snapshot().bindings, "window-zoom-in": [{ ...binding, key }] } })
  }
  for (const entry of [{ ...binding, ctrl: 1 }, { ...binding, extra: true }, { key: "x", ctrl: false }]) {
    invalid.push({ ...snapshot(), bindings: { ...snapshot().bindings, "window-zoom-in": [entry] } })
  }
  invalid.push({ ...snapshot(), bindings: { ...snapshot().bindings, "window-zoom-in": Array(9).fill(binding) } })
  for (const value of invalid) assert.equal(normalizeNativeHotkeySnapshot(value), null)
})

test("all trusted preload contexts expose only a snapshot push, not remote process authority", async () => {
  const source = readFileSync(new URL("../preload/index.cjs", import.meta.url), "utf8")
  for (const context of ["local", "remote", "preferences"]) {
    let api: Record<string, Function>
    const calls: unknown[][] = []
    vm.runInNewContext(source, {
      require: () => ({ contextBridge: { exposeInMainWorld: (name: string, value: Record<string, Function>) => { if (name === "electronAPI") api = value } },
        ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args) } }, webUtils: {} }),
      process: { argv: [`--codenomad-window-context=${context}`] },
    })
    const value = snapshot()
    await api!.setNativeHotkeys(value)
    assert.deepEqual(calls, [["native-hotkeys:set", value]])
    if (context === "remote") {
      for (const key of ["newWindow", "openRemoteWindow", "restartCli", "openWorkspaceTarget"]) assert.equal(api![key], undefined)
    }
  }
})
