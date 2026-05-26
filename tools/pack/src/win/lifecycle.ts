import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  type DesktopEvalResult,
  type DesktopScreenshotResult,
  type DesktopStatusSnapshot,
  type DesktopUpdateResult,
  type SidecarStamp,
} from "@open-design/sidecar-proto";
import {
  allocatePort,
  createControlEndpoint,
  createSidecarLaunchEnv,
  readAppControlEndpoint,
  requestJsonControl,
  writeAppControlEndpoint,
} from "@open-design/sidecar";
import {
  collectProcessTreePids,
  createProcessStampArgs,
  listProcessSnapshots,
  matchesStampedProcess,
  readLogTail,
  spawnBackgroundProcess,
  stopProcesses,
} from "@open-design/platform";

import type { ToolPackConfig } from "../config.js";
import { DESKTOP_LOG_ECHO_ENV } from "./constants.js";
import { listDirectories, pathExists, removeTree } from "./fs.js";
import { readBuiltAppManifest } from "./manifest.js";
import { invokeNsis, runTimed } from "./nsis.js";
import {
  createWinRemovalPlan,
  resolveWinPaths,
  resolveWinProductNamespaceRoot,
  resolveWinProductUserDataRoot,
} from "./paths.js";
import { resolveWinInstallIdentity } from "./identity.js";
import {
  cleanupWinRegistryResidues,
  queryWinRegistryEntries,
  queryWinRegistryResiduePaths,
  resolveWinRegisteredPaths,
} from "./registry.js";
import type {
  WinCleanupResult,
  WinInspectResult,
  WinInstallResult,
  WinInstallPayloadReport,
  WinListResult,
  WinResetResult,
  WinResidueObservation,
  WinStartResult,
  WinStopResult,
  WinUninstallResult,
  WinPaths,
} from "./types.js";

const PACKAGED_CONFIG_PATH_ENV = "OD_PACKAGED_CONFIG_PATH";
const UPDATE_ACTION_TIMEOUT_MS = 10 * 60 * 1000;

export type WinStartTarget = {
  configPath: string | null;
  executablePath: string;
  source: "built" | "installed";
};

async function desktopStamp(config: ToolPackConfig): Promise<SidecarStamp> {
  const endpoint = createControlEndpoint(
    (await allocatePort({
      host: OPEN_DESIGN_SIDECAR_CONTRACT.defaults.host,
      label: "desktop control",
    })).port,
    OPEN_DESIGN_SIDECAR_CONTRACT.defaults.host,
  );
  const stamp = {
    app: APP_KEYS.DESKTOP,
    endpoint,
    mode: SIDECAR_MODES.RUNTIME,
    namespace: config.namespace,
    source: SIDECAR_SOURCES.TOOLS_PACK,
  };
  await writeAppControlEndpoint({
    app: APP_KEYS.DESKTOP,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    endpoint,
    namespaceRoot: config.roots.runtime.namespaceRoot,
  });
  return stamp;
}

async function desktopEndpoint(config: ToolPackConfig): Promise<string | null> {
  return await readAppControlEndpoint({
    app: APP_KEYS.DESKTOP,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    namespaceRoot: config.roots.runtime.namespaceRoot,
  });
}

function desktopLogPath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "logs", APP_KEYS.DESKTOP, "latest.log");
}

function desktopIdentityPath(config: ToolPackConfig): string {
  return join(config.roots.runtime.namespaceRoot, "runtime", "desktop-root.json");
}

async function waitForDesktopStatus(config: ToolPackConfig, timeoutMs = 45_000): Promise<DesktopStatusSnapshot | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const endpoint = await desktopEndpoint(config);
      if (endpoint != null) {
        return await requestJsonControl<DesktopStatusSnapshot>(endpoint, { type: SIDECAR_MESSAGES.STATUS }, { timeoutMs: 1000 });
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  return null;
}

function installArgs(config: ToolPackConfig, paths: WinPaths): string[] {
  return [...(config.silent ? ["/S"] : []), `/D=${paths.installDir}`];
}

function uninstallArgs(config: ToolPackConfig): string[] {
  return ["/currentuser", ...(config.silent ? ["/S"] : [])];
}

function launcherInstallRootLockPath(installDir: string): string {
  return join(installDir, "state", "lock");
}

async function assertNoLauncherInstallRootLock(installDir: string, action: string): Promise<void> {
  const lockPath = launcherInstallRootLockPath(installDir);
  if (await pathExists(lockPath)) throw new Error(`cannot ${action}; launcher install root lock exists at ${lockPath}`);
}

export async function removePartialWinInstallRootIfUnlocked(paths: Pick<WinPaths, "installDir" | "uninstallerPath">): Promise<boolean> {
  if (await pathExists(paths.uninstallerPath)) return false;
  if (!(await pathExists(paths.installDir))) return false;
  await assertNoLauncherInstallRootLock(paths.installDir, "cleanup launcher root");
  await removeTree(paths.installDir);
  return true;
}

export async function removeWinShortcutResidues(paths: Pick<WinPaths, "publicDesktopShortcutPath" | "startMenuShortcutPath" | "userDesktopShortcutPath">): Promise<void> {
  await Promise.all([
    paths.publicDesktopShortcutPath,
    paths.startMenuShortcutPath,
    paths.userDesktopShortcutPath,
  ].map(async (shortcutPath) => {
    try {
      await rm(shortcutPath, { force: true });
    } catch {
      // Public desktop entries can require elevation; residue observation will still report failures.
    }
  }));
}

async function writeJsonMarker(filePath: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function collectFileTreeStats(root: string): Promise<{ fileCount: number; totalBytes: number }> {
  const metadata = await stat(root).catch(() => null);
  if (metadata == null) return { fileCount: 0, totalBytes: 0 };
  if (!metadata.isDirectory()) return { fileCount: 1, totalBytes: metadata.size };

  const children = await readdir(root, { withFileTypes: true }).catch(() => []);
  const childStats = await Promise.all(children.map((child) => collectFileTreeStats(join(root, child.name))));
  return childStats.reduce(
    (total, entry) => ({
      fileCount: total.fileCount + entry.fileCount,
      totalBytes: total.totalBytes + entry.totalBytes,
    }),
    { fileCount: 0, totalBytes: 0 },
  );
}

async function collectInstallPayloadReport(paths: WinPaths): Promise<WinInstallPayloadReport> {
  const topLevelEntries = await readdir(paths.installDir, { withFileTypes: true }).catch(() => []);
  const topLevel = await Promise.all(
    topLevelEntries.map(async (entry) => {
      const entryPath = join(paths.installDir, entry.name);
      const stats = await collectFileTreeStats(entryPath);
      return { bytes: stats.totalBytes, fileCount: stats.fileCount, path: entry.name };
    }),
  );
  const totals = topLevel.reduce(
    (total, entry) => ({
      fileCount: total.fileCount + entry.fileCount,
      totalBytes: total.totalBytes + entry.bytes,
    }),
    { fileCount: 0, totalBytes: 0 },
  );
  return {
    ...totals,
    topLevel: topLevel.sort((left, right) => right.bytes - left.bytes || right.fileCount - left.fileCount),
  };
}

async function observeWinResidues(config: ToolPackConfig, paths = resolveWinPaths(config)): Promise<WinResidueObservation> {
  return {
    installDirExists: await pathExists(paths.installDir),
    installedExeExists: await pathExists(paths.installedExePath),
    managedProcessPids: await findManagedDesktopProcessTree(config),
    productNamespaceRootExists: await pathExists(resolveWinProductNamespaceRoot(config)),
    productUserDataRootExists: await pathExists(resolveWinProductUserDataRoot()),
    publicDesktopShortcutExists: await pathExists(paths.publicDesktopShortcutPath),
    registryResidues: await queryWinRegistryResiduePaths(paths, config),
    runtimeNamespaceRootExists: await pathExists(config.roots.runtime.namespaceRoot),
    startMenuShortcutExists: await pathExists(paths.startMenuShortcutPath),
    uninstallerExists: await pathExists(paths.uninstallerPath),
    userDesktopShortcutExists: await pathExists(paths.userDesktopShortcutPath),
  };
}

export async function installPackedWinApp(config: ToolPackConfig): Promise<WinInstallResult> {
  const paths = resolveWinPaths(config);
  const registeredPaths = await resolveWinRegisteredPaths(config, paths);
  if (!(await pathExists(paths.setupPath))) throw new Error(`no windows installer found at ${paths.setupPath}; run tools-pack win build first`);
  await assertNoLauncherInstallRootLock(registeredPaths.installDir, "install over existing launcher root");
  if (await pathExists(registeredPaths.uninstallerPath)) {
    await uninstallPackedWinApp(config);
  } else {
    await removeTree(registeredPaths.installDir);
  }
  await mkdir(dirname(paths.installDir), { recursive: true });
  await runTimed(paths.installTimingPath, "install", async () => {
    await invokeNsis(paths, paths.setupPath, installArgs(config, paths), "install");
  });
  const installedPaths = await resolveWinRegisteredPaths(config, paths);
  if (!(await pathExists(installedPaths.installedExePath))) throw new Error(`installer completed but executable is missing at ${installedPaths.installedExePath}`);
  const registryEntries = await queryWinRegistryEntries(installedPaths, config);
  const installPayload = await collectInstallPayloadReport(installedPaths);
  await writeJsonMarker(paths.installMarkerPath, {
    installedAt: new Date().toISOString(),
    installDir: installedPaths.installDir,
    installPayload,
    namespace: config.namespace,
    registryEntries: registryEntries.map((entry) => entry.keyPath),
  });
  return {
    desktopShortcutExists: await pathExists(paths.userDesktopShortcutPath),
    desktopShortcutPath: paths.userDesktopShortcutPath,
    installDir: installedPaths.installDir,
    installerPath: paths.setupPath,
    installPayload,
    markerPath: paths.installMarkerPath,
    namespace: config.namespace,
    nsisLogPath: paths.nsisLogPath,
    registryEntries,
    startMenuShortcutExists: await pathExists(paths.startMenuShortcutPath),
    startMenuShortcutPath: paths.startMenuShortcutPath,
    timingPath: paths.installTimingPath,
    uninstallerPath: installedPaths.uninstallerPath,
  };
}

function builtLauncherExecutablePath(config: ToolPackConfig, paths: WinPaths): string {
  return join(paths.launcherInstallRoot, resolveWinInstallIdentity(config).exeName);
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function isNormalFile(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null);
  return entry != null && entry.isFile() && !entry.isSymbolicLink();
}

async function runtimePayloadExecutablePath(installRoot: string): Promise<string | null> {
  const runtimeConfigPath = join(installRoot, "runtime.json");
  if (!(await isNormalFile(runtimeConfigPath))) return null;

  let runtime: unknown;
  try {
    runtime = JSON.parse(await readFile(runtimeConfigPath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(runtime) || !isRecord(runtime.active) || !isRecord(runtime.active.entry)) return null;

  const activeRoot = stringField(runtime.active, "root");
  const executable = stringField(runtime.active.entry, "executable");
  if (activeRoot == null || executable == null) return null;

  const payloadExecutablePath = resolve(installRoot, activeRoot, executable);
  return containsPath(installRoot, payloadExecutablePath) ? payloadExecutablePath : null;
}

async function hasCompleteBuiltLauncherRoot(installRoot: string, launcherExecutablePath: string): Promise<boolean> {
  if (!(await isNormalFile(launcherExecutablePath))) return false;
  const requiredFiles = [
    join(installRoot, "install.json"),
    join(installRoot, "launcher.json"),
    join(installRoot, "runtime.json"),
    join(installRoot, "lib", "7z", "7z.exe"),
    join(installRoot, "lib", "7z", "7z.dll"),
  ];
  for (const requiredFile of requiredFiles) {
    if (!(await isNormalFile(requiredFile))) return false;
  }

  const payloadExecutablePath = await runtimePayloadExecutablePath(installRoot);
  return payloadExecutablePath != null && await isNormalFile(payloadExecutablePath);
}

export async function resolveWinStartTarget(config: ToolPackConfig): Promise<WinStartTarget> {
  const paths = resolveWinPaths(config);
  const registeredPaths = await resolveWinRegisteredPaths(config, paths);
  if (await isNormalFile(registeredPaths.installedExePath)) return { configPath: null, executablePath: registeredPaths.installedExePath, source: "installed" };
  const launcherExecutablePath = builtLauncherExecutablePath(config, paths);
  if (await hasCompleteBuiltLauncherRoot(paths.launcherInstallRoot, launcherExecutablePath)) return { configPath: null, executablePath: launcherExecutablePath, source: "built" };
  const builtManifest = await readBuiltAppManifest(paths, { requireExecutable: true });
  if (builtManifest != null) return { configPath: builtManifest.configPath, executablePath: builtManifest.executablePath, source: "built" };
  if (await isNormalFile(paths.unpackedExePath)) return { configPath: null, executablePath: paths.unpackedExePath, source: "built" };
  throw new Error(`no windows app executable found for namespace=${config.namespace}; run tools-pack win build first or tools-pack win install after building an NSIS installer`);
}

export async function startPackedWinApp(config: ToolPackConfig): Promise<WinStartResult> {
  const target = await resolveWinStartTarget(config);
  const stamp = await desktopStamp(config);
  const logPath = desktopLogPath(config);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, "", "utf8");
  const spawned = await spawnBackgroundProcess({
    args: createProcessStampArgs(stamp, OPEN_DESIGN_SIDECAR_CONTRACT),
    command: target.executablePath,
    cwd: dirname(target.executablePath),
    env: createSidecarLaunchEnv({
      base: config.roots.runtime.namespaceBaseRoot,
      contract: OPEN_DESIGN_SIDECAR_CONTRACT,
      extraEnv: {
        ...process.env,
        [DESKTOP_LOG_ECHO_ENV]: "0",
        ...(target.configPath == null ? {} : { [PACKAGED_CONFIG_PATH_ENV]: target.configPath }),
      },
      stamp,
    }),
    logFd: null,
  });
  return { executablePath: target.executablePath, logPath, namespace: config.namespace, pid: spawned.pid, source: target.source, status: await waitForDesktopStatus(config) };
}

async function findManagedDesktopProcessTree(config: ToolPackConfig): Promise<number[]> {
  const processes = await listProcessSnapshots();
  const stampedRootPids = processes
    .filter((processInfo) =>
      matchesStampedProcess(processInfo, { mode: SIDECAR_MODES.RUNTIME, namespace: config.namespace, source: SIDECAR_SOURCES.TOOLS_PACK }, OPEN_DESIGN_SIDECAR_CONTRACT),
    )
    .map((processInfo) => processInfo.pid);
  return collectProcessTreePids(processes, stampedRootPids);
}

async function waitForNoManagedDesktopProcesses(config: ToolPackConfig, timeoutMs = 6000): Promise<number[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await findManagedDesktopProcessTree(config);
    if (pids.length === 0) return [];
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return await findManagedDesktopProcessTree(config);
}

export async function stopPackedWinApp(config: ToolPackConfig): Promise<WinStopResult> {
  const before = await findManagedDesktopProcessTree(config);
  let gracefulRequested = false;
  try {
    const endpoint = await desktopEndpoint(config);
    if (endpoint != null) {
      await requestJsonControl(endpoint, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1500 });
      gracefulRequested = true;
    }
  } catch {
    gracefulRequested = false;
  }
  const remainingAfterGraceful = gracefulRequested ? await waitForNoManagedDesktopProcesses(config) : before;
  if (remainingAfterGraceful.length === 0) {
    await rm(desktopIdentityPath(config), { force: true }).catch(() => undefined);
    return { gracefulRequested, namespace: config.namespace, remainingPids: [], status: before.length === 0 ? "not-running" : "stopped", stoppedPids: before };
  }
  const stopped = await stopProcesses(remainingAfterGraceful);
  if (stopped.remainingPids.length === 0) await rm(desktopIdentityPath(config), { force: true }).catch(() => undefined);
  return {
    gracefulRequested,
    namespace: config.namespace,
    remainingPids: stopped.remainingPids,
    status: stopped.remainingPids.length === 0 ? "stopped" : "partial",
    stoppedPids: stopped.stoppedPids,
  };
}

export async function readPackedWinLogs(config: ToolPackConfig) {
  const paths = resolveWinPaths(config);
  const entries = await Promise.all(
    [APP_KEYS.DESKTOP, APP_KEYS.WEB, APP_KEYS.DAEMON].map(async (app) => {
      const logPath = join(config.roots.runtime.namespaceRoot, "logs", app, "latest.log");
      return [app, { lines: await readLogTail(logPath, 200), logPath }] as const;
    }),
  );
  return {
    logs: {
      ...Object.fromEntries(entries),
      nsis: { lines: await readLogTail(paths.nsisLogPath, 200), logPath: paths.nsisLogPath },
    },
    namespace: config.namespace,
  };
}

export async function uninstallPackedWinApp(config: ToolPackConfig): Promise<WinUninstallResult> {
  const paths = resolveWinPaths(config);
  const registeredPaths = await resolveWinRegisteredPaths(config, paths);
  const stop = await stopPackedWinApp(config);
  await assertNoLauncherInstallRootLock(registeredPaths.installDir, "uninstall launcher root");
  if (await pathExists(registeredPaths.uninstallerPath)) {
    await runTimed(paths.uninstallTimingPath, "uninstall", async () => {
      await invokeNsis(paths, registeredPaths.uninstallerPath, uninstallArgs(config), "uninstall");
    });
    await assertNoLauncherInstallRootLock(registeredPaths.installDir, "finish uninstall cleanup");
  }
  await removeTree(registeredPaths.installDir);
  const registryResiduesRemoved = await cleanupWinRegistryResidues(registeredPaths, config);
  await removeWinShortcutResidues(paths);
  const removalPlan = await createWinRemovalPlan(config);
  await writeJsonMarker(paths.uninstallMarkerPath, {
    namespace: config.namespace,
    removalPlan,
    registryResiduesRemoved,
    uninstalledAt: new Date().toISOString(),
  }).catch(() => undefined);
  const removedDataRoot = removalPlan.some((target) => target.scope === "data" && target.willRemove && target.exists);
  const removedLogsRoot = removalPlan.some((target) => target.scope === "logs" && target.willRemove && target.exists);
  const removedSidecarRoot = removalPlan.some((target) => target.scope === "sidecars" && target.willRemove && target.exists);
  const removedProductUserDataRoot = removalPlan.some((target) => target.scope === "product-user-data" && target.willRemove && target.exists);
  for (const target of removalPlan) {
    if (target.willRemove) await removeTree(target.path);
  }
  return {
    markerPath: paths.uninstallMarkerPath,
    namespace: config.namespace,
    nsisLogPath: paths.nsisLogPath,
    registryResiduesRemoved,
    removedDataRoot,
    removedLogsRoot,
    removedProductUserDataRoot,
    removedSidecarRoot,
    removalPlan,
    residueObservation: await observeWinResidues(config, registeredPaths),
    stop,
    timingPath: paths.uninstallTimingPath,
    uninstallerPath: registeredPaths.uninstallerPath,
  };
}

export async function cleanupPackedWinNamespace(config: ToolPackConfig): Promise<WinCleanupResult> {
  const paths = resolveWinPaths(config);
  const registeredPaths = await resolveWinRegisteredPaths(config, paths);
  const removalPlan = await createWinRemovalPlan(config);
  if (await pathExists(registeredPaths.uninstallerPath)) {
    await uninstallPackedWinApp(config);
  }
  const stop = await stopPackedWinApp(config);
  const removedPartialInstallRoot = await removePartialWinInstallRootIfUnlocked(registeredPaths);
  const removedOutputRoot = await pathExists(config.roots.output.namespaceRoot);
  const removedRuntimeNamespaceRoot = await pathExists(config.roots.runtime.namespaceRoot);
  const removedProductUserDataRoot = removalPlan.some((target) => target.scope === "product-user-data" && target.willRemove && target.exists);
  await cleanupWinRegistryResidues(registeredPaths, config);
  await removeWinShortcutResidues(paths);
  for (const target of removalPlan) {
    if (target.scope === "product-user-data" && target.willRemove) await removeTree(target.path);
  }
  await removeTree(config.roots.output.namespaceRoot);
  await removeTree(config.roots.runtime.namespaceRoot);
  return {
    namespace: config.namespace,
    removedOutputRoot,
    removedPartialInstallRoot,
    removedProductUserDataRoot,
    removedRuntimeNamespaceRoot,
    removalPlan,
    residueObservation: await observeWinResidues(config, registeredPaths),
    stop,
  };
}

export async function listPackedWinNamespaces(config: ToolPackConfig): Promise<WinListResult> {
  const paths = resolveWinPaths(config);
  const registeredPaths = await resolveWinRegisteredPaths(config, paths);
  const registryEntries = await queryWinRegistryEntries(registeredPaths, config);
  const registryResidues = await queryWinRegistryResiduePaths(registeredPaths, config);
  const productNamespaceRoot = resolveWinProductNamespaceRoot(config);
  const productUserDataRoot = resolveWinProductUserDataRoot();
  const builtManifest = await readBuiltAppManifest(paths, { requireExecutable: true });
  const launcherExecutablePath = builtLauncherExecutablePath(config, paths);
  const builtLauncherReady = await hasCompleteBuiltLauncherRoot(paths.launcherInstallRoot, launcherExecutablePath);
  const fallbackBuiltExecutablePath = builtManifest?.executablePath ?? ((await isNormalFile(paths.unpackedExePath)) ? paths.unpackedExePath : null);
  const builtExecutablePath = builtLauncherReady ? launcherExecutablePath : fallbackBuiltExecutablePath;
  return {
    current: {
      builtExecutableExists: builtExecutablePath != null,
      builtExecutablePath,
      builtManifestPath: paths.builtManifestPath,
      installDir: registeredPaths.installDir,
      installedExeExists: await pathExists(registeredPaths.installedExePath),
      installedExePath: registeredPaths.installedExePath,
      namespace: config.namespace,
      publicDesktopShortcutExists: await pathExists(paths.publicDesktopShortcutPath),
      publicDesktopShortcutPath: paths.publicDesktopShortcutPath,
      productNamespaceRoot,
      productNamespaceRootExists: await pathExists(productNamespaceRoot),
      productUserDataRoot,
      productUserDataRootExists: await pathExists(productUserDataRoot),
      registryEntries,
      registryResidues,
      removalPlan: await createWinRemovalPlan(config),
      runtimeNamespaceRoot: config.roots.runtime.namespaceRoot,
      runtimeNamespaceRootExists: await pathExists(config.roots.runtime.namespaceRoot),
      setupExists: await pathExists(paths.setupPath),
      setupPath: paths.setupPath,
      startMenuShortcutExists: await pathExists(paths.startMenuShortcutPath),
      startMenuShortcutPath: paths.startMenuShortcutPath,
      uninstallerExists: await pathExists(registeredPaths.uninstallerPath),
      uninstallerPath: registeredPaths.uninstallerPath,
      userDesktopShortcutExists: await pathExists(paths.userDesktopShortcutPath),
      userDesktopShortcutPath: paths.userDesktopShortcutPath,
    },
    outputNamespaces: await listDirectories(join(config.roots.output.platformRoot, "namespaces")),
    runtimeNamespaces: await listDirectories(config.roots.runtime.namespaceBaseRoot),
  };
}

export async function resetPackedWinNamespaces(config: ToolPackConfig): Promise<WinResetResult> {
  const namespaces = [...new Set([...(await listDirectories(join(config.roots.output.platformRoot, "namespaces"))), ...(await listDirectories(config.roots.runtime.namespaceBaseRoot))])].sort();
  const results: WinCleanupResult[] = [];
  for (const namespace of namespaces) {
    results.push(await cleanupPackedWinNamespace({ ...config, namespace, roots: {
      ...config.roots,
      output: { ...config.roots.output, namespaceRoot: join(config.roots.output.platformRoot, "namespaces", namespace) },
      runtime: { ...config.roots.runtime, namespaceRoot: join(config.roots.runtime.namespaceBaseRoot, namespace) },
    } }));
  }
  return { namespaces, results };
}

function resolveUpdateAction(value: string | undefined): "status" | "check" | "download" | "install" | null {
  if (value == null) return null;
  if (value === "status" || value === "check" || value === "download" || value === "install") return value;
  throw new Error("--update-action must be status, check, download, or install");
}

export async function inspectPackedWinApp(config: ToolPackConfig, options: { expr?: string; path?: string; updateAction?: string }): Promise<WinInspectResult> {
  const endpoint = await desktopEndpoint(config);
  const requireEndpoint = (): string => {
    if (endpoint == null) throw new Error("desktop control endpoint is not available");
    return endpoint;
  };
  const status = endpoint == null
    ? null
    : await requestJsonControl<DesktopStatusSnapshot>(endpoint, { type: SIDECAR_MESSAGES.STATUS }, { timeoutMs: 2000 }).catch(() => null);
  const updateAction = resolveUpdateAction(options.updateAction);
  return {
    ...(options.expr == null ? {} : {
      eval: await requestJsonControl<DesktopEvalResult>(
        requireEndpoint(),
        { input: { expression: options.expr }, type: SIDECAR_MESSAGES.EVAL },
        { timeoutMs: 5000 },
      ),
    }),
    ...(options.path == null ? {} : {
      screenshot: await requestJsonControl<DesktopScreenshotResult>(
        requireEndpoint(),
        { input: { path: options.path }, type: SIDECAR_MESSAGES.SCREENSHOT },
        { timeoutMs: 10000 },
      ),
    }),
    ...(updateAction == null ? {} : {
      update: await requestJsonControl<DesktopUpdateResult>(
        requireEndpoint(),
        { input: { action: updateAction }, type: SIDECAR_MESSAGES.UPDATE },
        { timeoutMs: UPDATE_ACTION_TIMEOUT_MS },
      ),
    }),
    status,
  };
}
