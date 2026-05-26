import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { writeLauncherOperationObservation } from "./launcher-payload-apply.js";

type LaunchLauncherSelfUpdateHelper = (
  command: string,
  args: string[],
  options: { cwd: string; windowsHide: true },
) => Promise<{ stderr: string; stdout: string }>;

export type LauncherSelfUpdateInput = {
  candidatePath: string;
  installRoot: string;
  launchHelper?: LaunchLauncherSelfUpdateHelper;
  lockPath: string;
  namespace: string;
  now?: () => Date;
  platform?: string;
  targetPath: string;
};

export type LauncherSelfUpdateScheduleResult =
  | {
    helperPath: string;
    latestSummaryPath: string;
    launcherPath: string;
    logPath: string;
    ok: true;
    summaryPath: string;
  }
  | {
    latestSummaryPath?: string;
    ok: false;
    reason: "unsupported-platform";
    summaryPath?: string;
  };

const HELPER_DIR_NAME = "helpers";
const LAUNCHER_DIR_NAME = "launcher";
const VERSIONS_DIR_NAME = "versions";
const execFileAsync = promisify(execFile) as LaunchLauncherSelfUpdateHelper;

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
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

function normalizeVersionSegment(value: string): string {
  const version = value.trim();
  if (version.length === 0) throw new Error("launcher self-update version must not be empty");
  if (
    version !== value ||
    /[<>:"/\\|?*\x00-\x1f\s]/.test(version) ||
    version === "." ||
    version === ".." ||
    version.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(version)
  ) {
    throw new Error(`launcher self-update version must be a safe path segment: ${value}`);
  }
  return version;
}

function safeWindowsExecutableName(value: string, label: string): string {
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
    throw new Error(`${label} must be a safe Windows executable name: ${value}`);
  }
  if (!trimmed.toLowerCase().endsWith(".exe")) {
    throw new Error(`${label} must be a Windows executable: ${value}`);
  }
  return trimmed;
}

function observationFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[^0-9A-Za-z._-]+/g, "-");
}

function windowsPowerShellCommand(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function assertTopLevelLauncherTarget(installRoot: string, targetPath: string): void {
  if (!containsPath(installRoot, targetPath)) throw new Error(`launcher self-update target escaped install root: ${targetPath}`);
  if (dirname(targetPath) !== installRoot) {
    throw new Error(`launcher self-update target must be a top-level install-root file: ${targetPath}`);
  }
  safeWindowsExecutableName(basename(targetPath), "launcher self-update target file name");
}

function assertVersionLauncherCandidate(input: {
  candidatePath: string;
  installRoot: string;
  targetPath: string;
}): void {
  const targetName = safeWindowsExecutableName(basename(input.targetPath), "launcher self-update target file name");
  const candidateName = basename(input.candidatePath);
  if (candidateName !== targetName) {
    throw new Error(`launcher self-update candidate file name must match target launcher file name ${targetName}: ${input.candidatePath}`);
  }
  const segments = relative(input.installRoot, input.candidatePath).split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (
    segments.length !== 4 ||
    segments[0] !== VERSIONS_DIR_NAME ||
    segments[2] !== LAUNCHER_DIR_NAME ||
    segments[3] !== targetName
  ) {
    throw new Error(`launcher self-update candidate must be under versions/<version>/launcher/${targetName}: ${input.candidatePath}`);
  }
  normalizeVersionSegment(segments[1] ?? "");
}

export function buildLauncherSelfUpdateHelperScript(): string {
  return String.raw`param(
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,

  [Parameter(Mandatory = $true)]
  [string]$LockPath,

  [Parameter(Mandatory = $true)]
  [string]$Namespace,

  [Parameter(Mandatory = $true)]
  [string]$CandidatePath,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath,

  [Parameter(Mandatory = $true)]
  [string]$SummaryPath,

  [Parameter(Mandatory = $true)]
  [string]$LatestSummaryPath,

  [Parameter(Mandatory = $true)]
  [string]$LogPath
)

$ErrorActionPreference = "Stop"
$lockHeld = $false

function Convert-ToExtendedLengthPath {
  param([string]$Path)
  $absolutePath = $Path
  if (-not [System.IO.Path]::IsPathRooted($absolutePath)) {
    $absolutePath = Join-Path -Path (Get-Location).Path -ChildPath $absolutePath
  }
  if ($absolutePath.StartsWith("\\?\")) {
    return $absolutePath
  }
  if ($absolutePath.StartsWith("\\")) {
    return "\\?\UNC\" + $absolutePath.Substring(2)
  }
  return "\\?\" + $absolutePath
}

function Write-HelperLog {
  param([string]$Message)
  try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.Directory]::CreateDirectory((Convert-ToExtendedLengthPath (Split-Path -Parent $LogPath))) | Out-Null
    [System.IO.File]::AppendAllText(
      (Convert-ToExtendedLengthPath $LogPath),
      ("{0:o} {1}{2}" -f (Get-Date), $Message, [Environment]::NewLine),
      $utf8NoBom
    )
  } catch {
  }
}

function Write-Summary {
  param(
    [string]$Status,
    [string]$ErrorMessage,
    [hashtable]$Details
  )

  try {
    $summary = [ordered]@{
      createdAt = (Get-Date).ToUniversalTime().ToString("o")
      installRoot = $InstallRoot
      kind = "launcher_operation_observation"
      namespace = $Namespace
      operation = "launcher-self-update"
      schemaVersion = 1
      status = $Status
    }
    if ($null -ne $Details) {
      $summary.details = $Details
    }
    if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) {
      $summary.error = $ErrorMessage
    }
    $json = $summary | ConvertTo-Json -Depth 8
    $utf8NoBom = New-Object System.Text.UTF8Encoding -ArgumentList $false
    [System.IO.Directory]::CreateDirectory((Convert-ToExtendedLengthPath (Split-Path -Parent $SummaryPath))) | Out-Null
    [System.IO.File]::WriteAllText((Convert-ToExtendedLengthPath $SummaryPath), $json, $utf8NoBom)
    [System.IO.File]::WriteAllText((Convert-ToExtendedLengthPath $LatestSummaryPath), $json, $utf8NoBom)
  } catch {
    Write-HelperLog ("summary write failed: {0}" -f $_.Exception.Message)
  }
}

function Test-ExclusiveFileAccess {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  $stream = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } finally {
    if ($null -ne $stream) {
      $stream.Close()
    }
  }
}

try {
  Write-HelperLog ("launcher self-update start candidate={0} target={1}" -f $CandidatePath, $TargetPath)
  if (-not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) {
    throw ("candidate launcher does not exist: {0}" -f $CandidatePath)
  }

  try {
    New-Item -ItemType Directory -Path $LockPath -ErrorAction Stop | Out-Null
    $lockHeld = $true
  } catch {
    throw ("launcher install root lock is already held at {0}" -f $LockPath)
  }

  $owner = [ordered]@{
    namespace = $Namespace
    operation = "launcher-self-update"
    pid = $PID
    schemaVersion = 1
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json -Depth 4
  Set-Content -LiteralPath (Join-Path $LockPath "owner.json") -Value $owner -Encoding UTF8

  Test-ExclusiveFileAccess -Path $TargetPath
  $suffix = "{0}-{1}" -f $PID, ([Guid]::NewGuid().ToString("N"))
  $temporaryPath = Join-Path (Split-Path -Parent $TargetPath) (".{0}.{1}.new" -f (Split-Path -Leaf $TargetPath), $suffix)
  $backupPath = Join-Path (Split-Path -Parent $TargetPath) (".{0}.{1}.old" -f (Split-Path -Leaf $TargetPath), $suffix)

  Copy-Item -LiteralPath $CandidatePath -Destination $temporaryPath -Force
  if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
    Move-Item -LiteralPath $TargetPath -Destination $backupPath -Force
  }

  try {
    Move-Item -LiteralPath $temporaryPath -Destination $TargetPath -Force
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  } catch {
    if ((-not (Test-Path -LiteralPath $TargetPath)) -and (Test-Path -LiteralPath $backupPath)) {
      Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force
    }
    throw
  }

  Write-Summary -Status "ok" -ErrorMessage "" -Details @{
    candidatePath = $CandidatePath
    targetPath = $TargetPath
  }
  Write-HelperLog "launcher self-update completed"
} catch {
  $message = $_.Exception.Message
  Write-HelperLog ("launcher self-update failed: {0}" -f $message)
  Write-Summary -Status "failed" -ErrorMessage $message -Details @{
    candidatePath = $CandidatePath
    targetPath = $TargetPath
  }
  exit 1
} finally {
  if ($lockHeld) {
    Remove-Item -LiteralPath $LockPath -Force -Recurse -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
}

function buildLauncherSelfUpdateLauncherScript(): string {
  return String.raw`param(
  [Parameter(Mandatory = $true)]
  [string]$PowerShellPath,

  [Parameter(Mandatory = $true)]
  [string]$HelperPath,

  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,

  [Parameter(Mandatory = $true)]
  [string]$LockPath,

  [Parameter(Mandatory = $true)]
  [string]$Namespace,

  [Parameter(Mandatory = $true)]
  [string]$CandidatePath,

  [Parameter(Mandatory = $true)]
  [string]$TargetPath,

  [Parameter(Mandatory = $true)]
  [string]$SummaryPath,

  [Parameter(Mandatory = $true)]
  [string]$LatestSummaryPath,

  [Parameter(Mandatory = $true)]
  [string]$LogPath
)

$ErrorActionPreference = "Stop"

function Quote-WindowsPowerShellArgument {
  param([string]$Value)
  return '"' + ($Value -replace '"', '\\"') + '"'
}

try {
  $arguments = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    (Quote-WindowsPowerShellArgument $HelperPath),
    "-InstallRoot",
    (Quote-WindowsPowerShellArgument $InstallRoot),
    "-LockPath",
    (Quote-WindowsPowerShellArgument $LockPath),
    "-Namespace",
    (Quote-WindowsPowerShellArgument $Namespace),
    "-CandidatePath",
    (Quote-WindowsPowerShellArgument $CandidatePath),
    "-TargetPath",
    (Quote-WindowsPowerShellArgument $TargetPath),
    "-SummaryPath",
    (Quote-WindowsPowerShellArgument $SummaryPath),
    "-LatestSummaryPath",
    (Quote-WindowsPowerShellArgument $LatestSummaryPath),
    "-LogPath",
    (Quote-WindowsPowerShellArgument $LogPath)
  ) -join " "
  Start-Process -FilePath $PowerShellPath -WindowStyle Hidden -WorkingDirectory $InstallRoot -ArgumentList $arguments
} finally {
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
}

export async function scheduleLauncherSelfUpdate(input: LauncherSelfUpdateInput): Promise<LauncherSelfUpdateScheduleResult> {
  const now = input.now ?? (() => new Date());
  const platform = input.platform ?? process.platform;
  const launchHelper = input.launchHelper ?? execFileAsync;
  const installRoot = assertAbsolutePath(input.installRoot, "launcher install root");
  const lockPath = assertAbsolutePath(input.lockPath, "launcher install lock path");
  const candidatePath = assertAbsolutePath(input.candidatePath, "launcher self-update candidate path");
  const targetPath = assertAbsolutePath(input.targetPath, "launcher self-update target path");

  if (!containsPath(installRoot, lockPath)) throw new Error(`launcher lock path escaped install root: ${lockPath}`);
  if (!containsPath(installRoot, candidatePath)) throw new Error(`launcher self-update candidate escaped install root: ${candidatePath}`);
  assertExpectedInstallRootPath(lockPath, expectedInstallRootPath(installRoot, "state", "lock"), "launcher lock path");
  assertTopLevelLauncherTarget(installRoot, targetPath);
  assertVersionLauncherCandidate({ candidatePath, installRoot, targetPath });

  if (platform !== "win32") {
    const observation = await writeLauncherOperationObservation({
      details: { platform },
      installRoot,
      namespace: input.namespace,
      now,
      operation: "launcher-self-update",
      status: "skipped",
    }).catch(() => null);
    return {
      ...(observation == null ? {} : observation),
      ok: false,
      reason: "unsupported-platform",
    };
  }

  try {
    const candidate = await lstat(candidatePath);
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      throw new Error(`launcher self-update candidate is not a normal file: ${candidatePath}`);
    }

    const observationRoot = join(installRoot, "logs", "updater");
    const helperRoot = join(observationRoot, HELPER_DIR_NAME);
    const createdAt = now();
    const suffix = `${createdAt.getTime().toString(36)}-${randomUUID()}`;
    const helperPath = join(helperRoot, `launcher-self-update-${suffix}.ps1`);
    const launcherPath = join(helperRoot, `launcher-self-update-${suffix}.launcher.ps1`);
    const helperRelativePath = relative(installRoot, helperPath);
    const launcherRelativePath = relative(installRoot, launcherPath);
    const logPath = join(observationRoot, "launcher-self-update.log");
    const summaryPath = join(observationRoot, `${observationFileTimestamp(createdAt)}-launcher-self-update-${process.pid}-${randomUUID()}.json`);
    const latestSummaryPath = join(observationRoot, "latest-launcher-self-update.json");
    const logRelativePath = relative(installRoot, logPath);
    const summaryRelativePath = relative(installRoot, summaryPath);
    const latestSummaryRelativePath = relative(installRoot, latestSummaryPath);
    for (const path of [helperPath, launcherPath, logPath, summaryPath, latestSummaryPath]) {
      if (!containsPath(installRoot, path)) throw new Error(`launcher self-update helper path escaped install root: ${path}`);
    }

    await mkdir(helperRoot, { recursive: true });
    await writeFile(helperPath, buildLauncherSelfUpdateHelperScript(), "utf8");
    await writeFile(launcherPath, buildLauncherSelfUpdateLauncherScript(), "utf8");

    const powerShellPath = windowsPowerShellCommand();
    await launchHelper(powerShellPath, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherRelativePath,
      "-PowerShellPath",
      powerShellPath,
      "-HelperPath",
      helperRelativePath,
      "-InstallRoot",
      installRoot,
      "-LockPath",
      lockPath,
      "-Namespace",
      input.namespace,
      "-CandidatePath",
      candidatePath,
      "-TargetPath",
      targetPath,
      "-SummaryPath",
      summaryRelativePath,
      "-LatestSummaryPath",
      latestSummaryRelativePath,
      "-LogPath",
      logRelativePath,
    ], { cwd: installRoot, windowsHide: true });

    return {
      helperPath,
      latestSummaryPath,
      launcherPath,
      logPath,
      ok: true,
      summaryPath,
    };
  } catch (error) {
    await writeLauncherOperationObservation({
      details: {
        candidatePath,
        targetPath,
      },
      error: error instanceof Error ? error.message : String(error),
      installRoot,
      namespace: input.namespace,
      now,
      operation: "launcher-self-update",
      status: "failed",
    }).catch(() => undefined);
    throw error;
  }
}
