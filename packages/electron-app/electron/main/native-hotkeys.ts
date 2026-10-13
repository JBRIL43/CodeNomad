import type { BrowserWindow, Input, IpcMainInvokeEvent } from "electron"
import {
  matchNativeHotkey, normalizeNativeHotkeySnapshot,
  type NativeHotkeyAction, type NativeHotkeySnapshot,
} from "../../../ui/src/lib/native/hotkeys-contract"
import { validateMainFrame } from "./ipc-security"

const windows = new WeakMap<BrowserWindow, { snapshot: NativeHotkeySnapshot | null; changed: () => void; allowGlobal: boolean }>()

export function isNativeHotkeyRecording(window: BrowserWindow | null): boolean {
  return Boolean(window && windows.get(window)?.snapshot?.recording)
}

export function setNativeHotkeys(window: BrowserWindow, value: unknown): void {
  const state = windows.get(window)
  if (!state) throw new Error("Native hotkeys require an owned application window")
  const snapshot = normalizeNativeHotkeySnapshot(value)
  if (!snapshot) throw new Error("Invalid native hotkey snapshot")
  if (!state.allowGlobal && ["window-new", "app-quit", "window-hide", "window-hide-others"].some(id => snapshot.bindings[id as NativeHotkeyAction].length)) {
    throw new Error("Global application hotkeys require a local renderer or Preferences")
  }
  state.snapshot = snapshot
  window.webContents.setIgnoreMenuShortcuts(snapshot.recording)
  state.changed()
}

export function setupNativeHotkeyIPC(
  ipc: { handle(channel: string, handler: (event: IpcMainInvokeEvent, value: unknown) => void): void },
  resolveWindow: (sender: IpcMainInvokeEvent["sender"]) => BrowserWindow | undefined,
  getAllowedOrigins: (window: BrowserWindow) => string[],
): void {
  ipc.handle("native-hotkeys:set", (event, value) => {
    const window = resolveWindow(event.sender)
    if (!window) throw new Error("Native hotkeys require an owned application window")
    validateMainFrame(event, window, getAllowedOrigins(window))
    setNativeHotkeys(window, value)
  })
}

export function installNativeHotkeys(
  window: BrowserWindow,
  execute: (window: BrowserWindow, action: NativeHotkeyAction) => void,
  isTrusted: () => boolean,
  changed: () => void,
  allowGlobal = true,
): void {
  if (windows.has(window)) return
  const state = { snapshot: null as NativeHotkeySnapshot | null, changed, allowGlobal }
  windows.set(window, state)
  const clear = () => {
    state.snapshot = null
    if (!window.webContents.isDestroyed()) window.webContents.setIgnoreMenuShortcuts(false)
    changed()
  }
  window.webContents.on("before-input-event", (event, input: Input) => {
    const snapshot = state.snapshot
    if (!snapshot || snapshot.recording || input.type !== "keyDown" || input.isComposing || !isTrusted()) return
    const action = matchNativeHotkey(snapshot, {
      key: input.key, code: input.code,
      ctrlKey: input.control, metaKey: input.meta, shiftKey: input.shift, altKey: input.alt,
    })
    if (!action) return
    event.preventDefault()
    if (input.isAutoRepeat) return
    execute(window, action)
  })
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) clear()
  })
  window.webContents.on("render-process-gone", clear)
  window.webContents.on("did-navigate", clear)
  window.on("closed", () => { state.snapshot = null; windows.delete(window); changed() })
}
