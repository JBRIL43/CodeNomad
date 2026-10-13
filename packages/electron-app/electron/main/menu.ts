import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from "electron"
import type { NativeHotkeyAction } from "../../../ui/src/lib/native/hotkeys-contract"
import { isNativeHotkeyRecording } from "./native-hotkeys"
import { setWindowZoomLevel } from "./window-state"
import { setViewMenuState, updateViewMenu, viewMenuItems } from "./view-menu"

interface ApplicationMenuActions {
  getLocalTarget(): BrowserWindow | null
  getWindowTarget(): BrowserWindow | null
  newWindow(): void
  reload(window: BrowserWindow): void
  forceReload(window: BrowserWindow): void
}

const workspaceEnabled = new Map<number, boolean>()
let applicationMenu: Menu | null = null
let menuInstalled = false
let menuRecording = false
let actions: ApplicationMenuActions | null = null

export type TitlebarMenu = "file" | "edit" | "view" | "window" | "help"

function target(local: boolean): BrowserWindow | null {
  const window = (local ? actions?.getLocalTarget() : actions?.getWindowTarget()) ?? null
  return window && !window.isDestroyed() ? window : null
}

function updateWorkspaceMenuState() {
  const window = target(true)
  const recording = isNativeHotkeyRecording(BrowserWindow.getFocusedWindow())
  if (recording !== menuRecording || updateViewMenu(applicationMenu, window)) {
    buildApplicationMenu()
    return
  }
  const enabled = Boolean(window && workspaceEnabled.get(window.webContents.id))
  for (const id of ["open-workspace-folder", "open-workspace-terminal", "open-workspace-editor"]) {
    const item = applicationMenu?.getMenuItemById(id)
    if (item) item.enabled = enabled
  }
  if (recording) {
    const disable = (menu: Menu) => {
      for (const item of menu.items) {
        if (item.id === "menu-edit") continue
        if (item.submenu) disable(item.submenu)
        else if (item.type !== "separator") item.enabled = false
      }
    }
    if (applicationMenu) disable(applicationMenu)
  }
}

export function refreshNativeHotkeyMenu(): void {
  if (menuInstalled) updateWorkspaceMenuState()
}

export function executeNativeWindowAction(window: BrowserWindow | null, id: NativeHotkeyAction): void {
  // Focus can change after a native popup was built; never redirect a recording
  // Preferences window's action to the previous local/MRU window.
  if (isNativeHotkeyRecording(BrowserWindow.getFocusedWindow()) || isNativeHotkeyRecording(window)) return
  if (id === "window-new") { actions?.newWindow(); return }
  if (id === "app-quit") { app.quit(); return }
  if (id === "window-hide" || id === "window-hide-others") {
    if (process.platform === "darwin") Menu.sendActionToFirstResponder(id === "window-hide" ? "hide:" : "hideOtherApplications:")
    return
  }
  if (!window || window.isDestroyed()) return
  switch (id) {
    case "window-reload": actions?.reload(window); break
    case "window-force-reload": actions?.forceReload(window); break
    case "window-devtools": window.webContents.toggleDevTools(); break
    case "window-zoom-reset": setWindowZoomLevel(window, 0); break
    case "window-zoom-in": setWindowZoomLevel(window, window.webContents.getZoomLevel() + 0.5); break
    case "window-zoom-out": setWindowZoomLevel(window, window.webContents.getZoomLevel() - 0.5); break
    case "window-fullscreen": window.setFullScreen(!window.isFullScreen()); break
    case "window-minimize": window.minimize(); break
    case "window-close": window.close(); break
  }
}

export function setWorkspaceMenuEnabled(window: BrowserWindow, enabled: boolean, viewState?: unknown) {
  setViewMenuState(window.webContents.id, viewState)
  workspaceEnabled.set(window.webContents.id, enabled)
  updateWorkspaceMenuState()
}

export function clearWorkspaceMenuWindow(webContentsId: number) {
  setViewMenuState(webContentsId, undefined)
  workspaceEnabled.delete(webContentsId)
  updateWorkspaceMenuState()
}

export function popupTitlebarMenu(window: BrowserWindow, menu: TitlebarMenu, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Invalid titlebar menu position")
  updateWorkspaceMenuState()
  const submenu = applicationMenu?.getMenuItemById(`menu-${menu}`)?.submenu
  if (!submenu) throw new Error(`Unknown titlebar menu: ${menu}`)
  submenu.popup({ window, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) })
}

export function createApplicationMenu(menuActions: ApplicationMenuActions) {
  actions = menuActions
  if (menuInstalled) return
  menuInstalled = true
  buildApplicationMenu()
  app.on("browser-window-focus", refreshNativeHotkeyMenu)
  app.on("browser-window-blur", refreshNativeHotkeyMenu)
}

function buildApplicationMenu() {
  const isMac = process.platform === "darwin"
  const sendCommand = (id: string) => () => {
    if (!isNativeHotkeyRecording(BrowserWindow.getFocusedWindow())) target(true)?.webContents.send("menu:action", id)
  }
  const nativeItem = (label: string, id: NativeHotkeyAction): MenuItemConstructorOptions => ({
    label, click: () => executeNativeWindowAction(target(false), id),
  })

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ label: "CodeNomad", submenu: [
      { role: "about" as const }, { type: "separator" as const }, nativeItem("Hide CodeNomad", "window-hide"),
      nativeItem("Hide Others", "window-hide-others"), { role: "unhide" as const }, { type: "separator" as const }, nativeItem("Quit", "app-quit"),
    ] }] : []),
    {
      id: "menu-file",
      label: "File",
      submenu: [
        { id: "open-workspace-folder", label: "Open Project Folder", click: sendCommand("open-workspace-folder") },
        { id: "open-workspace-terminal", label: "Open Terminal Here", click: sendCommand("open-workspace-terminal") },
        { id: "open-workspace-editor", label: "Open Project In", submenu: [
          { label: "VS Code", click: sendCommand("open-workspace-editor-vscode") },
          { label: "Cursor", click: sendCommand("open-workspace-editor-cursor") },
          { label: "Zed", click: sendCommand("open-workspace-editor-zed") },
          { label: "VSCodium", click: sendCommand("open-workspace-editor-vscodium") },
        ] },
        { type: "separator" }, isMac ? nativeItem("Close", "window-close") : nativeItem("Quit", "app-quit"),
      ],
    },
    { id: "menu-edit", label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" },
      ...(isMac ? [{ role: "pasteAndMatchStyle" as const }, { role: "delete" as const }, { role: "selectAll" as const }]
        : [{ role: "delete" as const }, { type: "separator" as const }, { role: "selectAll" as const }]),
    ] },
    { id: "menu-view", label: "View", submenu: [
      ...viewMenuItems(sendCommand, target(true)),
      { type: "separator" },
      nativeItem("Reload", "window-reload"),
      nativeItem("Force Reload", "window-force-reload"),
      nativeItem("Toggle Developer Tools", "window-devtools"),
      { type: "separator" },
      nativeItem("Actual Size", "window-zoom-reset"),
      nativeItem("Zoom In", "window-zoom-in"),
      nativeItem("Zoom Out", "window-zoom-out"),
      { type: "separator" },
      nativeItem("Toggle Full Screen", "window-fullscreen"),
    ] },
    { id: "menu-window", label: "Window", submenu: [
      nativeItem("New Window", "window-new"),
      { label: "New Instance", click: sendCommand("new-instance") },
      { label: "Command Palette", click: sendCommand("open-command-palette") },
      { type: "separator" },
      nativeItem("Minimize", "window-minimize"),
      ...(isMac ? [{ role: "front" as const }] : [nativeItem("Close", "window-close")]),
    ] },
    { id: "menu-help", label: "Help", submenu: [
      { label: "Get Updates...", click: () => { void shell.openExternal("https://github.com/NeuralNomadsAI/CodeNomad/releases").catch(() => {}) } },
      { type: "separator" },
      { label: "About CodeNomad", click: () => app.showAboutPanel() },
    ] },
  ]

  applicationMenu = Menu.buildFromTemplate(template)
  menuRecording = isNativeHotkeyRecording(BrowserWindow.getFocusedWindow())
  Menu.setApplicationMenu(applicationMenu)
  updateWorkspaceMenuState()
}
