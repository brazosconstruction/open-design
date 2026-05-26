use launcher_core::PayloadEntry;
use launcher_platform::{LauncherPlatformError, ProcessSpec};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

mod runtime;

pub use runtime::{
    RuntimeAppDescriptor, RuntimeAppsDescriptor, RuntimeAttempt, RuntimeConfig, RuntimeLaunchPlan,
    RuntimePlan, RuntimeSelectionSlot, RuntimeVersionDescriptor,
};

pub const LAUNCHER_CONFIG_FILE: &str = "launcher.json";
pub const LAUNCHER_CONFIG_SCHEMA_VERSION: u32 = 1;
pub const LAUNCHER_ROOT_ENV: &str = "OD_LAUNCHER_ROOT";
pub const DEFAULT_RUNTIME_CONFIG_FILE: &str = "runtime.json";
pub const DEFAULT_RUNTIME_ATTEMPT_PATH: &str = "state/attempt.json";
pub const RUNTIME_ATTEMPT_SCHEMA_VERSION: u32 = 1;
pub const RUNTIME_CONFIG_SCHEMA_VERSION: u32 = 1;
pub const RUNTIME_PLAN_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum LauncherLifecycleError {
    #[error("launcher root from {origin} does not contain launcher.json: {path}")]
    ForcedConfigMissing {
        origin: &'static str,
        path: String,
    },
    #[error("launcher config was not found at cwd or launcher exe directory")]
    ImplicitConfigMissing,
    #[error("launcher exe path has no parent directory: {0}")]
    ExeParentMissing(String),
    #[error("unsupported launcher config schema at {path}: expected {expected}, got {actual}")]
    UnsupportedConfigSchema {
        actual: u32,
        expected: u32,
        path: String,
    },
    #[error("launcher config does not contain a runtime descriptor")]
    MissingRuntimeDescriptor,
    #[error("launcher config must contain entry and payloadRoot when runtimePath is not configured")]
    MissingLegacyPayload,
    #[error("{field} must be a clean relative path under descriptor root {root}: {path}")]
    InvalidConfigRelativePath {
        field: &'static str,
        path: String,
        root: String,
    },
    #[error("unsupported runtime descriptor schema at {path}: expected {expected}, got {actual}")]
    UnsupportedRuntimeSchema {
        actual: u32,
        expected: u32,
        path: String,
    },
    #[error("unsupported runtime attempt schema at {path}: expected {expected}, got {actual}")]
    UnsupportedRuntimeAttemptSchema {
        actual: u32,
        expected: u32,
        path: String,
    },
    #[error("runtime descriptor reuses endpoint {endpoint}")]
    DuplicateEndpoint { endpoint: String },
    #[error("runtime {slot} version {version} root does not exist: {path}")]
    RuntimeVersionRootMissing {
        path: String,
        slot: RuntimeSelectionSlot,
        version: String,
    },
    #[error("runtime {slot} version {version} executable does not exist: {path}")]
    RuntimeExecutableMissing {
        path: String,
        slot: RuntimeSelectionSlot,
        version: String,
    },
    #[error("runtime {slot} version {version} cwd does not exist: {path}")]
    RuntimeCwdMissing {
        path: String,
        slot: RuntimeSelectionSlot,
        version: String,
    },
    #[error("runtime {slot} version {version} {field} must be a clean relative path under {root}: {path}")]
    InvalidRuntimeRelativePath {
        field: &'static str,
        path: String,
        root: String,
        slot: RuntimeSelectionSlot,
        version: String,
    },
    #[error("lastSuccessful runtime version is not usable: {0}")]
    LastSuccessfulInvalid(String),
    #[error("{field} must not be empty")]
    EmptyField { field: &'static str },
    #[error("platform error: {0}")]
    Platform(#[from] LauncherPlatformError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigSource {
    ExplicitRoot,
    EnvironmentRoot,
    CurrentDirectory,
    LauncherDirectory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LauncherConfig {
    #[serde(default)]
    pub attempt_path: Option<String>,
    #[serde(default)]
    pub entry: Option<PayloadEntry>,
    #[serde(default)]
    pub payload_root: Option<String>,
    #[serde(default)]
    pub runtime_path: Option<String>,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigSearch {
    pub cwd: PathBuf,
    pub env_root: Option<PathBuf>,
    pub exe_path: PathBuf,
    pub explicit_root: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedLauncherConfig {
    pub config: LauncherConfig,
    pub config_path: PathBuf,
    pub config_root: PathBuf,
    pub payload_root: PathBuf,
    pub process: ProcessSpec,
    pub runtime_launch: Option<RuntimeLaunchPlan>,
    pub source: ConfigSource,
}

pub fn resolve_launcher_config(search: &ConfigSearch) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    resolve_config_with_args(search, &[])
}

pub fn resolve_config_with_args(
    search: &ConfigSearch,
    forwarded_args: &[String],
) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    if let Some(root) = &search.explicit_root {
        return load_from_root(
            &resolve_search_root(&search.cwd, root),
            ConfigSource::ExplicitRoot,
            Some("flag"),
            forwarded_args,
        );
    }
    if let Some(root) = &search.env_root {
        return load_from_root(
            &resolve_search_root(&search.cwd, root),
            ConfigSource::EnvironmentRoot,
            Some("environment"),
            forwarded_args,
        );
    }

    let cwd_config = search.cwd.join(LAUNCHER_CONFIG_FILE);
    if cwd_config.is_file() {
        return load_from_path(cwd_config, ConfigSource::CurrentDirectory, forwarded_args);
    }

    let exe_root = search
        .exe_path
        .parent()
        .ok_or_else(|| LauncherLifecycleError::ExeParentMissing(search.exe_path.display().to_string()))?;
    let exe_config = exe_root.join(LAUNCHER_CONFIG_FILE);
    if exe_config.is_file() {
        return load_from_path(exe_config, ConfigSource::LauncherDirectory, forwarded_args);
    }

    Err(LauncherLifecycleError::ImplicitConfigMissing)
}

pub fn build_process_spec(
    config_root: &Path,
    config: &LauncherConfig,
    forwarded_args: &[String],
) -> Result<ProcessSpec, LauncherLifecycleError> {
    let payload_root_value = config
        .payload_root
        .as_deref()
        .ok_or(LauncherLifecycleError::MissingLegacyPayload)?;
    let entry = config
        .entry
        .as_ref()
        .ok_or(LauncherLifecycleError::MissingLegacyPayload)?;
    require_non_empty(payload_root_value, "payloadRoot")?;
    require_non_empty(&entry.executable, "entry.executable")?;
    let payload_root = resolve_config_path(config_root, payload_root_value);
    let executable = resolve_config_path(config_root, &entry.executable);
    let cwd = entry
        .cwd
        .as_deref()
        .map(|cwd| resolve_config_path(config_root, cwd))
        .unwrap_or_else(|| payload_root.clone());
    let args = entry
        .args
        .iter()
        .cloned()
        .chain(forwarded_args.iter().cloned())
        .collect();

    Ok(ProcessSpec {
        args,
        cwd,
        env: entry.env.clone(),
        executable,
    })
}

pub fn load_launcher_config(path: &Path) -> Result<LauncherConfig, LauncherLifecycleError> {
    let config: LauncherConfig = launcher_platform::read_json_file(path)?;
    if config.schema_version != LAUNCHER_CONFIG_SCHEMA_VERSION {
        return Err(LauncherLifecycleError::UnsupportedConfigSchema {
            actual: config.schema_version,
            expected: LAUNCHER_CONFIG_SCHEMA_VERSION,
            path: path.display().to_string(),
        });
    }
    if let Some(runtime_path) = runtime::effective_runtime_path(&config) {
        require_non_empty(runtime_path, "runtimePath")?;
    } else {
        let payload_root = config
            .payload_root
            .as_deref()
            .ok_or(LauncherLifecycleError::MissingLegacyPayload)?;
        let entry = config
            .entry
            .as_ref()
            .ok_or(LauncherLifecycleError::MissingLegacyPayload)?;
        require_non_empty(payload_root, "payloadRoot")?;
        require_non_empty(&entry.executable, "entry.executable")?;
    }
    if let Some(attempt_path) = config.attempt_path.as_deref() {
        require_non_empty(attempt_path, "attemptPath")?;
    }
    Ok(config)
}

pub fn launch_config(resolved: &ResolvedLauncherConfig) -> Result<(), LauncherLifecycleError> {
    if let Some(runtime) = &resolved.runtime_launch
        && runtime.selected_slot == RuntimeSelectionSlot::Active
    {
        let attempt = RuntimeAttempt {
            generation: runtime.config.generation,
            schema_version: RUNTIME_ATTEMPT_SCHEMA_VERSION,
            version: runtime.selected_version.version.clone(),
        };
        launcher_platform::write_json_file(&runtime.attempt_path, &attempt)?;
        return match launcher_platform::spawn_process(&runtime.process) {
            Ok(_) => Ok(()),
            Err(error) => {
                let Some(fallback) = &runtime.fallback_process else {
                    return Err(error.into());
                };
                let _child = launcher_platform::spawn_process(fallback)?;
                Ok(())
            }
        };
    }

    let _child = launcher_platform::spawn_process(&resolved.process)?;
    Ok(())
}

pub fn build_runtime_plan(resolved: &ResolvedLauncherConfig) -> Result<RuntimePlan, LauncherLifecycleError> {
    let runtime = resolved
        .runtime_launch
        .as_ref()
        .ok_or(LauncherLifecycleError::MissingRuntimeDescriptor)?;
    runtime::build_runtime_plan(runtime)
}

fn load_from_root(
    root: &Path,
    source: ConfigSource,
    forced_source: Option<&'static str>,
    forwarded_args: &[String],
) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    let path = root.join(LAUNCHER_CONFIG_FILE);
    if let Some(source) = forced_source
        && !path.is_file()
    {
        return Err(LauncherLifecycleError::ForcedConfigMissing {
            origin: source,
            path: path.display().to_string(),
        });
    }
    load_from_path(path, source, forwarded_args)
}

fn load_from_path(
    path: PathBuf,
    source: ConfigSource,
    forwarded_args: &[String],
) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    let config = load_launcher_config(&path)?;
    let config_root = path
        .parent()
        .ok_or_else(|| LauncherLifecycleError::ForcedConfigMissing {
            origin: "config",
            path: path.display().to_string(),
        })?
        .to_path_buf();
    let runtime_launch = if runtime::effective_runtime_path(&config).is_some() {
        Some(runtime::build_runtime_launch_plan(
            &config_root,
            &config,
            forwarded_args,
        )?)
    } else {
        None
    };
    let process = if let Some(runtime) = &runtime_launch {
        runtime.process.clone()
    } else {
        build_process_spec(&config_root, &config, forwarded_args)?
    };
    let payload_root = runtime_launch
        .as_ref()
        .map(|runtime| runtime.selected_root.clone())
        .unwrap_or_else(|| {
            let payload_root = config
                .payload_root
                .as_deref()
                .expect("payloadRoot must be validated before resolution");
            resolve_config_path(&config_root, payload_root)
        });
    Ok(ResolvedLauncherConfig {
        config,
        config_path: path,
        config_root,
        payload_root,
        process,
        runtime_launch,
        source,
    })
}

pub(crate) fn resolve_config_path(root: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

pub(crate) fn resolve_config_relative_path(
    root: &Path,
    value: &str,
    field: &'static str,
) -> Result<PathBuf, LauncherLifecycleError> {
    if !is_clean_relative_descriptor_path(value) {
        return Err(LauncherLifecycleError::InvalidConfigRelativePath {
            field,
            path: value.to_owned(),
            root: root.display().to_string(),
        });
    }
    if value == "." {
        return Ok(root.to_path_buf());
    }
    Ok(root.join(Path::new(value)))
}

pub(crate) fn is_clean_relative_descriptor_path(value: &str) -> bool {
    if value.contains('\0') {
        return false;
    }
    let normalized = value.replace('\\', "/");
    if normalized.starts_with('/') || normalized.chars().nth(1) == Some(':') {
        return false;
    }
    if normalized == "." {
        return true;
    }
    if normalized.split('/').any(|segment| segment.is_empty() || segment == "..") {
        return false;
    }
    for component in Path::new(value).components() {
        if matches!(component, Component::Prefix(_) | Component::RootDir | Component::ParentDir) {
            return false;
        }
    }
    true
}

fn resolve_search_root(cwd: &Path, root: &Path) -> PathBuf {
    if root.is_absolute() {
        root.to_path_buf()
    } else {
        cwd.join(root)
    }
}

pub(crate) fn require_non_empty(value: &str, field: &'static str) -> Result<(), LauncherLifecycleError> {
    if value.trim().is_empty() {
        return Err(LauncherLifecycleError::EmptyField { field });
    }
    Ok(())
}
