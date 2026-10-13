import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"
import type { BrowserWindow, MenuItemConstructorOptions } from "electron"
import { installNativeHotkeys, isNativeHotkeyRecording, setNativeHotkeys } from "./native-hotkeys"
import * as viewMenu from "./view-menu"
import { makeNativeHotkeySnapshot, NATIVE_HOTKEY_ACTIONS, type NativeHotkeyAction, type NativeHotkeyBinding } from "../../../ui/src/lib/native/hotkeys-contract"

let nextContentsId = 1

function harness(platform = "win32") {
  const calls: string[] = []
  const listeners = new Map<string, Function>()
  const window = (name: string) => ({
    isDestroyed: () => false,
    on() {},
    webContents: {
      id: nextContentsId++,
      isDestroyed: () => false, on() {}, setIgnoreMenuShortcuts() {},
      send: (_channel: string, id: string) => calls.push(`${name}:${id}`),
      getZoomLevel: () => 0,
      toggleDevTools: () => calls.push(`${name}:devtools`),
    },
    minimize: () => calls.push(`${name}:minimize`),
    close: () => calls.push(`${name}:close`),
    isFullScreen: () => false,
    setFullScreen: () => calls.push(`${name}:fullscreen`),
  }) as unknown as BrowserWindow
  const local = window("local")
  const preferences = window("preferences")
  let focused: BrowserWindow | null = local
  let template: MenuItemConstructorOptions[] = []
  const buildMenu = (items: MenuItemConstructorOptions[]): any => {
    const menu = {
      items: items.map(item => ({ ...item, enabled: item.enabled ?? true,
        ...(Array.isArray(item.submenu) ? { submenu: buildMenu(item.submenu) } : {}),
      })),
      getMenuItemById(id: string): any {
        for (const item of this.items) {
          if (item.id === id) return item
          const found = (item.submenu as any)?.getMenuItemById(id)
          if (found) return found
        }
      },
    }
    return menu
  }
  let menu: ReturnType<typeof buildMenu>
  const module = { exports: {} as {
    createApplicationMenu(actions: unknown): void
    executeNativeWindowAction(window: BrowserWindow, id: NativeHotkeyAction): void
    refreshNativeHotkeyMenu(): void
    setWorkspaceMenuEnabled(window: BrowserWindow, enabled: boolean, viewState?: unknown): void
  } }
  const compiled = ts.transpileModule(readFileSync(new URL("./menu.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  vm.runInNewContext(compiled, {
    module, exports: module.exports, process: { platform },
    require: (id: string) => {
      if (id === "electron") return {
        app: { on: (id: string, listener: Function) => listeners.set(id, listener), quit: () => calls.push("quit"), showAboutPanel() {} },
        BrowserWindow: { getFocusedWindow: () => focused },
        Menu: { buildFromTemplate: (value: MenuItemConstructorOptions[]) => { template = value; return buildMenu(value) }, setApplicationMenu: (value: any) => { menu = value },
          sendActionToFirstResponder: (action: string) => calls.push(action) },
        shell: { openExternal: async () => {} },
      }
      if (id === "./native-hotkeys") return { isNativeHotkeyRecording: (window: BrowserWindow) => (window === preferences && recording) || isNativeHotkeyRecording(window) }
      if (id === "./window-state") return { setWindowZoomLevel: (_window: BrowserWindow, level: number) => calls.push(`zoom:${level}`) }
      if (id === "./view-menu") return viewMenu
      throw new Error(`Unexpected dependency ${id}`)
    },
  })
  let recording = false
  const api = module.exports
  api.createApplicationMenu({
    getLocalTarget: () => focused === preferences ? null : local,
    getWindowTarget: () => focused ?? local,
    newWindow: () => calls.push("new-window"),
    reload: (window: BrowserWindow) => calls.push(window === preferences ? "preferences:reload" : "local:reload"),
    forceReload: () => calls.push("force-reload"),
  })
  const find = (label: string, items = menu.items): any => {
    for (const item of items) {
      if (item.label === label) return item
      const result = item.submenu && find(label, item.submenu.items)
      if (result) return result
    }
  }
  return { api, calls, local, preferences, find, menu: () => menu, template: () => template,
    focusPreferences: () => { focused = preferences; listeners.get("browser-window-focus")!() },
    focusLocal: () => { focused = local; listeners.get("browser-window-focus")!() },
    blur: () => { focused = null; listeners.get("browser-window-blur")!() },
    record: (value: boolean) => { recording = value; api.refreshNativeHotkeyMenu() },
  }
}

test("focus/blur and checkbox-only snapshots retain the native menu; changed View labels rebuild", () => {
  const h = harness()
  const state = (locale: string, checked: boolean) => Object.fromEntries(["leftPanel", "rightPanel", "timeline", "timelineTools"].map(key => [key, {
    label: `${locale}-${key}`, checked, enabled: key !== "timelineTools",
  }]))
  h.api.setWorkspaceMenuEnabled(h.local, true, state("en", true))
  const menu = h.menu()
  h.blur()
  h.api.setWorkspaceMenuEnabled(h.local, false, state("en", false))
  h.focusLocal()
  h.api.refreshNativeHotkeyMenu()
  assert.equal(h.menu(), menu, "focus, blur and checkbox/enabled updates must not replace an open menu")
  assert.equal(h.find("en-leftPanel").checked, false)
  assert.equal(h.find("en-leftPanel").enabled, true)
  assert.equal(h.find("en-timelineTools").enabled, false)
  assert.equal(h.find("Open Project Folder").enabled, false)
  h.focusPreferences()
  assert.equal(h.menu(), menu, "idle Preferences only disables local View controls in place")
  assert.equal(h.find("en-leftPanel").enabled, false)
  h.focusLocal()
  assert.equal(h.find("en-leftPanel").enabled, true)
  h.api.setWorkspaceMenuEnabled(h.local, true, state("fr", true))
  assert.notEqual(h.menu(), menu, "localized labels require native reinsertion")
  assert.equal(h.find("fr-leftPanel").checked, true)
})

test("Preferences capture rebuilds only on effective transitions, including native snapshot mutations", () => {
  const h = harness()
  installNativeHotkeys(h.preferences, h.api.executeNativeWindowAction, () => true, h.api.refreshNativeHotkeyMenu)
  const sync = (recording: boolean, overrides = {}) => setNativeHotkeys(h.preferences,
    makeNativeHotkeySnapshot(overrides, true, { host: "electron", mac: false }, recording))
  const idle = h.menu()
  h.focusPreferences()
  sync(false)
  assert.equal(h.menu(), idle, "focusing idle Preferences and syncing defaults must not rebuild")
  sync(true)
  const capturing = h.menu()
  assert.notEqual(capturing, idle)
  assert.equal(h.find("Reload").enabled, false)
  assert.equal(h.menu().getMenuItemById("menu-edit").submenu.items.find((item: any) => item.role === "paste").enabled, true)
  sync(true, { "window-zoom-in": [{ key: "F9" }] })
  h.focusPreferences()
  assert.equal(h.menu(), capturing, "same capture state and remapped plain menu items must not rebuild")
  h.blur()
  const restored = h.menu()
  assert.notEqual(restored, capturing)
  assert.equal(h.find("Reload").enabled, true)
  sync(false)
  h.blur()
  h.focusPreferences()
  assert.equal(h.menu(), restored, "background capture cancellation and repeated focus/blur must not rebuild")
  sync(true)
  const recapturing = h.menu()
  sync(false)
  assert.notEqual(h.menu(), recapturing)
  assert.equal(h.find("Reload").enabled, true)
})

test("application menu has no native/renderer accelerator decorations or implicit quit/close roles", () => {
  for (const platform of ["win32", "darwin"]) {
    const h = harness(platform)
    const inspect = (items: MenuItemConstructorOptions[]) => {
      for (const item of items) {
        assert.equal(item.accelerator, undefined)
        assert.notEqual(item.role, "quit")
        assert.notEqual(item.role, "close")
        assert.notEqual(item.role, "hide", "Hide must not inherit Cmd+H")
        assert.notEqual(item.role, "hideOthers", "Hide Others must not inherit Alt+Cmd+H")
        if (Array.isArray(item.submenu)) inspect(item.submenu)
      }
    }
    inspect(h.template())
    h.find("New Instance").click()
    h.find("Command Palette").click()
    h.find("Zoom In").click()
    assert.deepEqual(h.calls, ["local:new-instance", "local:open-command-palette", "zoom:0.5"])
  }
})

test("Mac Hide has one effective keyboard route for defaults/remap/reset/disable, with capture fencing clicks", () => {
  const h = harness("darwin")
  const events = new Map<string, Function>()
  ;(h.local.webContents as unknown as { on: (name: string, listener: Function) => void }).on = (name, listener) => events.set(name, listener)
  installNativeHotkeys(h.local, h.api.executeNativeWindowAction, () => true, () => {})
  const sync = (overrides = {}, recording = false) => setNativeHotkeys(h.local,
    makeNativeHotkeySnapshot(overrides, true, { host: "electron", mac: true }, recording))
  const press = (key: string, alt = false, meta = true) => {
    let prevented = 0
    events.get("before-input-event")!({ preventDefault: () => prevented++ }, { type: "keyDown", key, control: false, meta, shift: false, alt })
    return prevented
  }
  sync()
  assert.equal(press("h"), 1)
  assert.equal(press("h", true), 1)
  assert.deepEqual(h.calls, ["hide:", "hideOtherApplications:"])
  sync({ "window-hide": [{ key: "F9" }], "window-hide-others": [] })
  assert.equal(press("h"), 0)
  assert.equal(press("h", true), 0)
  assert.equal(press("F9", false, false), 1)
  assert.deepEqual(h.calls, ["hide:", "hideOtherApplications:", "hide:"])
  sync()
  assert.equal(press("h"), 1, "reset restores Cmd+H")
  sync({ "window-hide": [], "window-hide-others": [] })
  assert.equal(press("h"), 0)
  assert.equal(press("h", true), 0)
  sync({}, true)
  const count = h.calls.length
  assert.equal(press("h"), 0)
  assert.equal(press("h", true), 0)
  h.find("Hide CodeNomad").click()
  h.find("Hide Others").click()
  assert.equal(h.calls.length, count, "recording cannot hide the app through keys or clicks")
  sync()
  const staleHide = h.find("Hide CodeNomad").click
  h.focusPreferences(); h.record(true)
  assert.equal(h.find("Hide CodeNomad").enabled, false)
  assert.equal(h.find("Hide Others").enabled, false)
  staleHide()
  assert.equal(h.calls.length, count)
})

test("focused Preferences capture disables app menus while preserving editing roles and fences old clicks", () => {
  const h = harness()
  const staleReload = h.find("Reload").click
  const staleNewInstance = h.find("New Instance").click
  h.focusPreferences()
  h.record(true)
  for (const label of ["Reload", "Force Reload", "New Window", "New Instance", "Command Palette", "Minimize", "Close", "Quit", "About CodeNomad"]) {
    assert.equal(h.find(label).enabled, false, label)
  }
  const edit = h.template().find(item => item.id === "menu-edit")!
  assert.deepEqual(Array.from(edit.submenu as MenuItemConstructorOptions[], item => item.role ?? item.type), ["undo", "redo", "separator", "cut", "copy", "paste", "delete", "separator", "selectAll"])
  staleReload()
  staleNewInstance()
  assert.deepEqual(h.calls, [])
  h.record(false)
  assert.equal(h.find("Reload").enabled, true)
  h.find("Reload").click()
  assert.deepEqual(h.calls, ["preferences:reload"])
})

test("keyboard zoom uses the same fixed action as clicks with exactly one execution", () => {
  const h = harness()
  const events = new Map<string, Function>()
  const contents = h.local.webContents as unknown as { on: (name: string, listener: Function) => void }
  contents.on = (name, listener) => events.set(name, listener)
  installNativeHotkeys(h.local, h.api.executeNativeWindowAction, () => true, () => {})
  const bindings = Object.fromEntries(NATIVE_HOTKEY_ACTIONS.map(id => [id, [] as NativeHotkeyBinding[]]))
  bindings["window-zoom-in"] = [{ key: "z", ctrl: true, meta: false, shift: false, alt: false }]
  setNativeHotkeys(h.local, { version: 1, recording: false, bindings })
  let prevented = 0
  events.get("before-input-event")!({ preventDefault: () => prevented++ }, { type: "keyDown", key: "z", control: true, meta: false, shift: false, alt: false })
  assert.equal(prevented, 1)
  assert.deepEqual(h.calls, ["zoom:0.5"])
})
