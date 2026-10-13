import type { HotkeyBinding } from "./hotkey-bindings"
import nativeProtocol from "./native/hotkeys-protocol.json"

export interface HotkeyDefaultContext { host?: string; mac?: boolean; linux?: boolean; windowContext?: string }

export interface HotkeyDefinition {
  id: string
  labelKey: string
  category: "app" | "session" | "composer" | "search" | "files" | "window"
  scope: "app" | "main" | "home" | "instance" | "session" | "composer" | "aside" | "search" | "files" | "instance-tab"
  hosts?: string[]
  contexts?: string[]
}

const definition = (id: string, category: HotkeyDefinition["category"], scope: HotkeyDefinition["scope"]): HotkeyDefinition => ({
  id, labelKey: `hotkeys.action.${id}`, category, scope,
})

// Static metadata is available in Preferences without mounting the application.
export const hotkeyDefinitions: HotkeyDefinition[] = [
  definition("open-command-palette", "app", "instance"),
  definition("new-instance", "app", "main"),
  ...["close-instance", "instance-prev", "instance-next"].map(id => definition(id, "app", "app")),
  definition("browse-folder", "app", "home"),
  ...["session-new", "session-prev", "session-next", "switch-to-info"].map(id => definition(id, "session", "instance")),
  ...["close-session", "session-abort", "session-search"].map(id => definition(id, "session", "session")),
  ...["clear-input", "focus-input", "focus-model", "open-agent-selector", "focus-variant"].map(id => definition(id, "composer", "session")),
  ...["session-background", "prompt-send", "prompt-alternate-send", "prompt-newline", "prompt-history-prev", "prompt-history-next", "prompt-exit-shell", "prompt-blur"].map(id => definition(id, "composer", "composer")),
  definition("aside-send", "composer", "aside"),
  ...["search-next-result", "search-prev-result"].map(id => definition(id, "search", "search")),
  definition("file-save", "files", "files"),
  definition("instance-rename", "app", "instance-tab"),
  ...Array.from({ length: 9 }, (_, i) => ({ ...definition(`app-tab-${i + 1}`, "app", "app"), labelKey: "hotkeys.action.app-tab" })),
  ...Array.from({ length: 9 }, (_, i) => ({ ...definition(`session-tab-${i + 1}`, "session", "instance"), labelKey: "hotkeys.action.session-tab" })),
  ...nativeProtocol.actions.filter(id => id !== "new-instance" && id !== "open-command-palette")
    .map(id => ({ ...definition(id, "window", "app"), hosts: ["electron", "tauri"],
      ...(["window-new", "app-quit", "window-hide", "window-hide-others"].includes(id) ? { contexts: ["local", "preferences"] } : {}) })),
]

export function getHotkeyDefinitions(filter?: { host?: string; category?: string; windowContext?: string }): HotkeyDefinition[] {
  return hotkeyDefinitions.filter(item => (!filter?.category || item.category === filter.category)
    && (!filter?.host || !item.hosts || item.hosts.includes(filter.host))
    && (!filter?.windowContext || !item.contexts || item.contexts.includes(filter.windowContext)))
}

const defaults: Record<string, HotkeyBinding[]> = {
  "open-command-palette": [{ key: "p", mod: true, shift: true }],
  "new-instance": [{ key: "n", mod: true }],
  "browse-folder": [{ key: "n", mod: true }],
  "close-instance": [{ key: "w", mod: true }],
  "instance-prev": [{ key: "[", mod: true }],
  "instance-next": [{ key: "]", mod: true }],
  "session-new": [{ key: "n", mod: true, shift: true }],
  "session-prev": [{ key: "[", mod: true, shift: true }],
  "session-next": [{ key: "]", mod: true, shift: true }],
  "switch-to-info": [{ key: "l", mod: true, shift: true }],
  "close-session": [{ key: "w", mod: true, shift: true }],
  "session-abort": [{ key: "Escape" }],
  "prompt-blur": [{ key: "Escape" }],
  "clear-input": [{ key: "k", mod: true }],
  "focus-input": [{ key: "p", mod: true }],
  "focus-model": [{ key: "m", mod: true, shift: true }],
  "open-agent-selector": [{ key: "a", mod: true, shift: true }],
  "focus-variant": [{ key: "t", mod: true, shift: true }],
  "session-search": [{ key: "f", mod: true }],
  "session-background": [{ key: "b", mod: true }],
  "prompt-alternate-send": [{ key: "Enter", mod: true, shift: true }],
  "prompt-history-prev": [{ key: "ArrowUp" }],
  "prompt-history-next": [{ key: "ArrowDown" }],
  "prompt-exit-shell": [{ key: "Escape" }],
  "aside-send": [{ key: "Enter", mod: true }],
  "search-next-result": [{ key: "Enter" }],
  "search-prev-result": [{ key: "Enter", shift: true }],
  "file-save": [{ key: "s", mod: true }],
  "instance-rename": [{ key: "F2" }],
}

export function defaultHotkeyBindings(id: string, promptSubmitOnEnter = true, context: HotkeyDefaultContext = {}): HotkeyBinding[] {
  if (nativeProtocol.actions.includes(id) && id !== "new-instance" && id !== "open-command-palette") {
    if (context.host !== "electron" && context.host !== "tauri") return []
    if (context.windowContext === "remote" && ["window-new", "app-quit", "window-hide", "window-hide-others"].includes(id)) return []
    const native: Record<string, HotkeyBinding[]> = {
      // Project/session bindings keep their established defaults. Native window
      // creation/close get distinct bindings and never compete with the renderer.
      "window-new": [{ key: "n", mod: true, alt: true }],
      "window-close": [{ key: "w", mod: true, alt: true }],
      "window-reload": [{ key: "r", mod: true }],
      "window-force-reload": [{ key: "r", mod: true, shift: true }],
      "window-devtools": [{ key: "i", mod: true, ...(context.mac ? { alt: true } : { shift: true }) }],
      "window-zoom-in": [{ key: "=", mod: true }, { key: "+", mod: true, shift: true }, { key: "+", mod: true }],
      "window-zoom-out": [{ key: "-", mod: true }],
      "window-zoom-reset": [{ key: "0", mod: true }],
      "window-fullscreen": context.mac ? [{ key: "f", mod: true, ctrl: true }] : [{ key: "F11" }],
      "window-minimize": context.mac || context.host === "electron" ? [{ key: "m", mod: true }] : [],
      "window-hide": context.mac ? [{ key: "h", mod: true }] : [],
      "window-hide-others": context.mac ? [{ key: "h", mod: true, alt: true }] : [],
      "app-quit": context.mac || (context.host === "electron" && context.linux) ? [{ key: "q", mod: true }] : [],
    }
    return native[id] ?? []
  }
  if (id === "prompt-send") return [{ key: "Enter", ...(!promptSubmitOnEnter ? { mod: true } : {}) }]
  if (id === "prompt-newline") return promptSubmitOnEnter
    ? [{ key: "Enter", shift: true }, { key: "Enter", mod: true }]
    : [{ key: "Enter" }, { key: "Enter", shift: true }]
  const tab = /^(app|session)-tab-([1-9])$/.exec(id)
  if (tab) return [{ key: tab[2], mod: true, ...(tab[1] === "session" ? { shift: true } : {}) }]
  return (defaults[id] ?? []).map(binding => ({ ...binding }))
}
