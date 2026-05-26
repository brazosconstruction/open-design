use crate::{
    DEFAULT_RUNTIME_ATTEMPT_PATH, DEFAULT_RUNTIME_CONFIG_FILE, LauncherConfig,
    LauncherLifecycleError, RUNTIME_ATTEMPT_SCHEMA_VERSION, RUNTIME_CONFIG_SCHEMA_VERSION,
    RUNTIME_PLAN_SCHEMA_VERSION, is_clean_relative_descriptor_path, require_non_empty,
    resolve_config_relative_path,
};
use launcher_core::PayloadEntry;
use launcher_platform::ProcessSpec;
use launcher_proto::{RuntimeApp, RuntimeEndpoint, RuntimeNamespace, RuntimeStamp};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub active: RuntimeVersionDescriptor,
    pub generation: u64,
    pub last_successful: RuntimeVersionDescriptor,
    pub namespace: RuntimeNamespace,
    pub namespace_root: String,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeVersionDescriptor {
    #[serde(default)]
    pub apps: RuntimeAppsDescriptor,
    pub entry: PayloadEntry,
    pub root: String,
    pub version: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAppsDescriptor {
    #[serde(default)]
    pub daemon: Option<RuntimeAppDescriptor>,
    #[serde(default)]
    pub desktop: Option<RuntimeAppDescriptor>,
    #[serde(default)]
    pub web: Option<RuntimeAppDescriptor>,
}

impl RuntimeAppsDescriptor {
    pub fn iter(&self) -> impl Iterator<Item = (RuntimeApp, &RuntimeAppDescriptor)> {
        [
            (RuntimeApp::Daemon, self.daemon.as_ref()),
            (RuntimeApp::Desktop, self.desktop.as_ref()),
            (RuntimeApp::Web, self.web.as_ref()),
        ]
        .into_iter()
        .filter_map(|(app, descriptor)| descriptor.map(|descriptor| (app, descriptor)))
    }

    pub fn is_empty(&self) -> bool {
        self.daemon.is_none() && self.desktop.is_none() && self.web.is_none()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAppDescriptor {
    pub endpoint: RuntimeEndpoint,
    pub entry: PayloadEntry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSelectionSlot {
    Active,
    LastSuccessful,
}

impl fmt::Display for RuntimeSelectionSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Active => formatter.write_str("active"),
            Self::LastSuccessful => formatter.write_str("lastSuccessful"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAttempt {
    pub generation: u64,
    pub schema_version: u32,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeLaunchPlan {
    pub active_error: Option<String>,
    pub attempt: Option<RuntimeAttempt>,
    pub attempt_path: PathBuf,
    pub config: RuntimeConfig,
    pub config_path: PathBuf,
    pub fallback_process: Option<ProcessSpec>,
    pub process: ProcessSpec,
    pub selected_root: PathBuf,
    pub selected_slot: RuntimeSelectionSlot,
    pub selected_version: RuntimeVersionDescriptor,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlan {
    pub active_error: Option<String>,
    pub apps: Vec<RuntimeAppPlan>,
    pub cache_root: PathBuf,
    pub generation: u64,
    pub logs_root: PathBuf,
    pub namespace: RuntimeNamespace,
    pub namespace_root: PathBuf,
    pub payload_process: RuntimeProcessPlan,
    pub runtime_root: PathBuf,
    pub schema_version: u32,
    pub selected_root: PathBuf,
    pub selected_slot: RuntimeSelectionSlot,
    pub selected_version: String,
    pub state_root: PathBuf,
    pub versions_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAppPlan {
    pub app: RuntimeApp,
    pub log_path: PathBuf,
    pub process: RuntimeProcessPlan,
    pub runtime_file_path: PathBuf,
    pub stamp: RuntimeStamp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessPlan {
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub executable: PathBuf,
}

pub fn build_runtime_plan(
    runtime: &RuntimeLaunchPlan,
) -> Result<RuntimePlan, LauncherLifecycleError> {
    let runtime_root_dir = runtime_config_root(&runtime.config_path)?;
    let namespace_root = resolve_config_relative_path(
        runtime_root_dir,
        &runtime.config.namespace_root,
        "namespaceRoot",
    )?;
    let runtime_root = namespace_root.join("runtime");
    let logs_root = namespace_root.join("logs");
    let mut endpoints = BTreeSet::new();
    let mut apps = Vec::new();

    for (app, app_descriptor) in runtime.selected_version.apps.iter() {
        if !endpoints.insert(app_descriptor.endpoint.as_str().to_owned()) {
            return Err(LauncherLifecycleError::DuplicateEndpoint {
                endpoint: app_descriptor.endpoint.as_str().to_owned(),
            });
        }
        let process = build_runtime_process_plan(
            runtime.selected_slot,
            &runtime.selected_version.version,
            &runtime.selected_root,
            &app_descriptor.entry,
        )?;
        let stamp = RuntimeStamp::new(
            app,
            app_descriptor.endpoint.clone(),
            runtime.config.namespace.clone(),
        );
        apps.push(RuntimeAppPlan {
            app,
            log_path: logs_root.join(app.as_str()).join("latest.log"),
            process,
            runtime_file_path: runtime_root.join(format!("{}.json", app.as_str())),
            stamp,
        });
    }

    Ok(RuntimePlan {
        active_error: runtime.active_error.clone(),
        apps,
        cache_root: namespace_root.join("cache"),
        generation: runtime.config.generation,
        logs_root,
        namespace: runtime.config.namespace.clone(),
        namespace_root: namespace_root.clone(),
        payload_process: runtime_process_plan_from_process_spec(&runtime.process),
        runtime_root,
        schema_version: RUNTIME_PLAN_SCHEMA_VERSION,
        selected_root: runtime.selected_root.clone(),
        selected_slot: runtime.selected_slot,
        selected_version: runtime.selected_version.version.clone(),
        state_root: namespace_root.join("state"),
        versions_root: namespace_root.join("versions"),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeVersionCandidate {
    process: ProcessSpec,
    root: PathBuf,
}

pub(crate) fn build_runtime_launch_plan(
    config_root: &Path,
    launcher_config: &LauncherConfig,
    forwarded_args: &[String],
) -> Result<RuntimeLaunchPlan, LauncherLifecycleError> {
    let runtime_path = effective_runtime_path(launcher_config)
        .ok_or(LauncherLifecycleError::MissingRuntimeDescriptor)?;
    let config_path = resolve_config_relative_path(config_root, runtime_path, "runtimePath")?;
    let config = load_runtime_config(&config_path)?;
    let runtime_root_dir = runtime_config_root(&config_path)?;
    let namespace_root =
        resolve_config_relative_path(runtime_root_dir, &config.namespace_root, "namespaceRoot")?;
    let attempt_path = launcher_config
        .attempt_path
        .as_deref()
        .map(|attempt_path| resolve_config_relative_path(config_root, attempt_path, "attemptPath"))
        .transpose()?
        .unwrap_or_else(|| namespace_root.join(DEFAULT_RUNTIME_ATTEMPT_PATH));
    let attempt = read_runtime_attempt(&attempt_path)?;
    let last_successful = build_runtime_version_candidate(
        RuntimeSelectionSlot::LastSuccessful,
        runtime_root_dir,
        &config.last_successful,
        forwarded_args,
    )
    .map_err(|error| LauncherLifecycleError::LastSuccessfulInvalid(error.to_string()))?;
    let active_attempted = attempt.as_ref().is_some_and(|attempt| {
        attempt.generation == config.generation && attempt.version == config.active.version
    });

    if active_attempted {
        return Ok(RuntimeLaunchPlan {
            active_error: Some("active generation already attempted without health confirmation".to_owned()),
            attempt,
            attempt_path,
            config: config.clone(),
            config_path,
            fallback_process: None,
            process: last_successful.process,
            selected_root: last_successful.root,
            selected_slot: RuntimeSelectionSlot::LastSuccessful,
            selected_version: config.last_successful,
        });
    }

    match build_runtime_version_candidate(
        RuntimeSelectionSlot::Active,
        runtime_root_dir,
        &config.active,
        forwarded_args,
    ) {
        Ok(active) => Ok(RuntimeLaunchPlan {
            active_error: None,
            attempt,
            attempt_path,
            config: config.clone(),
            config_path,
            fallback_process: Some(last_successful.process),
            process: active.process,
            selected_root: active.root,
            selected_slot: RuntimeSelectionSlot::Active,
            selected_version: config.active,
        }),
        Err(error) => Ok(RuntimeLaunchPlan {
            active_error: Some(error.to_string()),
            attempt,
            attempt_path,
            config: config.clone(),
            config_path,
            fallback_process: None,
            process: last_successful.process,
            selected_root: last_successful.root,
            selected_slot: RuntimeSelectionSlot::LastSuccessful,
            selected_version: config.last_successful,
        }),
    }
}

fn build_runtime_version_candidate(
    slot: RuntimeSelectionSlot,
    runtime_root: &Path,
    version: &RuntimeVersionDescriptor,
    forwarded_args: &[String],
) -> Result<RuntimeVersionCandidate, LauncherLifecycleError> {
    require_non_empty(&version.version, "runtime.version")?;
    require_non_empty(&version.root, "runtime.root")?;
    let root = resolve_runtime_relative_path(
        slot,
        &version.version,
        runtime_root,
        &version.root,
        "root",
    )?;
    if !root.is_dir() {
        return Err(LauncherLifecycleError::RuntimeVersionRootMissing {
            path: root.display().to_string(),
            slot,
            version: version.version.clone(),
        });
    }
    let process = build_payload_process(slot, &version.version, &root, &version.entry, forwarded_args)?;
    Ok(RuntimeVersionCandidate { process, root })
}

fn build_payload_process(
    slot: RuntimeSelectionSlot,
    version: &str,
    version_root: &Path,
    entry: &PayloadEntry,
    forwarded_args: &[String],
) -> Result<ProcessSpec, LauncherLifecycleError> {
    let process = build_entry_process(slot, version, version_root, entry)?;
    Ok(ProcessSpec {
        args: entry
            .args
            .iter()
            .cloned()
            .chain(forwarded_args.iter().cloned())
            .collect(),
        cwd: process.cwd,
        env: process.env,
        executable: process.executable,
    })
}

fn build_runtime_process_plan(
    slot: RuntimeSelectionSlot,
    version: &str,
    version_root: &Path,
    entry: &PayloadEntry,
) -> Result<RuntimeProcessPlan, LauncherLifecycleError> {
    build_entry_process(slot, version, version_root, entry)
}

fn runtime_process_plan_from_process_spec(process: &ProcessSpec) -> RuntimeProcessPlan {
    RuntimeProcessPlan {
        args: process.args.clone(),
        cwd: process.cwd.clone(),
        env: process.env.clone(),
        executable: process.executable.clone(),
    }
}

fn build_entry_process(
    slot: RuntimeSelectionSlot,
    version: &str,
    version_root: &Path,
    entry: &PayloadEntry,
) -> Result<RuntimeProcessPlan, LauncherLifecycleError> {
    require_non_empty(&entry.executable, "runtime.entry.executable")?;
    let executable = resolve_existing_version_file(slot, version, version_root, &entry.executable)?;
    let cwd = entry
        .cwd
        .as_deref()
        .map(|cwd| resolve_runtime_relative_path(slot, version, version_root, cwd, "cwd"))
        .transpose()?
        .unwrap_or_else(|| version_root.to_path_buf());
    if !cwd.is_dir() {
        return Err(LauncherLifecycleError::RuntimeCwdMissing {
            path: cwd.display().to_string(),
            slot,
            version: version.to_owned(),
        });
    }
    Ok(RuntimeProcessPlan {
        args: entry.args.clone(),
        cwd,
        env: entry.env.clone(),
        executable,
    })
}

fn load_runtime_config(path: &Path) -> Result<RuntimeConfig, LauncherLifecycleError> {
    let config: RuntimeConfig = launcher_platform::read_json_file(path)?;
    if config.schema_version != RUNTIME_CONFIG_SCHEMA_VERSION {
        return Err(LauncherLifecycleError::UnsupportedRuntimeSchema {
            actual: config.schema_version,
            expected: RUNTIME_CONFIG_SCHEMA_VERSION,
            path: path.display().to_string(),
        });
    }
    require_non_empty(&config.namespace_root, "namespaceRoot")?;
    Ok(config)
}

fn read_runtime_attempt(path: &Path) -> Result<Option<RuntimeAttempt>, LauncherLifecycleError> {
    if !path.is_file() {
        return Ok(None);
    }
    let attempt: RuntimeAttempt = launcher_platform::read_json_file(path)?;
    if attempt.schema_version != RUNTIME_ATTEMPT_SCHEMA_VERSION {
        return Err(LauncherLifecycleError::UnsupportedRuntimeAttemptSchema {
            actual: attempt.schema_version,
            expected: RUNTIME_ATTEMPT_SCHEMA_VERSION,
            path: path.display().to_string(),
        });
    }
    Ok(Some(attempt))
}

pub(crate) fn effective_runtime_path(config: &LauncherConfig) -> Option<&str> {
    if let Some(runtime_path) = config.runtime_path.as_deref() {
        return Some(runtime_path);
    }
    if config.entry.is_none() && config.payload_root.is_none() {
        return Some(DEFAULT_RUNTIME_CONFIG_FILE);
    }
    None
}

fn runtime_config_root(path: &Path) -> Result<&Path, LauncherLifecycleError> {
    path.parent().ok_or_else(|| LauncherLifecycleError::ForcedConfigMissing {
        origin: "runtime",
        path: path.display().to_string(),
    })
}

fn resolve_runtime_relative_path(
    slot: RuntimeSelectionSlot,
    version: &str,
    root: &Path,
    value: &str,
    field: &'static str,
) -> Result<PathBuf, LauncherLifecycleError> {
    if !is_clean_relative_descriptor_path(value) {
        return Err(LauncherLifecycleError::InvalidRuntimeRelativePath {
            field,
            path: value.to_owned(),
            root: root.display().to_string(),
            slot,
            version: version.to_owned(),
        });
    }
    if value == "." {
        return Ok(root.to_path_buf());
    }
    Ok(root.join(Path::new(value)))
}

fn resolve_existing_version_file(
    slot: RuntimeSelectionSlot,
    version: &str,
    root: &Path,
    value: &str,
) -> Result<PathBuf, LauncherLifecycleError> {
    let path = resolve_runtime_relative_path(slot, version, root, value, "executable")?;
    if !path.is_file() {
        return Err(LauncherLifecycleError::RuntimeExecutableMissing {
            path: path.display().to_string(),
            slot,
            version: version.to_owned(),
        });
    }
    Ok(path)
}
