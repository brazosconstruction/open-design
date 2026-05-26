use launcher_lifecycle::{
    ConfigSearch, ConfigSource, LAUNCHER_CONFIG_FILE, LauncherLifecycleError,
    RuntimeSelectionSlot, build_process_spec, build_runtime_plan, resolve_config_with_args,
    resolve_launcher_config,
};
use launcher_proto::RuntimeApp;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn temp_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "open-design-launcher-lifecycle-test-{}-{}",
        name,
        std::process::id()
    ))
}

fn write_config(root: &Path, executable: &str) {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        format!(
            r#"{{
  "schemaVersion": 1,
  "payloadRoot": "versions/0.8.0/payload",
  "entry": {{
    "executable": "{executable}",
    "args": ["--from-config"],
    "cwd": "versions/0.8.0/payload",
    "env": {{"OD_TEST": "1"}}
  }}
}}"#
        ),
    )
    .unwrap();
}

fn touch_file(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "").unwrap();
}

fn json_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn assert_no_curdir(path: &Path) {
    let display = path.display().to_string().replace('/', "\\");
    assert!(
        !path.components().any(|component| component == Component::CurDir),
        "path should not contain a current-directory component: {}",
        path.display()
    );
    assert!(
        !display.contains("\\.\\") && !display.ends_with("\\."),
        "path display should not contain a current-directory segment: {}",
        path.display()
    );
}

fn create_runtime_version(root: &Path, version: &str) {
    let payload = root
        .join("namespaces/release-beta-win/versions")
        .join(version)
        .join("payload");
    touch_file(&payload.join("Open Design Payload.exe"));
    touch_file(&payload.join("daemon.exe"));
    touch_file(&payload.join("web.exe"));
}

fn write_runtime_config(root: &Path) {
    write_runtime_config_opts(root, false);
}

fn write_runtime_config_opts(root: &Path, duplicate_endpoint: bool) {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "runtimePath": "runtime.json"
}"#,
    )
    .unwrap();
    let web_endpoint = if duplicate_endpoint {
        "tcp://127.0.0.1:17401"
    } else {
        "tcp://127.0.0.1:17402"
    };
    fs::write(
        root.join("runtime.json"),
        format!(
            r#"{{
  "schemaVersion": 1,
  "generation": 12,
  "namespace": "release-beta-win",
  "namespaceRoot": "namespaces/release-beta-win",
  "active": {{
    "version": "0.8.1",
    "root": "namespaces/release-beta-win/versions/0.8.1",
    "entry": {{"executable": "payload/Open Design Payload.exe"}},
    "apps": {{
      "daemon": {{
        "endpoint": "tcp://127.0.0.1:17401",
        "entry": {{
          "executable": "payload/daemon.exe",
          "args": ["--serve"],
          "env": {{"OD_PORT": "17456"}}
        }}
      }},
      "web": {{
        "endpoint": "{web_endpoint}",
        "entry": {{
          "executable": "payload/web.exe",
          "env": {{"OD_WEB_PORT": "17573"}}
        }}
      }}
    }}
  }},
  "lastSuccessful": {{
    "version": "0.8.0",
    "root": "namespaces/release-beta-win/versions/0.8.0",
    "entry": {{"executable": "payload/Open Design Payload.exe"}},
    "apps": {{
      "daemon": {{
        "endpoint": "tcp://127.0.0.1:17401",
        "entry": {{"executable": "payload/daemon.exe"}}
      }}
    }}
  }}
}}"#
        ),
    )
    .unwrap();
}

fn write_attempt(root: &Path) {
    let attempt_path = root.join("namespaces/release-beta-win/state/attempt.json");
    fs::create_dir_all(attempt_path.parent().unwrap()).unwrap();
    fs::write(
        attempt_path,
        r#"{
  "schemaVersion": 1,
  "generation": 12,
  "version": "0.8.1"
}"#,
    )
    .unwrap();
}

fn write_tools_pack_attempt(root: &Path, generation: u64, version: &str) {
    let attempt_path = root.join("state/attempt.json");
    fs::create_dir_all(attempt_path.parent().unwrap()).unwrap();
    fs::write(
        attempt_path,
        format!(
            r#"{{
  "schemaVersion": 1,
  "generation": {generation},
  "version": "{version}"
}}"#
        ),
    )
    .unwrap();
}

fn write_tools_pack_install_root_config(root: &Path) {
    write_tools_pack_install_root_runtime_config(root, "0.8.0-beta.2", "0.8.0-beta.2", 0);
}

fn write_tools_pack_install_root_runtime_config(
    root: &Path,
    active_version: &str,
    last_successful_version: &str,
    generation: u64,
) {
    write_tools_pack_install_root_runtime_config_with_paths(
        root,
        active_version,
        last_successful_version,
        generation,
        &format!("versions/{active_version}"),
        "payload/Open Design.exe",
        "payload",
        &format!("versions/{last_successful_version}"),
        "payload/Open Design.exe",
        "payload",
    );
}

#[allow(clippy::too_many_arguments)]
fn write_tools_pack_install_root_runtime_config_with_paths(
    root: &Path,
    active_version: &str,
    last_successful_version: &str,
    generation: u64,
    active_root: &str,
    active_executable: &str,
    active_cwd: &str,
    last_successful_root: &str,
    last_successful_executable: &str,
    last_successful_cwd: &str,
) {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "runtimePath": "runtime.json",
  "attemptPath": "state/attempt.json"
}"#,
    )
    .unwrap();
    let active_root = json_string(active_root);
    let active_executable = json_string(active_executable);
    let active_cwd = json_string(active_cwd);
    let last_successful_root = json_string(last_successful_root);
    let last_successful_executable = json_string(last_successful_executable);
    let last_successful_cwd = json_string(last_successful_cwd);
    fs::write(
        root.join("runtime.json"),
        format!(
            r#"{{
  "schemaVersion": 1,
  "generation": {generation},
  "namespace": "release-beta-win",
  "namespaceRoot": ".",
  "active": {{
    "version": "{active_version}",
    "root": {active_root},
    "entry": {{
      "executable": {active_executable},
      "args": [],
      "cwd": {active_cwd},
      "env": {{}}
    }},
    "apps": {{}}
  }},
  "lastSuccessful": {{
    "version": "{last_successful_version}",
    "root": {last_successful_root},
    "entry": {{
      "executable": {last_successful_executable},
      "args": [],
      "cwd": {last_successful_cwd},
      "env": {{}}
    }},
    "apps": {{}}
  }}
}}"#
        ),
    )
    .unwrap();
}

fn search(root: &Path) -> ConfigSearch {
    ConfigSearch {
        cwd: root.join("cwd"),
        env_root: None,
        exe_path: root.join("bin").join("open-design-launcher.exe"),
        explicit_root: None,
    }
}

#[test]
fn explicit_root_wins() {
    let root = temp_root("explicit-root");
    let explicit = root.join("explicit");
    let cwd = root.join("cwd");
    write_config(&explicit, "explicit.exe");
    write_config(&cwd, "cwd.exe");
    let mut search = search(&root);
    search.explicit_root = Some(explicit.clone());
    search.cwd = cwd;

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.source, ConfigSource::ExplicitRoot);
    assert_eq!(resolved.config_root, explicit);
    assert_eq!(
        resolved.process.executable,
        root.join("explicit").join("explicit.exe")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn env_root_wins() {
    let root = temp_root("env-root");
    let env_root = root.join("env");
    let cwd = root.join("cwd");
    write_config(&env_root, "env.exe");
    write_config(&cwd, "cwd.exe");
    let mut search = search(&root);
    search.env_root = Some(env_root.clone());
    search.cwd = cwd;

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.source, ConfigSource::EnvironmentRoot);
    assert_eq!(resolved.config_root, env_root);
    assert_eq!(resolved.process.executable, root.join("env").join("env.exe"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn exe_dir_fallback() {
    let root = temp_root("exe-dir");
    let exe_dir = root.join("bin");
    write_config(&exe_dir, "payload.exe");
    let search = search(&root);

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.source, ConfigSource::LauncherDirectory);
    assert_eq!(resolved.config_root, exe_dir);
    assert_eq!(
        resolved.process.executable,
        root.join("bin").join("payload.exe")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn explicit_missing_hard_fails() {
    let root = temp_root("missing-explicit");
    let cwd = root.join("cwd");
    write_config(&cwd, "cwd.exe");
    let mut search = search(&root);
    search.cwd = cwd;
    search.explicit_root = Some(root.join("missing"));

    assert!(matches!(
        resolve_launcher_config(&search),
        Err(LauncherLifecycleError::ForcedConfigMissing { origin: "flag", .. })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn relative_root_anchors() {
    let root = temp_root("relative-root");
    let cwd = root.join("cwd");
    let config_root = cwd.join("launcher-root");
    write_config(&config_root, "payload.exe");
    let mut search = search(&root);
    search.cwd = cwd.clone();
    search.explicit_root = Some(PathBuf::from("launcher-root"));

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.config_root, config_root);
    assert_eq!(
        resolved.process.executable,
        cwd.join("launcher-root").join("payload.exe")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn paths_anchor_to_config() {
    let root = temp_root("relative-paths");
    let config_root = root.join("config");
    write_config(&config_root, "versions/0.8.0/payload/Open Design.exe");
    let mut search = search(&root);
    search.explicit_root = Some(config_root.clone());
    let forwarded = vec!["od://project/1".to_owned(), "--safe-mode".to_owned()];

    let resolved = resolve_config_with_args(&search, &forwarded).unwrap();

    assert_eq!(
        resolved.payload_root,
        config_root.join("versions/0.8.0/payload")
    );
    assert_eq!(
        resolved.process.executable,
        config_root.join("versions/0.8.0/payload/Open Design.exe")
    );
    assert_eq!(
        resolved.process.cwd,
        config_root.join("versions/0.8.0/payload")
    );
    assert_eq!(
        resolved.process.args,
        vec!["--from-config", "od://project/1", "--safe-mode"]
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn tools_pack_install_root_runtime_selects_versioned_payload() {
    let root = temp_root("tools-pack-install-root-runtime");
    write_tools_pack_install_root_config(&root);
    let version_root = root.join("versions/0.8.0-beta.2");
    let payload_root = version_root.join("payload");
    touch_file(&payload_root.join("Open Design.exe"));
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());
    let forwarded = vec!["od://project/1".to_owned(), "--safe-mode".to_owned()];

    let resolved = resolve_config_with_args(&search, &forwarded).unwrap();
    let runtime = resolved.runtime_launch.as_ref().unwrap();

    assert_eq!(resolved.source, ConfigSource::ExplicitRoot);
    assert_eq!(runtime.config.namespace_root, ".");
    assert_eq!(runtime.attempt_path, root.join("state/attempt.json"));
    assert_eq!(runtime.selected_slot, RuntimeSelectionSlot::Active);
    assert_eq!(runtime.selected_version.version, "0.8.0-beta.2");
    assert_eq!(runtime.selected_root, version_root);
    assert_eq!(resolved.payload_root, version_root);
    assert_eq!(
        resolved.process.executable,
        payload_root.join("Open Design.exe")
    );
    assert_eq!(resolved.process.cwd, payload_root);
    assert_eq!(
        resolved.process.args,
        vec!["od://project/1", "--safe-mode"]
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn tools_pack_install_root_runtime_plan_allows_payload_without_apps() {
    let root = temp_root("tools-pack-install-root-runtime-plan");
    write_tools_pack_install_root_config(&root);
    let version_root = root.join("versions/0.8.0-beta.2");
    let payload_root = version_root.join("payload");
    touch_file(&payload_root.join("Open Design.exe"));
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());
    let resolved = resolve_config_with_args(&search, &[]).unwrap();

    let plan = build_runtime_plan(&resolved).unwrap();

    assert_eq!(plan.namespace.as_str(), "release-beta-win");
    assert_eq!(plan.selected_slot, RuntimeSelectionSlot::Active);
    assert_eq!(plan.selected_version, "0.8.0-beta.2");
    assert_eq!(plan.namespace_root, root);
    assert_eq!(plan.runtime_root, root.join("runtime"));
    assert_eq!(plan.logs_root, root.join("logs"));
    assert_eq!(plan.cache_root, root.join("cache"));
    assert_eq!(plan.state_root, root.join("state"));
    assert_eq!(plan.versions_root, root.join("versions"));
    assert_eq!(plan.selected_root, version_root);
    assert_no_curdir(&plan.namespace_root);
    assert_no_curdir(&plan.runtime_root);
    assert_no_curdir(&plan.logs_root);
    assert_no_curdir(&plan.cache_root);
    assert_no_curdir(&plan.state_root);
    assert_no_curdir(&plan.versions_root);
    assert_eq!(plan.payload_process.executable, payload_root.join("Open Design.exe"));
    assert_eq!(plan.payload_process.cwd, payload_root);
    assert_eq!(plan.payload_process.args, Vec::<String>::new());
    assert_eq!(plan.apps, Vec::new());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn tools_pack_install_root_attempted_active_falls_back_to_last_successful() {
    let root = temp_root("tools-pack-install-root-attempted");
    write_tools_pack_install_root_runtime_config(&root, "0.8.0-beta.3", "0.8.0-beta.2", 7);
    let active_payload = root.join("versions/0.8.0-beta.3/payload");
    let last_successful_payload = root.join("versions/0.8.0-beta.2/payload");
    touch_file(&active_payload.join("Open Design.exe"));
    touch_file(&last_successful_payload.join("Open Design.exe"));
    write_tools_pack_attempt(&root, 7, "0.8.0-beta.3");
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    let resolved = resolve_config_with_args(&search, &[]).unwrap();
    let runtime = resolved.runtime_launch.as_ref().unwrap();

    assert_eq!(runtime.attempt_path, root.join("state/attempt.json"));
    assert_eq!(runtime.selected_slot, RuntimeSelectionSlot::LastSuccessful);
    assert_eq!(runtime.selected_version.version, "0.8.0-beta.2");
    assert_eq!(runtime.selected_root, root.join("versions/0.8.0-beta.2"));
    assert_eq!(
        runtime.active_error.as_deref(),
        Some("active generation already attempted without health confirmation")
    );
    assert_eq!(
        resolved.process.executable,
        last_successful_payload.join("Open Design.exe")
    );
    assert_eq!(resolved.process.cwd, last_successful_payload);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn tools_pack_install_root_active_absolute_root_falls_back_to_last_successful() {
    let root = temp_root("tools-pack-install-root-active-absolute-root");
    let outside_active_root = root.join("outside-active");
    let outside_active_root_value = outside_active_root.to_string_lossy().into_owned();
    write_tools_pack_install_root_runtime_config_with_paths(
        &root,
        "0.8.0-beta.3",
        "0.8.0-beta.2",
        8,
        &outside_active_root_value,
        "payload/Open Design.exe",
        "payload",
        "versions/0.8.0-beta.2",
        "payload/Open Design.exe",
        "payload",
    );
    touch_file(&outside_active_root.join("payload/Open Design.exe"));
    let last_successful_payload = root.join("versions/0.8.0-beta.2/payload");
    touch_file(&last_successful_payload.join("Open Design.exe"));
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    let resolved = resolve_config_with_args(&search, &[]).unwrap();
    let runtime = resolved.runtime_launch.as_ref().unwrap();

    assert_eq!(runtime.selected_slot, RuntimeSelectionSlot::LastSuccessful);
    assert_eq!(runtime.selected_version.version, "0.8.0-beta.2");
    assert!(
        runtime
            .active_error
            .as_deref()
            .unwrap()
            .contains("root must be a clean relative path under")
    );
    assert_eq!(
        resolved.process.executable,
        last_successful_payload.join("Open Design.exe")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn tools_pack_install_root_active_cwd_escape_falls_back_to_last_successful() {
    let root = temp_root("tools-pack-install-root-active-cwd-escape");
    write_tools_pack_install_root_runtime_config_with_paths(
        &root,
        "0.8.0-beta.3",
        "0.8.0-beta.2",
        8,
        "versions/0.8.0-beta.3",
        "payload/Open Design.exe",
        "../outside",
        "versions/0.8.0-beta.2",
        "payload/Open Design.exe",
        "payload",
    );
    let active_payload = root.join("versions/0.8.0-beta.3/payload");
    let last_successful_payload = root.join("versions/0.8.0-beta.2/payload");
    touch_file(&active_payload.join("Open Design.exe"));
    fs::create_dir_all(root.join("versions/outside")).unwrap();
    touch_file(&last_successful_payload.join("Open Design.exe"));
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    let resolved = resolve_config_with_args(&search, &[]).unwrap();
    let runtime = resolved.runtime_launch.as_ref().unwrap();

    assert_eq!(runtime.selected_slot, RuntimeSelectionSlot::LastSuccessful);
    assert_eq!(runtime.selected_version.version, "0.8.0-beta.2");
    assert!(
        runtime
            .active_error
            .as_deref()
            .unwrap()
            .contains("cwd must be a clean relative path under")
    );
    assert_eq!(resolved.process.cwd, last_successful_payload);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn tools_pack_install_root_active_cwd_parent_segment_falls_back_to_last_successful() {
    let root = temp_root("tools-pack-install-root-active-cwd-parent-segment");
    write_tools_pack_install_root_runtime_config_with_paths(
        &root,
        "0.8.0-beta.3",
        "0.8.0-beta.2",
        8,
        "versions/0.8.0-beta.3",
        "payload/Open Design.exe",
        "payload/../payload",
        "versions/0.8.0-beta.2",
        "payload/Open Design.exe",
        "payload",
    );
    let active_payload = root.join("versions/0.8.0-beta.3/payload");
    let last_successful_payload = root.join("versions/0.8.0-beta.2/payload");
    touch_file(&active_payload.join("Open Design.exe"));
    touch_file(&last_successful_payload.join("Open Design.exe"));
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    let resolved = resolve_config_with_args(&search, &[]).unwrap();
    let runtime = resolved.runtime_launch.as_ref().unwrap();

    assert_eq!(runtime.selected_slot, RuntimeSelectionSlot::LastSuccessful);
    assert_eq!(runtime.selected_version.version, "0.8.0-beta.2");
    assert!(
        runtime
            .active_error
            .as_deref()
            .unwrap()
            .contains("cwd must be a clean relative path under")
    );
    assert_eq!(resolved.process.cwd, last_successful_payload);

    let _ = fs::remove_dir_all(root);
}

#[test]
fn tools_pack_install_root_last_successful_absolute_executable_fails() {
    let root = temp_root("tools-pack-install-root-last-absolute-executable");
    let outside_executable = root.join("outside/Open Design.exe");
    let outside_executable_value = outside_executable.to_string_lossy().into_owned();
    write_tools_pack_install_root_runtime_config_with_paths(
        &root,
        "0.8.0-beta.3",
        "0.8.0-beta.2",
        8,
        "versions/0.8.0-beta.3",
        "payload/Open Design.exe",
        "payload",
        "versions/0.8.0-beta.2",
        &outside_executable_value,
        "payload",
    );
    touch_file(&outside_executable);
    touch_file(&root.join("versions/0.8.0-beta.2/payload/placeholder"));
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    let result = resolve_config_with_args(&search, &[]);

    match result {
        Err(LauncherLifecycleError::LastSuccessfulInvalid(message)) => {
            assert!(message.contains("executable must be a clean relative path under"));
        }
        other => panic!("expected invalid lastSuccessful executable, got {other:?}"),
    }

    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_path_escape_fails_before_loading_external_descriptor() {
    let root = temp_root("runtime-path-escape");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "runtimePath": "../runtime.json"
}"#,
    )
    .unwrap();
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    assert!(matches!(
        resolve_config_with_args(&search, &[]),
        Err(LauncherLifecycleError::InvalidConfigRelativePath {
            field: "runtimePath",
            ..
        })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_path_parent_segment_fails() {
    let root = temp_root("runtime-path-parent-segment");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "runtimePath": "config/../runtime.json"
}"#,
    )
    .unwrap();
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    assert!(matches!(
        resolve_config_with_args(&search, &[]),
        Err(LauncherLifecycleError::InvalidConfigRelativePath {
            field: "runtimePath",
            ..
        })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_path_empty_segment_fails() {
    let root = temp_root("runtime-path-empty-segment");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "runtimePath": "config//runtime.json"
}"#,
    )
    .unwrap();
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    assert!(matches!(
        resolve_config_with_args(&search, &[]),
        Err(LauncherLifecycleError::InvalidConfigRelativePath {
            field: "runtimePath",
            ..
        })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn attempt_path_escape_fails_before_attempt_write() {
    let root = temp_root("attempt-path-escape");
    write_tools_pack_install_root_runtime_config(&root, "0.8.0-beta.2", "0.8.0-beta.2", 0);
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "runtimePath": "runtime.json",
  "attemptPath": "../attempt.json"
}"#,
    )
    .unwrap();
    touch_file(&root.join("versions/0.8.0-beta.2/payload/Open Design.exe"));
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    assert!(matches!(
        resolve_config_with_args(&search, &[]),
        Err(LauncherLifecycleError::InvalidConfigRelativePath {
            field: "attemptPath",
            ..
        })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn runtime_namespace_root_escape_fails() {
    let root = temp_root("runtime-namespace-root-escape");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "runtimePath": "runtime.json"
}"#,
    )
    .unwrap();
    fs::write(
        root.join("runtime.json"),
        r#"{
  "schemaVersion": 1,
  "generation": 0,
  "namespace": "release-beta-win",
  "namespaceRoot": "../outside",
  "active": {
    "version": "0.8.0-beta.2",
    "root": "versions/0.8.0-beta.2",
    "entry": {"executable": "payload/Open Design.exe"},
    "apps": {}
  },
  "lastSuccessful": {
    "version": "0.8.0-beta.2",
    "root": "versions/0.8.0-beta.2",
    "entry": {"executable": "payload/Open Design.exe"},
    "apps": {}
  }
}"#,
    )
    .unwrap();
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    assert!(matches!(
        resolve_config_with_args(&search, &[]),
        Err(LauncherLifecycleError::InvalidConfigRelativePath {
            field: "namespaceRoot",
            ..
        })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn unknown_fields_fail() {
    let root = temp_root("unknown-field");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "payloadRoot": "payload",
  "entry": {"executable": "payload.exe"},
  "extra": true
}"#,
    )
    .unwrap();
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    assert!(matches!(
        resolve_launcher_config(&search),
        Err(LauncherLifecycleError::Platform(_))
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn cwd_defaults_to_payload() {
    let config = launcher_lifecycle::LauncherConfig {
        attempt_path: None,
        entry: Some(launcher_core::PayloadEntry::new("payload/app.exe").unwrap()),
        payload_root: Some("payload".to_owned()),
        runtime_path: None,
        schema_version: 1,
    };

    let process = build_process_spec(Path::new("C:/root"), &config, &[]).unwrap();

    assert_eq!(process.cwd, PathBuf::from("C:/root/payload"));
}

#[test]
fn runtime_plan_resolves_active() {
    let root = temp_root("runtime-plan");
    let config_root = root.join("config");
    write_runtime_config(&config_root);
    create_runtime_version(&config_root, "0.8.0");
    create_runtime_version(&config_root, "0.8.1");
    let mut search = search(&root);
    search.explicit_root = Some(config_root.clone());
    let resolved = resolve_launcher_config(&search).unwrap();

    let plan = build_runtime_plan(&resolved).unwrap();

    assert_eq!(plan.namespace.as_str(), "release-beta-win");
    assert_eq!(plan.generation, 12);
    assert_eq!(plan.selected_slot, RuntimeSelectionSlot::Active);
    assert_eq!(plan.selected_version, "0.8.1");
    assert_eq!(
        plan.selected_root,
        config_root.join("namespaces/release-beta-win/versions/0.8.1")
    );
    assert_eq!(
        plan.namespace_root,
        config_root.join("namespaces/release-beta-win")
    );
    assert_eq!(plan.runtime_root, plan.namespace_root.join("runtime"));
    assert_eq!(plan.logs_root, plan.namespace_root.join("logs"));
    assert_eq!(plan.cache_root, plan.namespace_root.join("cache"));
    assert_eq!(plan.state_root, plan.namespace_root.join("state"));
    assert_eq!(plan.versions_root, plan.namespace_root.join("versions"));
    assert_eq!(plan.apps.len(), 2);
    assert_eq!(plan.apps[0].app, RuntimeApp::Daemon);
    assert_eq!(plan.apps[0].stamp.endpoint.as_str(), "tcp://127.0.0.1:17401");
    assert_eq!(
        plan.apps[0].process.executable,
        plan.selected_root.join("payload/daemon.exe")
    );
    assert_eq!(plan.apps[0].process.cwd, plan.selected_root);
    assert_eq!(
        plan.apps[0].runtime_file_path,
        plan.runtime_root.join("daemon.json")
    );
    assert_eq!(
        plan.apps[0].log_path,
        plan.logs_root.join("daemon").join("latest.log")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn active_missing_fallback() {
    let root = temp_root("runtime-active-missing");
    let config_root = root.join("config");
    write_runtime_config(&config_root);
    create_runtime_version(&config_root, "0.8.0");
    let mut search = search(&root);
    search.explicit_root = Some(config_root.clone());

    let resolved = resolve_launcher_config(&search).unwrap();
    let runtime = resolved.runtime_launch.as_ref().unwrap();

    assert_eq!(runtime.selected_slot, RuntimeSelectionSlot::LastSuccessful);
    assert_eq!(runtime.selected_version.version, "0.8.0");
    assert!(runtime.active_error.as_deref().unwrap().contains("does not exist"));
    assert_eq!(
        resolved.process.executable,
        config_root.join("namespaces/release-beta-win/versions/0.8.0/payload/Open Design Payload.exe")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn attempted_active_fallback() {
    let root = temp_root("runtime-attempted");
    let config_root = root.join("config");
    write_runtime_config(&config_root);
    create_runtime_version(&config_root, "0.8.0");
    create_runtime_version(&config_root, "0.8.1");
    write_attempt(&config_root);
    let mut search = search(&root);
    search.explicit_root = Some(config_root);

    let resolved = resolve_launcher_config(&search).unwrap();
    let runtime = resolved.runtime_launch.as_ref().unwrap();

    assert_eq!(runtime.selected_slot, RuntimeSelectionSlot::LastSuccessful);
    assert_eq!(runtime.selected_version.version, "0.8.0");
    assert_eq!(
        runtime.active_error.as_deref(),
        Some("active generation already attempted without health confirmation")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn duplicate_endpoints_fail() {
    let root = temp_root("duplicate-endpoints");
    let config_root = root.join("config");
    write_runtime_config_opts(&config_root, true);
    create_runtime_version(&config_root, "0.8.0");
    create_runtime_version(&config_root, "0.8.1");
    let mut search = search(&root);
    search.explicit_root = Some(config_root);
    let resolved = resolve_launcher_config(&search).unwrap();

    assert!(matches!(
        build_runtime_plan(&resolved),
        Err(LauncherLifecycleError::DuplicateEndpoint { .. })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_runtime_fails() {
    let root = temp_root("missing-runtime");
    write_config(&root, "payload.exe");
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());
    let resolved = resolve_launcher_config(&search).unwrap();

    assert!(matches!(
        build_runtime_plan(&resolved),
        Err(LauncherLifecycleError::MissingRuntimeDescriptor)
    ));

    let _ = fs::remove_dir_all(root);
}
