import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { listen } from "@tauri-apps/api/event"
import { hotkeyDefaultContext, isHotkeyRecording, setHotkeyRecording } from "../hotkeys"
import { runtimeEnv } from "../runtime-env"
import { getLogger } from "../logger"
import type { UiSettings } from "../../stores/preferences"
import { makeNativeHotkeySnapshot, type NativeHotkeySnapshot } from "./hotkeys-contract"
import { setNativeHotkeys } from "./native-functions"

const log = getLogger("actions")
let current: { token: number; ready: Accessor<boolean>; snapshot: () => NativeHotkeySnapshot } | undefined
let generation = 0, queuedJSON = ""
let queue = Promise.resolve(true)
const [nativeHotkeysUnavailable, setNativeHotkeysUnavailable] = createSignal(false)
export { nativeHotkeysUnavailable }

/** Shared by the main renderer and Preferences; no preview renderer mounts this. */
export function useNativeHotkeySync(settings: Accessor<UiSettings>, ready: Accessor<boolean>) {
  const token = ++generation
  let disposed = false, unlisten: (() => void) | undefined
  current = { token, ready, snapshot: () => makeNativeHotkeySnapshot(settings().hotkeyOverrides,
    settings().promptSubmitOnEnter, hotkeyDefaultContext(), isHotkeyRecording()) }
  if (runtimeEnv.host === "tauri") {
    void listen<string>("native-hotkeys:unavailable", event => {
      if (event.payload !== "browser-zoom-key-delivery" || current?.token !== token) return
      setNativeHotkeysUnavailable(true)
      setHotkeyRecording(false)
    }).then(dispose => { if (disposed) dispose(); else unlisten = dispose })
      .catch(error => log.warn("Native hotkey capability listener failed", error))
  }
  createEffect(() => {
    if (runtimeEnv.host === "web" || !ready()) return
    current?.snapshot() // Track only the effective configuration and recording flag.
    void flushNativeHotkeys()
  })
  onCleanup(() => {
    disposed = true
    unlisten?.()
    if (current?.token === token) { current = undefined; queuedJSON = "" }
  })
}

/** Explicit capture waits for native suppression before showing its input. */
export function flushNativeHotkeys(force = false): Promise<boolean> {
  if (runtimeEnv.host === "web") return Promise.resolve(true)
  if (isHotkeyRecording() && nativeHotkeysUnavailable()) return Promise.resolve(false)
  const registration = current
  if (!registration?.ready()) return Promise.resolve(false)
  const snapshot = registration.snapshot(), json = JSON.stringify(snapshot)
  if (!force && json === queuedJSON) return queue
  queuedJSON = json
  queue = queue.then(async () => {
    if (current?.token !== registration.token) return false
    try { await setNativeHotkeys(snapshot); return true }
    catch (error) {
      if (String(error).includes("browser-zoom-key-delivery")) { setNativeHotkeysUnavailable(true); setHotkeyRecording(false) }
      log.warn("Native hotkey synchronization failed", error)
      return false
    }
  })
  return queue
}
