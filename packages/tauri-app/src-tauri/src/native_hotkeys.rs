//! One focused, owned DOM keyboard route. Menus have no application accelerators;
//! renderer-owned new-instance/palette never enter this native dispatcher.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, Runtime, Url, Webview, WebviewWindowBuilder};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Binding {
    #[serde(deserialize_with = "deserialize_key")]
    key: String,
    ctrl: bool,
    meta: bool,
    shift: bool,
    alt: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Action {
    WindowNew,
    WindowReload,
    WindowForceReload,
    WindowDevtools,
    WindowZoomIn,
    WindowZoomOut,
    WindowZoomReset,
    WindowFullscreen,
    WindowMinimize,
    WindowHide,
    WindowHideOthers,
    WindowClose,
    AppQuit,
    NewInstance,
    OpenCommandPalette,
}

const ACTIONS: [Action; 15] = [
    Action::WindowNew,
    Action::WindowReload,
    Action::WindowForceReload,
    Action::WindowDevtools,
    Action::WindowZoomIn,
    Action::WindowZoomOut,
    Action::WindowZoomReset,
    Action::WindowFullscreen,
    Action::WindowMinimize,
    Action::WindowHide,
    Action::WindowHideOthers,
    Action::WindowClose,
    Action::AppQuit,
    Action::NewInstance,
    Action::OpenCommandPalette,
];

impl Action {
    fn native(self) -> bool {
        !matches!(self, Self::NewInstance | Self::OpenCommandPalette)
    }
}

// A struct rejects duplicate, unknown AND missing action keys at deserialization.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub(crate) struct Bindings {
    #[serde(deserialize_with = "deserialize_bindings")]
    window_new: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_reload: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_force_reload: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_devtools: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_zoom_in: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_zoom_out: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_zoom_reset: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_fullscreen: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_minimize: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_hide: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_hide_others: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    window_close: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    app_quit: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    new_instance: Vec<Binding>,
    #[serde(deserialize_with = "deserialize_bindings")]
    open_command_palette: Vec<Binding>,
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.encode_utf16().count() <= 40
        && !key.chars().any(char::is_control)
        && !matches!(
            key.to_lowercase().as_str(),
            "control"
                | "ctrl"
                | "meta"
                | "shift"
                | "alt"
                | "altgraph"
                | "unidentified"
                | "dead"
                | "process"
        )
}

fn deserialize_key<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let key = String::deserialize(deserializer)?;
    if valid_key(&key) {
        Ok(key)
    } else {
        Err(serde::de::Error::custom("Invalid native hotkey key"))
    }
}

fn deserialize_bindings<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Binding>, D::Error> {
    struct BoundedBindings;
    impl<'de> serde::de::Visitor<'de> for BoundedBindings {
        type Value = Vec<Binding>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("at most eight native hotkey bindings")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> Result<Self::Value, A::Error> {
            let mut bindings = Vec::new();
            while let Some(binding) = sequence.next_element()? {
                if bindings.len() == 8 {
                    return Err(serde::de::Error::custom("Too many native hotkey bindings"));
                }
                bindings.push(binding);
            }
            Ok(bindings)
        }
    }
    deserializer.deserialize_seq(BoundedBindings)
}

impl Bindings {
    fn for_action(&self, action: Action) -> &[Binding] {
        match action {
            Action::WindowNew => &self.window_new,
            Action::WindowReload => &self.window_reload,
            Action::WindowForceReload => &self.window_force_reload,
            Action::WindowDevtools => &self.window_devtools,
            Action::WindowZoomIn => &self.window_zoom_in,
            Action::WindowZoomOut => &self.window_zoom_out,
            Action::WindowZoomReset => &self.window_zoom_reset,
            Action::WindowFullscreen => &self.window_fullscreen,
            Action::WindowMinimize => &self.window_minimize,
            Action::WindowHide => &self.window_hide,
            Action::WindowHideOthers => &self.window_hide_others,
            Action::WindowClose => &self.window_close,
            Action::AppQuit => &self.app_quit,
            Action::NewInstance => &self.new_instance,
            Action::OpenCommandPalette => &self.open_command_palette,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Snapshot {
    version: u32,
    recording: bool,
    bindings: Bindings,
}

impl Snapshot {
    fn requires_global_authority(&self) -> bool {
        [Action::WindowNew, Action::AppQuit, Action::WindowHide, Action::WindowHideOthers]
            .into_iter().any(|action| !self.bindings.for_action(action).is_empty())
    }
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported native hotkey snapshot version".into());
        }
        for action in ACTIONS {
            let bindings = self.bindings.for_action(action);
            if bindings.len() > 8 {
                return Err("Too many native hotkey bindings".into());
            }
            for binding in bindings {
                if !valid_key(&binding.key) {
                    return Err("Invalid native hotkey key".into());
                }
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Registry {
    generation: u64,
    // Physical remote-window identity, independent of page/snapshot revisions.
    remote_windows: HashMap<String, u64>,
    pages: HashMap<String, u64>,
    snapshots: HashMap<String, (u64, Snapshot)>,
    pending: HashMap<String, (u64, std::sync::mpsc::SyncSender<Result<(), String>>)>,
    #[cfg(windows)]
    browser_keys_unavailable: std::collections::HashSet<String>,
}

impl Registry {
    fn clear(&mut self, label: &str) {
        self.generation += 1;
        self.pages.insert(label.into(), self.generation);
        self.snapshots.remove(label);
        if let Some((_, sender)) = self.pending.remove(label) {
            let _ = sender.try_send(Err("Hotkey renderer navigated or closed".into()));
        }
    }
    fn remove(&mut self, label: &str) {
        self.clear(label);
        self.pages.remove(label);
        self.remote_windows.remove(label);
        #[cfg(windows)]
        self.browser_keys_unavailable.remove(label);
    }
    fn allows(&self, label: &str, generation: u64, action: Action) -> bool {
        action.native()
            && self
                .snapshots
                .get(label)
                .is_some_and(|(accepted, snapshot)| {
                    *accepted == generation
                        && !snapshot.recording
                        && !snapshot.bindings.for_action(action).is_empty()
                })
    }
}

#[derive(Default)]
pub(crate) struct NativeHotkeys {
    registry: Mutex<Registry>,
    menu_dirty: AtomicBool,
    #[cfg(windows)]
    pub(crate) host: Mutex<std::sync::Weak<AppHandle>>,
}

impl NativeHotkeys {
    #[cfg(windows)]
    pub(crate) fn mark_browser_keys_unavailable(&self, label: &str) -> bool {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .browser_keys_unavailable
            .insert(label.into())
    }
    #[cfg(windows)]
    pub(crate) fn browser_keys_unavailable(&self, label: &str) -> bool {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .browser_keys_unavailable
            .contains(label)
    }
    pub(crate) fn clear(&self, label: &str) {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear(label);
        self.menu_dirty.store(true, Ordering::Release);
    }
    pub(crate) fn remove(&self, label: &str) {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(label);
        self.menu_dirty.store(true, Ordering::Release);
    }
    pub(crate) fn prepare_remote_window(&self, label: &str, window_generation: u64) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        registry.remove(label);
        registry
            .remote_windows
            .insert(label.into(), window_generation);
        registry.clear(label);
        self.menu_dirty.store(true, Ordering::Release);
    }
    pub(crate) fn clear_remote_page(&self, label: &str, window_generation: u64) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if registry.remote_windows.get(label).copied() == Some(window_generation) {
            registry.clear(label);
            self.menu_dirty.store(true, Ordering::Release);
        }
    }
    pub(crate) fn remove_remote_window(&self, label: &str, window_generation: u64) -> bool {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if registry.remote_windows.get(label).copied() != Some(window_generation) {
            return false;
        }
        registry.remove(label);
        self.menu_dirty.store(true, Ordering::Release);
        true
    }
    pub(crate) fn take_menu_dirty(&self) -> bool {
        self.menu_dirty.swap(false, Ordering::AcqRel)
    }
    pub(crate) fn menu_recording(&self) -> bool {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshots
            .values()
            .any(|(_, snapshot)| snapshot.recording)
    }
    pub(crate) fn page(&self, label: &str) -> u64 {
        self.registry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pages
            .get(label)
            .copied()
            .unwrap_or(0)
    }
}

fn require_owner(webview: &Webview) -> Result<Url, String> {
    crate::window_zoom::require_owned_webview(webview, webview.app_handle())
}

pub(crate) fn configure<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let actions: Vec<_> = ACTIONS
        .into_iter()
        .filter(|action| action.native())
        .collect();
    builder.initialization_script(include_str!("window_hotkeys.js").replace(
        "__NATIVE_ACTIONS__",
        &serde_json::to_string(&actions).unwrap(),
    ))
}

#[tauri::command]
pub(crate) async fn set_native_hotkeys(webview: Webview, snapshot: Snapshot) -> Result<(), String> {
    snapshot.validate()?;
    // Remote renderers retain caller-window controls, not app-wide authority.
    if webview.label().starts_with("remote-") && snapshot.requires_global_authority() {
        return Err("Global application hotkeys require a local renderer or Preferences".into());
    }
    let admitted_url = require_owner(&webview)?;
    let app = webview.app_handle().clone();
    let page = app.state::<NativeHotkeys>().page(webview.label());
    #[cfg(windows)]
    if snapshot.recording
        && app.state::<NativeHotkeys>().browser_keys_unavailable(webview.label())
    {
        return Err("browser-zoom-key-delivery".into());
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.clone().run_on_main_thread(move || {
        let result = (|| {
            if require_owner(&webview)? != admitted_url || app.state::<NativeHotkeys>().page(webview.label()) != page {
                return Err("Hotkey renderer changed before synchronization".into());
            }
            let hotkeys = app.state::<NativeHotkeys>();
            let generation = {
                let mut registry = hotkeys.registry.lock().map_err(|e| e.to_string())?;
                if let Some((_, previous)) = registry.pending.remove(webview.label()) {
                    let _ = previous.try_send(Err("Hotkey synchronization superseded".into()));
                }
                registry.generation += 1;
                let generation = registry.generation;
                registry.snapshots.insert(webview.label().into(), (generation, snapshot.clone()));
                registry.pending.insert(webview.label().into(), (generation, sender.clone()));
                generation
            };
            hotkeys.menu_dirty.store(true, Ordering::Release);
            crate::update_workspace_menu_state_on_main(&app);
            // The pinned Tauri version has no eval callback. The owned script
            // explicitly acknowledges installation through one narrow command.
            let script = format!("if (window.top === window && window.__CODENOMAD_SET_NATIVE_HOTKEYS__?.({}, {}) === true) window.__TAURI_INTERNALS__.invoke('native_hotkeys_ready', {{generation:{}}}).catch(() => {{}})", serde_json::to_string(&snapshot).map_err(|e| e.to_string())?, generation, generation);
            webview.eval(script).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = result { let _ = sender.send(Err(error)); }
    }).map_err(|e| e.to_string())?;
    // Ack includes native suppression and actual top-frame map installation.
    tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) fn native_hotkeys_ready(webview: Webview, generation: u64) -> Result<(), String> {
    require_owner(&webview)?;
    let app = webview.app_handle();
    let hotkeys = app.state::<NativeHotkeys>();
    let mut registry = hotkeys.registry.lock().map_err(|e| e.to_string())?;
    if registry.snapshots.get(webview.label()).map(|entry| entry.0) != Some(generation)
        || registry.pending.get(webview.label()).map(|entry| entry.0) != Some(generation)
    {
        return Err("Hotkey synchronization is no longer current".into());
    }
    if let Some((_, sender)) = registry.pending.remove(webview.label()) {
        sender.try_send(Ok(())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn native_hotkey_action(
    webview: Webview,
    action: Action,
    generation: u64,
) -> Result<(), String> {
    let url = require_owner(&webview)?;
    let app = webview.app_handle().clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.clone()
        .run_on_main_thread(move || {
            let result = (|| {
                if require_owner(&webview)? != url
                    || !app
                        .state::<NativeHotkeys>()
                        .registry
                        .lock()
                        .map_err(|e| e.to_string())?
                        .allows(webview.label(), generation, action)
                {
                    return Err("Native hotkey action is inactive or renderer changed".into());
                }
                dispatch(&app, &webview, action)
            })();
            let _ = sender.send(result);
        })
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
}

fn dispatch(app: &AppHandle, webview: &Webview, action: Action) -> Result<(), String> {
    if webview.label().starts_with("remote-")
        && matches!(action, Action::WindowNew | Action::AppQuit | Action::WindowHide | Action::WindowHideOthers) {
        return Err("Global application hotkeys require a local renderer or Preferences".into());
    }
    let window = webview.window();
    match action {
        Action::WindowNew => {
            crate::local_windows::create_new_window(app)?;
        }
        Action::WindowReload | Action::WindowForceReload => {
            crate::reload_owned_window(app, webview, action == Action::WindowForceReload)
        }
        Action::WindowDevtools => {
            if webview.is_devtools_open() {
                webview.close_devtools();
            } else {
                webview.open_devtools();
            }
        }
        Action::WindowZoomIn | Action::WindowZoomOut | Action::WindowZoomReset => {
            let zoom = match action {
                Action::WindowZoomIn => crate::target_zoom(app, webview) + crate::ZOOM_STEP,
                Action::WindowZoomOut => crate::target_zoom(app, webview) - crate::ZOOM_STEP,
                _ => 1.0,
            };
            crate::set_target_zoom(app, webview, zoom);
        }
        Action::WindowFullscreen => {
            window
                .set_fullscreen(!window.is_fullscreen().map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if cfg!(not(target_os = "macos")) {
                let _ = window.hide_menu();
            }
        }
        Action::WindowMinimize => window.minimize().map_err(|e| e.to_string())?,
        Action::WindowHide | Action::WindowHideOthers => hide_application(app, action)?,
        Action::WindowClose => {
            // A keyboard request is not approval to discard Preferences drafts.
            // Its ordinary CloseRequested guard must still ask the renderer.
            window.close().map_err(|e| e.to_string())?;
        }
        Action::AppQuit => crate::shutdown::request(app.clone()),
        Action::NewInstance | Action::OpenCommandPalette => {
            return Err("This hotkey is renderer-owned".into())
        }
    }
    Ok(())
}

pub(crate) fn hide_application(app: &AppHandle, action: Action) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    match action {
        Action::WindowHide => return app.hide().map_err(|e| e.to_string()),
        Action::WindowHideOthers => { macos::hide_others(); return Ok(()); }
        _ => {}
    }
    let _ = (app, action);
    Err("Application hiding is available only on macOS".into())
}

#[cfg(target_os = "macos")]
#[path = "native_hotkeys_macos.rs"]
mod macos;

#[cfg(test)]
#[path = "native_hotkeys_tests.rs"]
mod tests;
