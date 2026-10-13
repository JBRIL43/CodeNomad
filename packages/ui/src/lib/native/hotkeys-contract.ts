import protocol from "./hotkeys-protocol.json"
import { matchesHotkeyBinding, resolveHotkeyBindings, type HotkeyKeyEvent, type HotkeyOverrides } from "../hotkey-bindings"
import type { HotkeyDefaultContext } from "../hotkey-definitions"

export type NativeHotkeyAction = "window-new" | "window-reload" | "window-force-reload" | "window-devtools"
  | "window-zoom-in" | "window-zoom-out" | "window-zoom-reset" | "window-fullscreen" | "window-minimize"
  | "window-hide" | "window-hide-others" | "window-close" | "app-quit" | "new-instance" | "open-command-palette"
export interface NativeHotkeyBinding {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}
export interface NativeHotkeySnapshot {
  version: 1
  recording: boolean
  bindings: Record<NativeHotkeyAction, NativeHotkeyBinding[]>
}
export const NATIVE_HOTKEY_ACTIONS = protocol.actions as NativeHotkeyAction[]
const modifiers = ["ctrl", "meta", "shift", "alt"] as const
const invalidKeys = new Set(["control", "ctrl", "meta", "shift", "alt", "altgraph", "unidentified", "dead", "process"])
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length
  && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))

export function makeNativeHotkeySnapshot(overrides: HotkeyOverrides, submitOnEnter: boolean,
  context: HotkeyDefaultContext, recording: boolean): NativeHotkeySnapshot {
  const bindings = {} as NativeHotkeySnapshot["bindings"]
  for (const id of NATIVE_HOTKEY_ACTIONS) {
    if (context.windowContext === "remote" && ["window-new", "app-quit", "window-hide", "window-hide-others"].includes(id)) { bindings[id] = []; continue }
    bindings[id] = resolveHotkeyBindings(id, overrides, submitOnEnter, context).map(binding => ({
      key: binding.key.toLowerCase(), ctrl: Boolean(binding.ctrl || (binding.mod && !context.mac)),
      meta: Boolean(binding.meta || (binding.mod && context.mac)), shift: Boolean(binding.shift), alt: Boolean(binding.alt),
    }))
  }
  return { version: 1, recording, bindings }
}

/** A narrow state transfer, never an action/target supplied by a renderer. */
export function normalizeNativeHotkeySnapshot(value: unknown): NativeHotkeySnapshot | null {
  if (!object(value) || !exactKeys(value, ["version", "recording", "bindings"]) || value.version !== protocol.version
    || typeof value.recording !== "boolean" || !object(value.bindings) || !exactKeys(value.bindings, NATIVE_HOTKEY_ACTIONS)) return null
  const bindings = {} as NativeHotkeySnapshot["bindings"]
  for (const id of NATIVE_HOTKEY_ACTIONS) {
    const list = value.bindings[id]
    if (!Array.isArray(list) || list.length > protocol.maxBindings) return null
    bindings[id] = []
    for (const item of list) {
      if (!object(item) || !exactKeys(item, ["key", ...modifiers]) || typeof item.key !== "string" || !item.key
        || item.key.length > protocol.maxKeyLength || /[\u0000-\u001f\u007f-\u009f]/.test(item.key)
        || invalidKeys.has(item.key.toLowerCase()) || modifiers.some(modifier => typeof item[modifier] !== "boolean")) return null
      bindings[id].push({ key: item.key.toLowerCase(), ctrl: item.ctrl as boolean, meta: item.meta as boolean,
        shift: item.shift as boolean, alt: item.alt as boolean })
    }
  }
  return { version: 1, recording: value.recording, bindings }
}

export function isNativeWindowAction(id: string): id is NativeHotkeyAction {
  return NATIVE_HOTKEY_ACTIONS.includes(id as NativeHotkeyAction) && id !== "new-instance" && id !== "open-command-palette"
}

export function matchNativeHotkey(snapshot: NativeHotkeySnapshot | null | undefined,
  event: HotkeyKeyEvent): NativeHotkeyAction | null {
  if (!snapshot || snapshot.recording) return null
  for (const id of NATIVE_HOTKEY_ACTIONS) {
    if (isNativeWindowAction(id) && snapshot.bindings[id].some(binding => matchesHotkeyBinding(binding, { ...event, code: event.code ?? "" }, false))) return id
  }
  return null
}

/** Only for a host's private shortcut parser, not visible menu decoration. */
export function nativeHotkeyAccelerator(binding: NativeHotkeyBinding): string {
  const keys: Record<string, string> = { " ": "Space", "+": "Plus", "-": "Minus", "=": "Equal", escape: "Escape",
    arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right" }
  return [binding.ctrl && "Ctrl", binding.meta && "Super", binding.alt && "Alt", binding.shift && "Shift",
    keys[binding.key.toLowerCase()] ?? binding.key.toUpperCase()].filter(Boolean).join("+")
}
