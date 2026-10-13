import type { NativeDialogOptions } from "../native-functions"
import { getLogger } from "../../logger"
import type { NativeHotkeySnapshot } from "../hotkeys-contract"
const log = getLogger("actions")

export async function setElectronNativeHotkeys(snapshot: NativeHotkeySnapshot): Promise<void> {
  if (!window.electronAPI?.setNativeHotkeys) throw new Error("Native hotkey support is unavailable")
  await window.electronAPI.setNativeHotkeys(snapshot)
}


interface ElectronDialogResult {
  canceled?: boolean
  paths?: string[]
  path?: string | null
}

interface ElectronAPI {
  openDialog?: (options: NativeDialogOptions) => Promise<ElectronDialogResult>
}

function coercePaths(result?: ElectronDialogResult | null): string[] {
  if (!result || result.canceled) {
    return []
  }
  const paths = Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : []
  return paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
}

export async function openElectronNativeDialog(options: NativeDialogOptions): Promise<string | string[] | null> {
  if (typeof window === "undefined") {
    return null
  }
  const api = (window as Window & { electronAPI?: ElectronAPI }).electronAPI
  if (!api?.openDialog) {
    return null
  }
  try {
    const result = await api.openDialog(options)
    const paths = coercePaths(result)
    return options.multiple ? paths : paths[0] ?? null
  } catch (error) {
    log.error("[native] electron dialog failed", error)
    return null
  }
}
