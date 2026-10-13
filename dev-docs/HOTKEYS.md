# Custom keyboard shortcuts

Settings → Keyboard shortcuts edits `ui.settings.hotkeyOverrides`. Missing IDs
use the current defaults, `[]` disables a binding, and merge-patch `null` resets
one ID or the whole map. Existing saved Enter-submit behavior supplies composer
defaults until overridden. Native editing and local widget navigation remain
outside the manager.

Digit-row and bracket shortcuts use one physical identity for capture, dispatch
and conflict checks, independent of layout (`Digit1` → `1`, `BracketLeft` → `[`).
Other keys remain logical. Older layout-specific `&`, `ü` or `!` overrides on
those physical slots must be re-recorded; they no longer compete silently with
the physical tab-navigation defaults.

## One keyboard route

New session keeps **Mod+Shift+N**, and Close instance keeps **Mod+W**. The former
native collisions move to **Mod+Alt+N** (New window) and **Mod+Alt+W** (Close
window). New instance and Command palette menu entries remain clickable but
have no native accelerator; only the renderer handles their configured keys.
Native window actions are consumed once by the host-owned keyboard route before
renderer actions. Conflicting custom assignments warn on both rows instead of
silently disabling an action.

Application menus do not decorate their labels with key combinations. Native
editing roles retain platform behavior. Quit defaults exist on macOS and on
Electron/Linux; Tauri's non-macOS Quit remains unassigned. Developer tools uses
Mod+Alt+I on macOS and Mod+Shift+I on both other desktop hosts.

## Bounded native state

`lib/native/hotkeys-protocol.json` declares the exact fifteen snapshot IDs,
including customizable macOS Hide and Hide Others. Their explicit defaults are
Mod+H and Mod+Alt+H; plain menu actions never inherit an implicit OS accelerator.
Only version 1, a boolean recording flag, and complete binding records with at
most eight combinations per ID are accepted. Keys are bounded to forty UTF-16
units; all four resolved modifier flags are mandatory. No arbitrary action,
target, source, command or executable is accepted.

UI configuration and recording changes are serialized through the existing
Electron/Tauri native abstraction. The capture input appears only after native
suppression is acknowledged; blur, cancellation, inactive sections and disposal
release it. Native reload/close fences clear the accepted map. Tauri also fences
queued actions and map installation with a generation and installation ack.

Registered remote primary renderers may configure their own window controls,
but cannot obtain New local window or application-wide Quit authority. The same
registered-origin/caller-window guard as owned zoom applies. Browser previews,
subframes and sandboxed panel extensions receive no native hotkey capability.

## Windows and validation limits

Windows WebView2 browser zoom keys are suppressed individually, preserving DOM
delivery and native wheel gestures. This handler is separate from the existing
F6 crash workaround; neither F6 nor the Tao vendor patches are changed. A
demonstrated missing per-key WebView2 capability ends/refuses recording rather
than enabling a browser-action fallback or disabling unrelated shortcuts.

OS-reserved combinations may not reach an application. Live macOS/Linux and
WebView2 delivery require graphical qualification; pure host/script tests do
not establish those results. No shared OpenCode daemon restart or shutdown is
part of changing keyboard shortcuts.
