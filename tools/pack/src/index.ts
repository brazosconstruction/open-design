import { cac } from "cac";
import type { CAC } from "cac";

import { resolveToolPackConfig, type ToolPackCliOptions, type ToolPackPlatform } from "./config.js";
import {
  activatePackagedWebBundleOnline,
  activatePackagedBuiltinWebBundle,
  activatePackagedWebBundle,
  ensurePackagedWebBundle,
  readPackagedWebBundleStatus,
  restartPackagedWebBundle,
  switchPackagedWebBundle,
} from "./bundles.js";
import {
  cleanupPackedMacNamespace,
  installPackedMacDmg,
  inspectPackedMacApp,
  packMac,
  readPackedMacLogs,
  startPackedMacApp,
  stopPackedMacApp,
  uninstallPackedMacApp,
} from "./mac/index.js";
import {
  cleanupPackedWinNamespace,
  installPackedWinApp,
  inspectPackedWinApp,
  listPackedWinNamespaces,
  packWin,
  readPackedWinLogs,
  resetPackedWinNamespaces,
  startPackedWinApp,
  stopPackedWinApp,
  uninstallPackedWinApp,
} from "./win/index.js";
import {
  cleanupPackedLinuxNamespace,
  installPackedLinuxApp,
  installPackedLinuxHeadless,
  inspectPackedLinuxApp,
  packLinux,
  readPackedLinuxLogs,
  resolveLinuxLifecycleMode,
  startPackedLinuxApp,
  startPackedLinuxHeadless,
  stopPackedLinuxApp,
  stopPackedLinuxHeadless,
  uninstallPackedLinuxApp,
  uninstallPackedLinuxHeadless,
} from "./linux.js";

type CliOptions = ToolPackCliOptions;
type BundleCliOptions = CliOptions & {
  builtin?: boolean;
  online?: boolean;
  platform?: string;
  version?: string;
};

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printLogs(result: { logs: Record<string, { lines: string[]; logPath: string }>; namespace: string }, options: CliOptions): void {
  if (options.json === true) {
    printJson(result);
    return;
  }

  for (const [app, entry] of Object.entries(result.logs)) {
    process.stdout.write(`[${app}] ${entry.logPath}\n`);
    process.stdout.write(entry.lines.length > 0 ? `${entry.lines.join("\n")}\n` : "(no log lines)\n");
  }
}

function printCliError(action: string, error: unknown, options: CliOptions): void {
  const message = error instanceof Error ? error.message : String(error);
  if (options.json === true) {
    printJson({ ok: false, action, error: message });
  } else {
    process.stderr.write(`tools-pack ${action} failed: ${message}\n`);
  }
  process.exitCode = 1;
}

type CacCommand = ReturnType<CAC["command"]>;

function addSharedOptions(command: CacCommand) {
  return command
    .option("--cache-dir <path>", "tools-pack cache directory")
    .option("--dir <path>", "tools-pack root directory")
    .option("--json", "print JSON")
    .option("--namespace <name>", "runtime namespace")
    .option("--expr <expression>", "desktop inspect eval expression")
    .option("--path <path>", "desktop inspect screenshot path")
    .option("--update-action <action>", "desktop update action: status|check|download|install");
}

function resolveBundlePlatform(value: string | undefined): ToolPackPlatform {
  if (value === "mac" || value === "win" || value === "linux") return value;
  if (value != null && value.length > 0) throw new Error("--platform must be mac, win, or linux");
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

// Per-platform `--to` help text mirroring resolveToolPackBuildOutput in
// config.ts. Keep these in sync: the resolver throws on any value not listed
// here for the given platform.
const TO_HELP_BY_PLATFORM: Record<ToolPackPlatform, string> = {
  linux: "build target: all|appimage|dir (default: all)",
  mac: "build target: all|app|dmg|zip (default: all)",
  win: "build target: all|dir|nsis (default: nsis)",
};

function addBuildOptions(command: CacCommand, platform: ToolPackPlatform) {
  return command
    .option("--app-version <version>", "override packaged app version for release artifacts")
    .option("--portable", "do not bake local tools-pack runtime roots into the packaged config")
    .option("--signed", "build a signed/notarized mac artifact")
    .option("--to <target>", TO_HELP_BY_PLATFORM[platform]);
}

function addMacBuildOptions(command: CacCommand) {
  return addBuildOptions(command, "mac")
    .option("--mac-compression <mode>", "mac artifact compression: normal|maximum|store (default: normal)");
}

function addWinLifecycleOptions(command: CacCommand) {
  return command
    .option("--remove-data", "remove packaged data during uninstall/reset/cleanup")
    .option("--remove-logs", "remove packaged logs during uninstall/reset/cleanup")
    .option("--remove-product-user-data", "remove the public Electron app userData root during Windows uninstall/reset/cleanup")
    .option("--remove-sidecars", "remove packaged sidecar runtime during uninstall/reset/cleanup")
    .option("--silent", "run installer/uninstaller silently", { default: true });
}

const cli = cac("tools-pack");

addMacBuildOptions(addSharedOptions(cli.command("mac <action>", "Mac packaging commands: build|install|start|stop|logs|uninstall|cleanup|inspect"))).action(
  async (action: string, options: CliOptions) => {
    const config = resolveToolPackConfig("mac", options);
    switch (action) {
      case "build":
        printJson(await packMac(config));
        return;
      case "install":
        printJson(await installPackedMacDmg(config));
        return;
      case "start":
        printJson(await startPackedMacApp(config));
        return;
      case "stop":
        printJson(await stopPackedMacApp(config));
        return;
      case "logs":
        printLogs(await readPackedMacLogs(config), options);
        return;
      case "inspect":
        printJson(await inspectPackedMacApp(config, options));
        return;
      case "uninstall":
        printJson(await uninstallPackedMacApp(config));
        return;
      case "cleanup":
        printJson(await cleanupPackedMacNamespace(config));
        return;
      default:
        throw new Error(`unsupported mac action: ${action}`);
    }
  },
);

addWinLifecycleOptions(
  addBuildOptions(
    addSharedOptions(
      cli.command(
        "win <action>",
        "Windows packaging commands: build|install|start|stop|logs|uninstall|cleanup|list|reset|inspect",
      ),
    ),
    "win",
  ),
).action(async (action: string, options: CliOptions) => {
  const config = resolveToolPackConfig("win", options);
  switch (action) {
    case "build":
      printJson(await packWin(config));
      return;
    case "install":
      printJson(await installPackedWinApp(config));
      return;
    case "start":
      printJson(await startPackedWinApp(config));
      return;
    case "stop":
      printJson(await stopPackedWinApp(config));
      return;
    case "logs":
      printLogs(await readPackedWinLogs(config), options);
      return;
    case "uninstall":
      printJson(await uninstallPackedWinApp(config));
      return;
    case "cleanup":
      printJson(await cleanupPackedWinNamespace(config));
      return;
    case "list":
      printJson(await listPackedWinNamespaces(config));
      return;
    case "reset":
      printJson(await resetPackedWinNamespaces(config));
      return;
    case "inspect":
      printJson(await inspectPackedWinApp(config, options));
      return;
    default:
      throw new Error(`unsupported win action: ${action}`);
  }
});

addBuildOptions(addSharedOptions(cli.command("linux <action>", "Linux packaging commands: build|install|start|stop|logs|uninstall|cleanup|inspect")), "linux")
  .option("--containerized", "build inside electronuserland/builder Docker for wider glibc compatibility")
  .option("--headless", "install/start/stop/uninstall/cleanup the headless entry; inspect returns status only")
  .action(async (action: string, options: CliOptions) => {
    const config = resolveToolPackConfig("linux", options);
    switch (action) {
      case "build":
        printJson(await packLinux(config));
        return;
      case "install": {
        const mode = resolveLinuxLifecycleMode(options, "install");
        printJson(await (mode === "headless" ? installPackedLinuxHeadless(config) : installPackedLinuxApp(config)));
        return;
      }
      case "start": {
        const mode = resolveLinuxLifecycleMode(options, "start");
        printJson(await (mode === "headless" ? startPackedLinuxHeadless(config) : startPackedLinuxApp(config)));
        return;
      }
      case "stop": {
        const mode = resolveLinuxLifecycleMode(options, "stop");
        printJson(await (mode === "headless" ? stopPackedLinuxHeadless(config) : stopPackedLinuxApp(config)));
        return;
      }
      case "logs":
        printLogs(await readPackedLinuxLogs(config), options);
        return;
      case "inspect":
        printJson(await inspectPackedLinuxApp(config, {
          expr: options.expr,
          headless: options.headless === true,
          path: options.path,
        }));
        return;
      case "uninstall": {
        const mode = resolveLinuxLifecycleMode(options, "uninstall");
        printJson(await (mode === "headless" ? uninstallPackedLinuxHeadless(config) : uninstallPackedLinuxApp(config)));
        return;
      }
      case "cleanup":
        printJson(await cleanupPackedLinuxNamespace(config, options));
        return;
      default:
        throw new Error(`unsupported linux action: ${action}`);
    }
  });

cli.command("bundle <action>", "Packaged web bundle commands: activate|builtin|status|ensure|restart|switch")
  .option("--cache-dir <path>", "tools-pack cache directory")
  .option("--dir <path>", "tools-pack root directory")
  .option("--json", "print JSON")
  .option("--namespace <name>", "runtime namespace")
  .option("--platform <platform>", "packaged runtime platform: mac|win|linux (default: current host)")
  .option("--builtin", "target the built-in packaged web runtime")
  .option("--online", "send activation/builtin through the running packaged IPC instead of writing the offline pointer")
  .option("--version <version>", "web bundle version <epoch>.web.M")
  .action(async (action: string, options: BundleCliOptions) => {
    try {
      const config = resolveToolPackConfig(resolveBundlePlatform(options.platform), options);
      switch (action) {
        case "activate":
          if (options.version == null || options.version.length === 0) {
            throw new Error("tools-pack bundle activate requires --version <epoch>.web.M");
          }
          if (options.online === true) {
            printJson(await activatePackagedWebBundleOnline(config, { version: options.version }));
            return;
          }
          printJson(await activatePackagedWebBundle(config, options.version));
          return;
        case "builtin":
          if (options.online === true) {
            printJson(await activatePackagedWebBundleOnline(config, "builtin"));
            return;
          }
          printJson(await activatePackagedBuiltinWebBundle(config));
          return;
        case "ensure":
          printJson(await ensurePackagedWebBundle(config));
          return;
        case "restart":
          printJson(await restartPackagedWebBundle(config));
          return;
        case "status":
          printJson(await readPackagedWebBundleStatus(config));
          return;
        case "switch":
          if (options.builtin === true) {
            printJson(await switchPackagedWebBundle(config, "builtin"));
            return;
          }
          if (options.version == null || options.version.length === 0) {
            throw new Error("tools-pack bundle switch requires --version <epoch>.web.M or --builtin");
          }
          printJson(await switchPackagedWebBundle(config, { version: options.version }));
          return;
        default:
          throw new Error(`unsupported bundle action: ${action}`);
      }
    } catch (error) {
      printCliError(`bundle ${action}`, error, options);
    }
  });

cli.help();
cli.parse();
