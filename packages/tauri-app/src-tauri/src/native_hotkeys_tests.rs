use super::*;

fn snapshot() -> serde_json::Value {
    let bindings: serde_json::Map<_, _> = ACTIONS
        .into_iter()
        .map(|action| {
            (
                serde_json::to_value(action)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .into(),
                serde_json::json!([]),
            )
        })
        .collect();
    serde_json::json!({"version":1,"recording":false,"bindings":bindings})
}

#[test]
fn protocol_and_strict_bounded_validator() {
    let protocol: serde_json::Value = serde_json::from_str(include_str!(
        "../../../ui/src/lib/native/hotkeys-protocol.json"
    ))
    .unwrap();
    assert_eq!(protocol["version"], 1);
    assert_eq!(protocol["maxBindings"], 8);
    assert_eq!(protocol["maxKeyLength"], 40);
    assert_eq!(protocol["actions"], serde_json::to_value(ACTIONS).unwrap());
    let mut value = snapshot();
    assert!(serde_json::from_value::<Snapshot>(value.clone())
        .unwrap()
        .validate()
        .is_ok());
    value["bindings"]["window-new"] =
        serde_json::json!([{"key":"n","ctrl":true,"meta":false,"shift":false,"alt":true}]);
    let good = value.clone();
    for key in [
        "",
        "ctrl",
        "Control",
        "META",
        "altgraph",
        "shift",
        "alt",
        "unidentified",
        "dead",
        "process",
        "\u{0001}",
        "\u{007f}",
        "\u{0085}",
        &"x".repeat(41),
        &"🎉".repeat(21),
    ] {
        value["bindings"]["window-new"][0]["key"] = serde_json::json!(key);
        assert!(
            serde_json::from_value::<Snapshot>(value.clone()).is_err(),
            "{key:?}"
        );
    }
    for field in ["ctrl", "meta", "shift", "alt"] {
        let mut invalid = good.clone();
        invalid["bindings"]["window-new"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(serde_json::from_value::<Snapshot>(invalid).is_err());
        let mut invalid = good.clone();
        invalid["bindings"]["window-new"][0][field] = serde_json::json!(1);
        assert!(serde_json::from_value::<Snapshot>(invalid).is_err());
    }
    let mut invalid = good.clone();
    invalid["bindings"]["window-new"] =
        serde_json::json!(vec![good["bindings"]["window-new"][0].clone(); 9]);
    assert!(serde_json::from_value::<Snapshot>(invalid).is_err());
    let mut invalid = good.clone();
    invalid["extra"] = serde_json::json!(true);
    assert!(serde_json::from_value::<Snapshot>(invalid).is_err());
    let mut invalid = good.clone();
    invalid["bindings"]["unknown"] = serde_json::json!([]);
    assert!(serde_json::from_value::<Snapshot>(invalid).is_err());
    let mut invalid = good.clone();
    invalid["bindings"]["window-new"][0]["mod"] = serde_json::json!(true);
    assert!(serde_json::from_value::<Snapshot>(invalid).is_err());
    for action in ACTIONS {
        let mut invalid = good.clone();
        let id = serde_json::to_value(action).unwrap();
        invalid["bindings"].as_object_mut().unwrap().remove(id.as_str().unwrap());
        assert!(serde_json::from_value::<Snapshot>(invalid).is_err(), "{action:?}");
    }
    let mut invalid = good.clone();
    invalid.as_object_mut().unwrap().remove("recording");
    assert!(serde_json::from_value::<Snapshot>(invalid).is_err());
    let mut invalid = good;
    invalid["version"] = serde_json::json!(2);
    assert!(serde_json::from_value::<Snapshot>(invalid)
        .unwrap()
        .validate()
        .is_err());
    // Exact object schema also rejects duplicated action fields.
    let json = serde_json::to_string(&snapshot())
        .unwrap()
        .replace("\"bindings\":{", "\"bindings\":{\"window-new\":[],");
    assert!(serde_json::from_str::<Snapshot>(&json).is_err());
}

#[test]
fn recording_navigation_and_single_route_fence_actions() {
    let mut value = snapshot();
    value["bindings"]["window-fullscreen"] =
        serde_json::json!([{"key":"F11","ctrl":false,"meta":false,"shift":false,"alt":false}]);
    let mut registry = Registry::default();
    registry.snapshots.insert(
        "local".into(),
        (7, serde_json::from_value(value.clone()).unwrap()),
    );
    assert!(registry.allows("local", 7, Action::WindowFullscreen));
    assert!(!registry.allows("other", 7, Action::WindowFullscreen));
    assert!(!registry.allows("local", 6, Action::WindowFullscreen));
    assert!(!registry.allows("local", 7, Action::NewInstance));
    assert!(!registry.allows("local", 7, Action::OpenCommandPalette));
    registry.snapshots.insert(
        "other".into(),
        (8, serde_json::from_value(value.clone()).unwrap()),
    );
    value["recording"] = serde_json::json!(true);
    registry
        .snapshots
        .insert("local".into(), (7, serde_json::from_value(value).unwrap()));
    assert!(!registry.allows("local", 7, Action::WindowFullscreen));
    assert!(registry.allows("other", 8, Action::WindowFullscreen));
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    registry.pending.insert("local".into(), (7, sender));
    registry.clear("local");
    assert!(!registry.allows("local", 7, Action::WindowFullscreen));
    assert!(receiver.recv().unwrap().is_err());
    assert_eq!(
        ACTIONS.into_iter().filter(|action| action.native()).count(),
        ACTIONS.len() - 2
    );
    let hotkeys = NativeHotkeys::default();
    *hotkeys.registry.lock().unwrap() = registry;
    assert!(!hotkeys.menu_recording());
    let mut recording = snapshot();
    recording["recording"] = serde_json::json!(true);
    hotkeys.registry.lock().unwrap().snapshots.insert(
        "preferences".into(),
        (9, serde_json::from_value(recording).unwrap()),
    );
    assert!(hotkeys.menu_recording());
    hotkeys.remove("preferences");
    assert!(!hotkeys.menu_recording());
}

#[test]
fn hide_actions_require_global_authority_and_are_fenced_during_capture() {
    for action in [Action::WindowNew, Action::AppQuit, Action::WindowHide, Action::WindowHideOthers] {
        let mut value = snapshot();
        let id = serde_json::to_value(action).unwrap();
        value["bindings"][id.as_str().unwrap()] = serde_json::json!([{"key":"h","ctrl":false,"meta":true,"shift":false,"alt":false}]);
        let accepted: Snapshot = serde_json::from_value(value.clone()).unwrap();
        assert!(accepted.requires_global_authority());
        let mut registry = Registry::default();
        registry.snapshots.insert("local".into(), (7, accepted));
        assert!(registry.allows("local", 7, action));
        value["recording"] = serde_json::json!(true);
        registry.snapshots.insert("local".into(), (8, serde_json::from_value(value).unwrap()));
        assert!(!registry.allows("local", 7, action));
        assert!(!registry.allows("local", 8, action));
        let empty: Snapshot = serde_json::from_value(snapshot()).unwrap();
        assert!(!empty.requires_global_authority());
        registry.snapshots.insert("local".into(), (9, empty));
        assert!(!registry.allows("local", 9, action));
    }
    let macos = include_str!("native_hotkeys_macos.rs");
    assert!(macos.contains("hideOtherApplications:"));
    assert!(include_str!("native_hotkeys.rs").contains("app.hide()"));
}

fn pending_remote_recording(
    hotkeys: &NativeHotkeys,
    label: &str,
    snapshot_generation: u64,
) -> std::sync::mpsc::Receiver<Result<(), String>> {
    let mut value = snapshot();
    value["recording"] = serde_json::json!(true);
    value["bindings"]["window-fullscreen"] =
        serde_json::json!([{"key":"F11","ctrl":false,"meta":false,"shift":false,"alt":false}]);
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let mut registry = hotkeys.registry.lock().unwrap();
    registry.generation = snapshot_generation;
    registry.snapshots.insert(
        label.into(),
        (snapshot_generation, serde_json::from_value(value).unwrap()),
    );
    registry
        .pending
        .insert(label.into(), (snapshot_generation, sender));
    drop(registry);
    #[cfg(windows)]
    assert!(hotkeys.mark_browser_keys_unavailable(label));
    receiver
}

#[test]
fn remote_close_reopen_removes_capture_ack_page_and_browser_capability() {
    let hotkeys = NativeHotkeys::default();
    let label = "remote-profile";
    hotkeys.prepare_remote_window(label, 2);
    // Navigation and accepted snapshots advance independently of window identity.
    hotkeys.clear_remote_page(label, 2);
    let receiver = pending_remote_recording(&hotkeys, label, 700);
    assert!(hotkeys.menu_recording());
    hotkeys.take_menu_dirty();
    assert!(hotkeys.remove_remote_window(label, 2));
    assert!(hotkeys.take_menu_dirty());
    assert!(!hotkeys.menu_recording());
    assert!(receiver.recv().unwrap().is_err());
    assert_eq!(hotkeys.page(label), 0);
    {
        let registry = hotkeys.registry.lock().unwrap();
        assert!(!registry.snapshots.contains_key(label));
        assert!(!registry.pending.contains_key(label));
        assert!(!registry.remote_windows.contains_key(label));
    }
    #[cfg(windows)]
    assert!(!hotkeys.browser_keys_unavailable(label));

    hotkeys.prepare_remote_window(label, 3);
    assert!(hotkeys.page(label) > 700);
    assert!(!hotkeys.menu_recording());
    #[cfg(windows)]
    assert!(!hotkeys.browser_keys_unavailable(label));
}

#[test]
fn stale_remote_destroy_and_navigation_preserve_replacement_capture_and_ack() {
    let hotkeys = NativeHotkeys::default();
    let label = "remote-profile";
    hotkeys.prepare_remote_window(label, 2);
    let old_receiver = pending_remote_recording(&hotkeys, label, 700);
    hotkeys.prepare_remote_window(label, 3);
    assert!(old_receiver.recv().unwrap().is_err());
    #[cfg(windows)]
    assert!(!hotkeys.browser_keys_unavailable(label));
    let receiver = pending_remote_recording(&hotkeys, label, 900);
    let page = hotkeys.page(label);
    hotkeys.take_menu_dirty();
    assert!(!hotkeys.remove_remote_window(label, 2));
    hotkeys.clear_remote_page(label, 2);
    assert!(!hotkeys.take_menu_dirty());
    assert!(hotkeys.menu_recording());
    assert_eq!(hotkeys.page(label), page);
    assert!(matches!(
        receiver.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    {
        let registry = hotkeys.registry.lock().unwrap();
        assert_eq!(registry.remote_windows.get(label), Some(&3));
        assert_eq!(registry.snapshots.get(label).unwrap().0, 900);
        assert_eq!(registry.pending.get(label).unwrap().0, 900);
    }
    #[cfg(windows)]
    assert!(hotkeys.browser_keys_unavailable(label));
    assert!(hotkeys.remove_remote_window(label, 3));
    assert!(receiver.recv().unwrap().is_err());
    assert!(!hotkeys.menu_recording());
}

#[test]
fn remote_hotkey_lifetime_is_bound_before_fallible_setup_and_failure_cleanup() {
    let source: String = include_str!("main.rs")
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    let factory = source
        .split("fnopen_remote_window_locked(").nth(1).unwrap()
        .split("fnset_remote_window_metadata(").next().unwrap();
    assert!(factory.contains(".prepare_remote_window(&label,window_generation)"));
    assert!(factory.contains(".clear_remote_page(window.label(),window_generation)"));
    assert!(
        factory.find("window.on_window_event").unwrap()
            < factory.find("shutdown::schedule_windows_session_end_handler").unwrap()
    );
    assert!(factory.contains("remove_remote_window_hotkeys(&app_handle,&label_for_cleanup,window_generation)"));
    let failed = source
        .split("fncleanup_failed_remote_window(").nth(1).unwrap()
        .split("fnremove_remote_window_hotkeys(").next().unwrap();
    assert!(failed.contains("remove_remote_window_hotkeys(app,label,window_generation)"));
}

#[test]
fn hotkeys_reuse_the_existing_caller_window_zoom_authority() {
    // The shared zoom module's owner tests cover registered local, Preferences,
    // remote-origin and guest fences. Native hotkeys consume that same guard.
    let source = include_str!("native_hotkeys.rs");
    assert!(source.contains("crate::window_zoom::require_owned_webview(webview, webview.app_handle())"));
    assert!(source.contains("Global application hotkeys require a local renderer or Preferences"));
}

#[test]
fn generated_acl_grants_owned_roots_but_never_preview_or_extension_webviews() {
    use std::collections::BTreeMap;
    use tauri::utils::acl::{capability::Capability, manifest::Manifest, resolved::Resolved};
    let manifests: BTreeMap<String, Manifest> =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let capabilities: BTreeMap<String, Capability> =
        serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
    let resolved = Resolved::resolve(
        &manifests,
        capabilities,
        tauri::utils::platform::Target::current(),
    )
    .unwrap();
    let authority = tauri::runtime_authority!(manifests, resolved);
    let origin = tauri::ipc::Origin::Remote {
        url: "http://127.0.0.1:32123/app".parse().unwrap(),
    };
    for command in [
        "set_native_hotkeys",
        "native_hotkey_action",
        "native_hotkeys_ready",
    ] {
        for label in ["local-11111111-1111-4111-8111-111111111111", "preferences", "remote-profile"] {
            assert!(authority
                .resolve_access(command, label, label, &origin)
                .is_some());
            assert!(authority
                .resolve_access(command, label, "browser-preview", &origin)
                .is_none());
            assert!(authority
                .resolve_access(command, label, "panel-extension", &origin)
                .is_none());
        }
        assert!(authority
            .resolve_access(command, "remote-profile", "remote-profile", &origin)
            .is_some());
        assert!(authority
            .resolve_access(command, "unknown", "unknown", &origin)
            .is_none());
    }
}
