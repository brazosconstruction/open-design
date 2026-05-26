import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { writeLauncherOperationObservation } from "./launcher-payload-apply.js";

const INSTALL_LOCK_OWNER_SCHEMA_VERSION = 1;
const INSTALL_METADATA_SCHEMA_VERSION = 1;
const LAUNCHER_CONFIG_SCHEMA_VERSION = 1;
const PRODUCT_NAME = "Open Design";
const REGISTRY_RECONCILE_TIMEOUT_MS = 5_000;
const ATTEMPT_PATH = "state/attempt.json";
const RUNTIME_PATH = "runtime.json";
const RUNTIME_NAMESPACE_ROOT = ".";
const SEVEN_ZIP_RELATIVE_PATH = "lib/7z/7z.exe";
const SEVEN_ZIP_DLL_RELATIVE_PATH = "lib/7z/7z.dll";
const SHORTCUT_RECONCILE_TIMEOUT_MS = 10_000;
const VERSIONS_ROOT = "versions";

type ExecFileOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  windowsHide: true;
};

export type LauncherReconcileExecFile = (
  command: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stderr: string; stdout: string }>;

export type LauncherReconcileInput = {
  currentVersion: string;
  execFile?: LauncherReconcileExecFile;
  installMetadataPath: string;
  installRoot: string;
  launcherConfigPath: string;
  lockPath: string;
  namespace: string;
  now?: () => Date;
  platform?: string;
  runtimeConfigPath: string;
};

export type LauncherReconcileResult =
  | {
    appPathsKey: string;
    displayName: string;
    displayVersion: string;
    ensured: string[];
    launcherPath: string;
    latestSummaryPath?: string;
    launcherConfigChanged: boolean;
    launcherConfigPath: string;
    metadataChanged: boolean;
    ok: true;
    registryKey: string;
    sevenZipDllPath: string;
    sevenZipPath: string;
    shortcutCommand?: string;
    shortcutStdout?: string;
    summaryPath?: string;
  }
  | {
    latestSummaryPath?: string;
    ok: false;
    reason: "unsupported-platform";
    summaryPath?: string;
  };

type LauncherInstallMetadata = Record<string, unknown> & {
  currentVersion?: string;
  displayName?: string;
  exeName?: string;
  helpers?: {
    sevenZip?: string;
    sevenZipDll?: string;
  };
  launcher?: {
    executable?: string;
  };
  namespace?: string;
  runtimePath?: string;
  schemaVersion?: number;
  versionsRoot?: string;
};

type LauncherConfig = Record<string, unknown> & {
  attemptPath?: string;
  runtimePath?: string;
  schemaVersion?: number;
};

type RuntimeConfigLike = Record<string, unknown> & {
  active?: {
    version?: string;
  };
  lastSuccessful?: {
    version?: string;
  };
  namespace?: string;
  namespaceRoot?: string;
  schemaVersion?: number;
};

type ExpectedLauncherMetadata = {
  appPathsKey: string;
  displayName: string;
  displayVersion: string;
  exeName: string;
  installRoot: string;
  launcherPath: string;
  registryKey: string;
  sevenZipDllPath: string;
  sevenZipPath: string;
  shortcutName: string;
  uninstallerPath: string;
};

const execFileAsync = promisify(execFile) as LauncherReconcileExecFile;

const SHORTCUT_RECONCILE_SCRIPT = String.raw`param(
  [string]$InstallRoot,
  [string]$LauncherPath,
  [string]$ShortcutName
)

$ErrorActionPreference = "Stop"
$shell = New-Object -ComObject WScript.Shell
$icon = "$LauncherPath,0"
$results = @()

function Set-LauncherShortcut {
  param(
    [string]$Kind,
    [string]$Directory,
    [bool]$CreateIfMissing
  )

  if ([string]::IsNullOrWhiteSpace($Directory)) {
    return [pscustomobject]@{ kind = $Kind; status = "skipped"; reason = "folder-missing" }
  }

  $shortcutPath = Join-Path $Directory $ShortcutName
  $exists = Test-Path -LiteralPath $shortcutPath
  if (-not $exists -and -not $CreateIfMissing) {
    return [pscustomobject]@{ kind = $Kind; path = $shortcutPath; status = "skipped"; reason = "shortcut-missing" }
  }

  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $changed = -not $exists
  if ($shortcut.TargetPath -ne $LauncherPath) {
    $shortcut.TargetPath = $LauncherPath
    $changed = $true
  }
  if ($shortcut.WorkingDirectory -ne $InstallRoot) {
    $shortcut.WorkingDirectory = $InstallRoot
    $changed = $true
  }
  if ($shortcut.IconLocation -ne $icon) {
    $shortcut.IconLocation = $icon
    $changed = $true
  }
  $shortcut.Save()
  return [pscustomobject]@{ changed = $changed; kind = $Kind; path = $shortcutPath; status = "ok" }
}

$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$results += Set-LauncherShortcut -Kind "desktop" -Directory $desktop -CreateIfMissing:$false
$results += Set-LauncherShortcut -Kind "start-menu" -Directory $programs -CreateIfMissing:$true
$results | ConvertTo-Json -Compress
`;

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function sanitizeNamespace(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function safeFileName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${label} must not be empty`);
  if (
    trimmed !== value ||
    /[<>:"/\\|?*\x00-\x1f]/.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(trimmed)
  ) {
    throw new Error(`${label} must be a safe Windows file name: ${value}`);
  }
  return trimmed;
}

function assertAbsolutePath(path: string, label: string): string {
  if (path.includes("\0")) throw new Error(`${label} must not contain null bytes`);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute: ${path}`);
  return resolve(path);
}

function expectedInstallRootPath(installRoot: string, ...segments: string[]): string {
  return resolve(installRoot, ...segments);
}

function assertExpectedInstallRootPath(actualPath: string, expectedPath: string, label: string): void {
  if (actualPath !== expectedPath) {
    throw new Error(`${label} must be the install-root path ${expectedPath}: ${actualPath}`);
  }
}

async function isNormalFile(path: string): Promise<boolean> {
  const metadata = await lstat(path).catch(() => null);
  return metadata != null && metadata.isFile() && !metadata.isSymbolicLink();
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function isRuntimeConfigLike(value: unknown): value is RuntimeConfigLike {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  return (
    typeof value.namespace === "string" &&
    value.namespace.length > 0 &&
    value.namespaceRoot === RUNTIME_NAMESPACE_ROOT
  );
}

function requireInstallMetadata(value: unknown, installMetadataPath: string): LauncherInstallMetadata {
  if (!isRecord(value) || value.schemaVersion !== INSTALL_METADATA_SCHEMA_VERSION) {
    throw new Error(`launcher install metadata is missing or invalid: ${installMetadataPath}`);
  }
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) {
    throw new Error(`launcher install metadata is missing displayName: ${installMetadataPath}`);
  }
  return value as LauncherInstallMetadata;
}

function assertInstallMetadataNamespace(input: {
  installMetadataPath: string;
  metadata: LauncherInstallMetadata;
  namespace: string;
}): void {
  if (input.metadata.namespace == null) return;
  if (typeof input.metadata.namespace !== "string" || input.metadata.namespace.length === 0) {
    throw new Error(`launcher install metadata namespace is invalid: ${input.installMetadataPath}`);
  }
  if (input.metadata.namespace !== input.namespace) {
    throw new Error(`launcher install metadata namespace mismatch: expected ${input.namespace}, got ${input.metadata.namespace}`);
  }
}

function buildExpectedMetadata(input: {
  currentVersion: string;
  installRoot: string;
  metadata: LauncherInstallMetadata;
  namespace: string;
}): ExpectedLauncherMetadata {
  const displayName = input.metadata.displayName?.trim() ?? "";
  const exeName = safeFileName(`${displayName}.exe`, "launcher displayName");
  const launcherPath = join(input.installRoot, exeName);
  const sevenZipDllPath = join(input.installRoot, "lib", "7z", "7z.dll");
  const sevenZipPath = join(input.installRoot, "lib", "7z", "7z.exe");
  return {
    appPathsKey: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`,
    displayName,
    displayVersion: input.currentVersion,
    exeName,
    installRoot: input.installRoot,
    launcherPath,
    registryKey: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}-${sanitizeNamespace(input.namespace)}`,
    sevenZipDllPath,
    sevenZipPath,
    shortcutName: `${displayName}.lnk`,
    uninstallerPath: join(input.installRoot, `Uninstall ${displayName}.exe`),
  };
}

function reconcileInstallMetadata(input: {
  expected: ExpectedLauncherMetadata;
  metadata: LauncherInstallMetadata;
  namespace: string;
}): { changed: boolean; ensured: string[]; next: LauncherInstallMetadata } {
  const ensured: string[] = [];
  const next: LauncherInstallMetadata = {
    ...input.metadata,
    helpers: isRecord(input.metadata.helpers) ? { ...input.metadata.helpers } : {},
    launcher: isRecord(input.metadata.launcher) ? { ...input.metadata.launcher } : {},
  };
  const set = <K extends keyof LauncherInstallMetadata>(key: K, value: LauncherInstallMetadata[K], label: string) => {
    if (next[key] !== value) {
      next[key] = value;
      ensured.push(label);
    }
  };

  set("currentVersion", input.expected.displayVersion, "install-metadata.currentVersion");
  set("displayName", input.expected.displayName, "install-metadata.displayName");
  set("exeName", input.expected.exeName, "install-metadata.exeName");
  set("namespace", input.namespace, "install-metadata.namespace");
  set("runtimePath", RUNTIME_PATH, "install-metadata.runtimePath");
  set("schemaVersion", INSTALL_METADATA_SCHEMA_VERSION, "install-metadata.schemaVersion");
  set("versionsRoot", VERSIONS_ROOT, "install-metadata.versionsRoot");

  if (next.launcher?.executable !== input.expected.exeName) {
    next.launcher = { executable: input.expected.exeName };
    ensured.push("install-metadata.launcher");
  }
  const helpers = isRecord(next.helpers) ? { ...next.helpers } : {};
  if (helpers.sevenZip !== SEVEN_ZIP_RELATIVE_PATH) {
    helpers.sevenZip = SEVEN_ZIP_RELATIVE_PATH;
    ensured.push("install-metadata.helpers.sevenZip");
  }
  if (helpers.sevenZipDll !== SEVEN_ZIP_DLL_RELATIVE_PATH) {
    helpers.sevenZipDll = SEVEN_ZIP_DLL_RELATIVE_PATH;
    ensured.push("install-metadata.helpers.sevenZipDll");
  }
  next.helpers = helpers;

  return { changed: ensured.length > 0, ensured, next };
}

function reconcileLauncherConfig(value: unknown): { changed: boolean; ensured: string[]; next: LauncherConfig } {
  const ensured: string[] = [];
  const next: LauncherConfig = isRecord(value) ? { ...value } : {};
  const set = <K extends keyof LauncherConfig>(key: K, nextValue: LauncherConfig[K], label: string) => {
    if (next[key] !== nextValue) {
      next[key] = nextValue;
      ensured.push(label);
    }
  };

  set("attemptPath", ATTEMPT_PATH, "launcher-config.attemptPath");
  set("runtimePath", RUNTIME_PATH, "launcher-config.runtimePath");
  set("schemaVersion", LAUNCHER_CONFIG_SCHEMA_VERSION, "launcher-config.schemaVersion");
  return { changed: ensured.length > 0, ensured, next };
}

async function withInstallRootLock<T>(input: {
  installRoot: string;
  lockPath: string;
  namespace: string;
  now: () => Date;
}, callback: () => Promise<T>): Promise<T> {
  await mkdir(dirname(input.lockPath), { recursive: true });
  try {
    await mkdir(input.lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`launcher install root lock is already held at ${input.lockPath}`);
    throw error;
  }

  try {
    await writeJsonAtomic(join(input.lockPath, "owner.json"), {
      namespace: input.namespace,
      operation: "reconcile",
      pid: process.pid,
      schemaVersion: INSTALL_LOCK_OWNER_SCHEMA_VERSION,
      startedAt: input.now().toISOString(),
    });
    return await callback();
  } finally {
    await rm(input.lockPath, { force: true, recursive: true });
  }
}

async function regAddString(input: {
  cwd: string;
  execFile: LauncherReconcileExecFile;
  key: string;
  name: string | null;
  value: string;
}): Promise<void> {
  const args = input.name == null
    ? ["add", input.key, "/ve", "/t", "REG_SZ", "/d", input.value, "/f"]
    : ["add", input.key, "/v", input.name, "/t", "REG_SZ", "/d", input.value, "/f"];
  await input.execFile("reg.exe", args, {
    cwd: input.cwd,
    env: process.env,
    timeout: REGISTRY_RECONCILE_TIMEOUT_MS,
    windowsHide: true,
  });
}

async function reconcileRegistry(input: {
  execFile: LauncherReconcileExecFile;
  expected: ExpectedLauncherMetadata;
}): Promise<string[]> {
  const ensured: string[] = [];
  await regAddString({ cwd: input.expected.installRoot, execFile: input.execFile, key: input.expected.registryKey, name: "DisplayName", value: input.expected.displayName });
  ensured.push("registry.DisplayName");
  await regAddString({ cwd: input.expected.installRoot, execFile: input.execFile, key: input.expected.registryKey, name: "DisplayVersion", value: input.expected.displayVersion });
  ensured.push("registry.DisplayVersion");
  await regAddString({ cwd: input.expected.installRoot, execFile: input.execFile, key: input.expected.registryKey, name: "InstallLocation", value: input.expected.installRoot });
  ensured.push("registry.InstallLocation");
  await regAddString({ cwd: input.expected.installRoot, execFile: input.execFile, key: input.expected.registryKey, name: "UninstallString", value: `"${input.expected.uninstallerPath}" /currentuser` });
  ensured.push("registry.UninstallString");
  await regAddString({ cwd: input.expected.installRoot, execFile: input.execFile, key: input.expected.registryKey, name: "QuietUninstallString", value: `"${input.expected.uninstallerPath}" /currentuser /S` });
  ensured.push("registry.QuietUninstallString");
  await regAddString({ cwd: input.expected.installRoot, execFile: input.execFile, key: input.expected.registryKey, name: "DisplayIcon", value: `${input.expected.launcherPath},0` });
  ensured.push("registry.DisplayIcon");
  await regAddString({ cwd: input.expected.installRoot, execFile: input.execFile, key: input.expected.appPathsKey, name: null, value: input.expected.launcherPath });
  ensured.push("registry.AppPaths");
  return ensured;
}

async function runPowerShellScript(input: {
  args: string[];
  cwd: string;
  execFile: LauncherReconcileExecFile;
}): Promise<{ command: string; stderr: string; stdout: string }> {
  let lastError: unknown = null;
  for (const command of ["pwsh.exe", "powershell.exe"]) {
    try {
      const result = await input.execFile(command, input.args, {
        cwd: input.cwd,
        env: process.env,
        timeout: SHORTCUT_RECONCILE_TIMEOUT_MS,
        windowsHide: true,
      });
      return { command, stderr: result.stderr, stdout: result.stdout };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("failed to run PowerShell shortcut reconciliation");
}

async function reconcileShortcuts(input: {
  execFile: LauncherReconcileExecFile;
  expected: ExpectedLauncherMetadata;
}): Promise<{ command: string; stdout: string }> {
  const scriptPath = join(input.expected.installRoot, "state", `reconcile-shortcuts-${process.pid}-${randomUUID()}.ps1`);
  try {
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, SHORTCUT_RECONCILE_SCRIPT, "utf8");
    const output = await runPowerShellScript({
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-InstallRoot",
        input.expected.installRoot,
        "-LauncherPath",
        input.expected.launcherPath,
        "-ShortcutName",
        input.expected.shortcutName,
      ],
      cwd: input.expected.installRoot,
      execFile: input.execFile,
    });
    return { command: output.command, stdout: output.stdout };
  } finally {
    await rm(scriptPath, { force: true }).catch(() => undefined);
  }
}

export async function reconcileLauncherInstall(input: LauncherReconcileInput): Promise<LauncherReconcileResult> {
  const now = input.now ?? (() => new Date());
  const platform = input.platform ?? process.platform;
  const execFileImpl = input.execFile ?? execFileAsync;
  const installRoot = assertAbsolutePath(input.installRoot, "launcher install root");
  const installMetadataPath = assertAbsolutePath(input.installMetadataPath, "launcher install metadata path");
  const launcherConfigPath = assertAbsolutePath(input.launcherConfigPath, "launcher config path");
  const lockPath = assertAbsolutePath(input.lockPath, "launcher install lock path");
  const runtimeConfigPath = assertAbsolutePath(input.runtimeConfigPath, "launcher runtime config path");

  if (!containsPath(installRoot, installMetadataPath)) throw new Error(`launcher install metadata path escaped install root: ${installMetadataPath}`);
  if (!containsPath(installRoot, launcherConfigPath)) throw new Error(`launcher config path escaped install root: ${launcherConfigPath}`);
  if (!containsPath(installRoot, lockPath)) throw new Error(`launcher lock path escaped install root: ${lockPath}`);
  if (!containsPath(installRoot, runtimeConfigPath)) throw new Error(`launcher runtime config path escaped install root: ${runtimeConfigPath}`);
  assertExpectedInstallRootPath(installMetadataPath, expectedInstallRootPath(installRoot, "install.json"), "launcher install metadata path");
  assertExpectedInstallRootPath(launcherConfigPath, expectedInstallRootPath(installRoot, "launcher.json"), "launcher config path");
  assertExpectedInstallRootPath(lockPath, expectedInstallRootPath(installRoot, "state", "lock"), "launcher lock path");
  assertExpectedInstallRootPath(runtimeConfigPath, expectedInstallRootPath(installRoot, RUNTIME_PATH), "launcher runtime config path");

  if (platform !== "win32") {
    const observation = await writeLauncherOperationObservation({
      details: { platform },
      installRoot,
      namespace: input.namespace,
      now,
      operation: "reconcile",
      status: "skipped",
    }).catch(() => null);
    return {
      ...(observation == null ? {} : observation),
      ok: false,
      reason: "unsupported-platform",
    };
  }

  try {
    const result = await withInstallRootLock({
      installRoot,
      lockPath,
      namespace: input.namespace,
      now,
    }, async () => {
      const metadata = requireInstallMetadata(await readJson<unknown>(installMetadataPath), installMetadataPath);
      assertInstallMetadataNamespace({
        installMetadataPath,
        metadata,
        namespace: input.namespace,
      });
      const runtime = await readJson<unknown>(runtimeConfigPath);
      if (!isRuntimeConfigLike(runtime)) throw new Error(`launcher runtime config is missing or invalid: ${runtimeConfigPath}`);
      if (runtime.namespace !== input.namespace) {
        throw new Error(`launcher runtime namespace mismatch: expected ${input.namespace}, got ${runtime.namespace}`);
      }
      const expected = buildExpectedMetadata({
        currentVersion: input.currentVersion,
        installRoot,
        metadata,
        namespace: input.namespace,
      });
      if (!containsPath(installRoot, expected.launcherPath)) throw new Error(`launcher executable path escaped install root: ${expected.launcherPath}`);
      if (!containsPath(installRoot, expected.sevenZipDllPath)) throw new Error(`launcher 7z DLL path escaped install root: ${expected.sevenZipDllPath}`);
      if (!containsPath(installRoot, expected.sevenZipPath)) throw new Error(`launcher 7z path escaped install root: ${expected.sevenZipPath}`);
      if (!(await isNormalFile(expected.launcherPath))) throw new Error(`launcher executable is missing: ${expected.launcherPath}`);
      if (!(await isNormalFile(expected.sevenZipDllPath))) throw new Error(`launcher 7z helper DLL is missing: ${expected.sevenZipDllPath}`);
      if (!(await isNormalFile(expected.sevenZipPath))) throw new Error(`launcher 7z helper is missing: ${expected.sevenZipPath}`);

      const metadataReconcile = reconcileInstallMetadata({
        expected,
        metadata,
        namespace: input.namespace,
      });
      if (metadataReconcile.changed) {
        await writeJsonAtomic(installMetadataPath, metadataReconcile.next);
      }
      const launcherConfigReconcile = reconcileLauncherConfig(await readJson<unknown>(launcherConfigPath));
      if (launcherConfigReconcile.changed) {
        await writeJsonAtomic(launcherConfigPath, launcherConfigReconcile.next);
      }

      const registryEnsured = await reconcileRegistry({ execFile: execFileImpl, expected });
      const shortcuts = await reconcileShortcuts({ execFile: execFileImpl, expected });
      const result: LauncherReconcileResult = {
        appPathsKey: expected.appPathsKey,
        displayName: expected.displayName,
        displayVersion: expected.displayVersion,
        ensured: [
          ...metadataReconcile.ensured,
          ...launcherConfigReconcile.ensured,
          ...registryEnsured,
          "shortcut.desktop",
          "shortcut.start-menu",
        ],
        launcherConfigChanged: launcherConfigReconcile.changed,
        launcherConfigPath,
        launcherPath: expected.launcherPath,
        metadataChanged: metadataReconcile.changed,
        ok: true,
        registryKey: expected.registryKey,
        sevenZipDllPath: expected.sevenZipDllPath,
        sevenZipPath: expected.sevenZipPath,
        shortcutCommand: shortcuts.command,
        shortcutStdout: shortcuts.stdout,
      };
      return result;
    });
    const observation = await writeLauncherOperationObservation({
      details: result,
      installRoot,
      namespace: input.namespace,
      now,
      operation: "reconcile",
      status: "ok",
    }).catch(() => null);
    return {
      ...result,
      ...(observation == null ? {} : observation),
    };
  } catch (error) {
    await writeLauncherOperationObservation({
      error: error instanceof Error ? error.message : String(error),
      installRoot,
      namespace: input.namespace,
      now,
      operation: "reconcile",
      status: "failed",
    }).catch(() => undefined);
    throw error;
  }
}
