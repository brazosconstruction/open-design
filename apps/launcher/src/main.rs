use launcher_lifecycle::{
    ConfigSearch, LAUNCHER_ROOT_ENV, build_runtime_plan, resolve_config_with_args,
};
use std::error::Error;
use std::path::PathBuf;

#[derive(Debug, Eq, PartialEq)]
enum CommandMode {
    ConfigPrint,
    Launch,
    RuntimePlan,
    Version,
}

#[derive(Debug)]
struct CliOptions {
    forwarded_args: Vec<String>,
    json: bool,
    mode: CommandMode,
    root: Option<PathBuf>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("open-design-launcher: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let options = parse_args(std::env::args().skip(1))?;
    match options.mode {
        CommandMode::ConfigPrint => {
            let resolved = resolve_config(&options)?;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&resolved.config)?);
            } else {
                println!("configPath={}", resolved.config_path.display());
                println!("payloadRoot={}", resolved.payload_root.display());
                println!("executable={}", resolved.process.executable.display());
                println!("cwd={}", resolved.process.cwd.display());
                if let Some(runtime) = &resolved.runtime_launch {
                    println!("runtimePath={}", runtime.config_path.display());
                    println!("generation={}", runtime.config.generation);
                    println!("selectedSlot={}", runtime.selected_slot);
                    println!("selectedVersion={}", runtime.selected_version.version);
                    if let Some(error) = &runtime.active_error {
                        println!("activeError={error}");
                    }
                }
            }
        }
        CommandMode::Launch => {
            let resolved = resolve_config(&options)?;
            launcher_lifecycle::launch_config(&resolved)?;
        }
        CommandMode::RuntimePlan => {
            let resolved = resolve_config(&options)?;
            let plan = build_runtime_plan(&resolved)?;
            if options.json {
                println!("{}", serde_json::to_string_pretty(&plan)?);
            } else {
                println!("namespace={}", plan.namespace);
                println!("generation={}", plan.generation);
                println!("selectedSlot={}", plan.selected_slot);
                println!("selectedVersion={}", plan.selected_version);
                println!("namespaceRoot={}", plan.namespace_root.display());
                println!(
                    "payloadExecutable={}",
                    plan.payload_process.executable.display()
                );
                println!("payloadCwd={}", plan.payload_process.cwd.display());
                if let Some(error) = &plan.active_error {
                    println!("activeError={error}");
                }
                for app in &plan.apps {
                    println!("{}={}", app.app, app.stamp.endpoint);
                }
            }
        }
        CommandMode::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
        }
    }
    Ok(())
}

fn resolve_config(
    options: &CliOptions,
) -> Result<launcher_lifecycle::ResolvedLauncherConfig, Box<dyn Error>> {
    let search = ConfigSearch {
        cwd: launcher_platform::current_dir()?,
        env_root: launcher_platform::env_path(LAUNCHER_ROOT_ENV),
        exe_path: launcher_platform::current_exe()?,
        explicit_root: options.root.clone(),
    };
    Ok(resolve_config_with_args(&search, &options.forwarded_args)?)
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<CliOptions, Box<dyn Error>> {
    let args = args.into_iter().collect::<Vec<_>>();
    let Some(first) = args.first() else {
        return Ok(CliOptions {
            forwarded_args: Vec::new(),
            json: false,
            mode: CommandMode::Launch,
            root: None,
        });
    };

    match first.as_str() {
        "config" => parse_config_command(&args[1..]),
        "runtime" => parse_runtime_command(&args[1..]),
        "version" | "--version" | "-V" => Ok(CliOptions {
            forwarded_args: Vec::new(),
            json: false,
            mode: CommandMode::Version,
            root: None,
        }),
        "--help" | "-h" => {
            print_help();
            std::process::exit(0);
        }
        _ => parse_launch_args(&args),
    }
}

fn parse_config_command(args: &[String]) -> Result<CliOptions, Box<dyn Error>> {
    let Some(command) = args.first() else {
        return Err("expected config print".into());
    };
    if command != "print" {
        return Err(format!("unknown config command: {command}").into());
    }
    let common = parse_common_options(&args[1..])?;
    Ok(CliOptions {
        forwarded_args: Vec::new(),
        json: common.json,
        mode: CommandMode::ConfigPrint,
        root: common.root,
    })
}

fn parse_runtime_command(args: &[String]) -> Result<CliOptions, Box<dyn Error>> {
    let Some(command) = args.first() else {
        return Err("expected runtime plan".into());
    };
    if command != "plan" {
        return Err(format!("unknown runtime command: {command}").into());
    }
    let common = parse_common_options(&args[1..])?;
    Ok(CliOptions {
        forwarded_args: Vec::new(),
        json: common.json,
        mode: CommandMode::RuntimePlan,
        root: common.root,
    })
}

fn parse_launch_args(args: &[String]) -> Result<CliOptions, Box<dyn Error>> {
    let mut forwarded_args = Vec::new();
    let mut root = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--" => {
                forwarded_args.extend(args[index + 1..].iter().cloned());
                break;
            }
            "--root" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return Err("--root requires a value".into());
                };
                root = Some(PathBuf::from(value));
            }
            _ if arg.starts_with("--root=") => {
                root = Some(PathBuf::from(value_after_equals(arg, "--root=")));
            }
            _ => {
                forwarded_args.extend(args[index..].iter().cloned());
                break;
            }
        }
        index += 1;
    }

    Ok(CliOptions {
        forwarded_args,
        json: false,
        mode: CommandMode::Launch,
        root,
    })
}

struct CommonOptions {
    json: bool,
    root: Option<PathBuf>,
}

fn parse_common_options(args: &[String]) -> Result<CommonOptions, Box<dyn Error>> {
    let mut json = false;
    let mut root = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        match arg.as_str() {
            "--json" => json = true,
            "--root" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    return Err("--root requires a value".into());
                };
                root = Some(PathBuf::from(value));
            }
            _ if arg.starts_with("--root=") => {
                root = Some(PathBuf::from(value_after_equals(arg, "--root=")));
            }
            _ => return Err(format!("unknown option: {arg}").into()),
        }
        index += 1;
    }
    Ok(CommonOptions { json, root })
}

fn value_after_equals<'a>(arg: &'a str, prefix: &'static str) -> &'a str {
    &arg[prefix.len()..]
}

fn print_help() {
    println!(
        "Usage:
  open-design-launcher [--root <dir>] [--] [payload args...]
  open-design-launcher config print [--json] [--root <dir>]
  open-design-launcher runtime plan [--json] [--root <dir>]
  open-design-launcher version"
    );
}
