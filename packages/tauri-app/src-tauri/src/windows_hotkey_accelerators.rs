//! Targeted browser zoom policy, independent of the existing F6 crash workaround.
//! Args2 disables browser actions without marking input handled: DOM still gets
//! Ctrl +/-/0, even when unassigned or being recorded. Wheel zoom stays native.
use tauri::{Emitter, Manager};
use webview2_com::{AcceleratorKeyPressedEventHandler, Microsoft::Web::WebView2::Win32::*};
use windows_core::Interface;

#[link(name = "user32")]
extern "system" {
    fn GetKeyState(key: i32) -> i16;
}

fn suppress_browser_zoom(
    key: u32,
    kind: COREWEBVIEW2_KEY_EVENT_KIND,
    ctrl: bool,
    alt: bool,
    meta: bool,
) -> bool {
    ctrl && !alt
        && !meta
        && matches!(key, 0x30 | 0x60 | 0x6b | 0x6d | 0xbb | 0xbd)
        && matches!(
            kind,
            COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN | COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
        )
}

pub(crate) fn bind(webview: &tauri::Webview) {
    if webview.label() != webview.window().label()
        || (crate::identity::local_window_id(webview.label()).is_err()
            && webview.label() != crate::preferences_window::LABEL
            && !webview.label().starts_with("remote-"))
    {
        return;
    }
    // Explicit local/Preferences and registered remote builders only, never
    // preview paths. A Weak app avoids retaining a COM/application cycle.
    let weak_app = webview
        .app_handle()
        .state::<crate::native_hotkeys::NativeHotkeys>()
        .host
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let label = webview.label().to_string();
    let outer_host = weak_app.clone();
    let outer_label = label.clone();
    let result = webview.with_webview(move |platform| {
        let install_host = weak_app.clone();
        let install_label = label.clone();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            unsafe {
                let mut key = 0;
                let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
                args.VirtualKey(&mut key)?;
                args.KeyEventKind(&mut kind)?;
                if suppress_browser_zoom(
                    key,
                    kind,
                    GetKeyState(0x11) < 0,
                    GetKeyState(0x12) < 0,
                    GetKeyState(0x5b) < 0 || GetKeyState(0x5c) < 0,
                ) {
                    if let Ok(args2) = args.cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>() {
                        if args2.SetIsBrowserAcceleratorKeyEnabled(false).is_err() {
                            args.SetHandled(true)?;
                            report_unavailable(&weak_app, &label);
                        }
                    } else {
                        // Fail closed for these keys only, never mass-disable
                        // browser shortcuts. Older hosts cannot deliver capture
                        // keys safely; publish the actual capability failure.
                        args.SetHandled(true)?;
                        report_unavailable(&weak_app, &label);
                    }
                }
            }
            Ok(())
        }));
        let mut token = 0;
        if let Err(error) = unsafe {
            platform
                .controller()
                .add_AcceleratorKeyPressed(&handler, &mut token)
        } {
            eprintln!("[native-hotkeys] failed to install browser zoom policy: {error}");
            report_unavailable(&install_host, &install_label);
        }
    });
    if let Err(error) = result {
        eprintln!("[native-hotkeys] failed to access WebView2: {error}");
        report_unavailable(&outer_host, &outer_label);
    }
}

fn report_unavailable(host: &std::sync::Weak<tauri::AppHandle>, label: &str) {
    if let Some(app) = host.upgrade() {
        if app
            .state::<crate::native_hotkeys::NativeHotkeys>()
            .mark_browser_keys_unavailable(label)
        {
            eprintln!("[native-hotkeys] WebView2 cannot safely deliver Ctrl +/-/0; per-key browser control is unavailable");
            let page = app.state::<crate::native_hotkeys::NativeHotkeys>().page(label);
            let label = label.to_string();
            let host = host.clone();
            // Never evaluate/emit renderer scripts in an input/COM callback.
            // The existing Tao input backport deliberately avoids such pumping.
            tauri::async_runtime::spawn(async move {
                if let Some(app) = host.upgrade() {
                    let state = app.state::<crate::native_hotkeys::NativeHotkeys>();
                    if state.page(&label) == page && state.browser_keys_unavailable(&label) {
                        let _ = app.emit_to(&label, "native-hotkeys:unavailable", "browser-zoom-key-delivery");
                    }
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_ctrl_zoom_keydowns_suppress_browser_actions() {
        for key in 0..=255 {
            for kind in [
                COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
                COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
                COREWEBVIEW2_KEY_EVENT_KIND_KEY_UP,
                COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_UP,
            ] {
                assert_eq!(
                    suppress_browser_zoom(key, kind, true, false, false),
                    matches!(key, 0x30 | 0x60 | 0x6b | 0x6d | 0xbb | 0xbd)
                        && matches!(
                            kind,
                            COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                                | COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
                        )
                );
                for modifiers in [
                    (false, false, false),
                    (true, true, false),
                    (true, false, true),
                ] {
                    assert!(!suppress_browser_zoom(
                        key,
                        kind,
                        modifiers.0,
                        modifiers.1,
                        modifiers.2
                    ));
                }
            }
        }
    }
}
