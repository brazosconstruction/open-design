import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  buildLauncherConfig,
  buildRuntimeConfig,
  type LauncherConfig,
  type RuntimeConfig,
} from "@open-design/launcher-proto";

import type { ToolPackConfig } from "../config.js";
import { winResources } from "../resources.js";
import { PRODUCT_NAME } from "./constants.js";
import { resolveWinInstallIdentity } from "./identity.js";
import type { WinBuiltAppManifest, WinPaths } from "./types.js";

const execFileAsync = promisify(execFile);
const LAUNCHER_BINARY_NAME = "open-design-launcher.exe";
const LIB_DIR_NAME = "lib";
const PAYLOAD_DIR_NAME = "payload";
const SEVEN_ZIP_DIR_NAME = "7z";
const SEVEN_ZIP_EXE_RELATIVE_PATH = toManifestRelativePath(LIB_DIR_NAME, SEVEN_ZIP_DIR_NAME, "7z.exe");
const SEVEN_ZIP_DLL_RELATIVE_PATH = toManifestRelativePath(LIB_DIR_NAME, SEVEN_ZIP_DIR_NAME, "7z.dll");
const VERSIONS_DIR_NAME = "versions";
const INSTALL_LOCK_OWNER_SCHEMA_VERSION = 1;
const CLEANUP_MARKER_SCHEMA_VERSION = 1;
const LOCK_POLL_MS = 100;
const INSTALL_ROOT_LAYER_VERSION_ENTRY_NAMES = new Set([
  "install.json",
  "launcher.json",
  "runtime.json",
  "state",
  "logs",
  "lib",
  "versions",
]);

export type WinLauncherInstallLayout = {
  attemptRelativePath: string;
  cleanupMarkerPath: string;
  installMetadataPath: string;
  launcherConfigPath: string;
  lockPath: string;
  payloadExecutablePath: string;
  payloadExecutableRelativePath: string;
  payloadManifestPath: string;
  payloadRoot: string;
  payloadRootRelativePath: string;
  publicExecutablePath: string;
  root: string;
  runtimeConfigPath: string;
  sevenZipDllPath: string;
  sevenZipExePath: string;
  sevenZipRelativePath: string;
  sevenZipRoot: string;
  stateRoot: string;
  versionRoot: string;
  versionRootRelativePath: string;
  versionLauncherPath: string;
  versionLauncherRoot: string;
  versionsRoot: string;
};

export type WinInstallLockOperation =
  | "apply-update"
  | "cleanup"
  | "launcher-self-update"
  | "reconcile"
  | "tools-pack";

export type WinInstallLockOwner = {
  namespace: string;
  operation: WinInstallLockOperation;
  pid: number;
  schemaVersion: typeof INSTALL_LOCK_OWNER_SCHEMA_VERSION;
  startedAt: string;
};

export type WinPayloadManifest = {
  entry: {
    cwd: string;
    executable: string;
  };
  payloadRoot: string;
  schemaVersion: 1;
  version: string;
};

export type WinInstallMetadata = {
  currentVersion: string;
  displayName: string;
  exeName: string;
  launcher: {
    executable: string;
  };
  helpers: {
    sevenZip: string;
    sevenZipDll: string;
  };
  namespace: string;
  runtimePath: string;
  schemaVersion: 1;
  versionsRoot: string;
};

export type WinCleanupMarker = {
  createdAt: string;
  namespace: string;
  readyVersion: string;
  schemaVersion: typeof CLEANUP_MARKER_SCHEMA_VERSION;
  strategy: "lazyQuickDelete";
  versions: Array<{
    root: string;
    version: string;
  }>;
};

export type WinAssembleLauncherInstallRootInput = {
  builtApp: WinBuiltAppManifest;
  config: Pick<ToolPackConfig, "appVersion" | "namespace" | "workspaceRoot">;
  launcherExecutablePath: string;
  packagedVersion: string;
  paths: Pick<WinPaths, "launcherInstallRoot">;
};

export type WinWriteLauncherUpdatePayloadInput = {
  layout: Pick<WinLauncherInstallLayout, "versionRoot">;
  paths: Pick<WinPaths, "updatePayloadPath">;
};

function toManifestRelativePath(...segments: string[]): string {
  return segments.join("/");
}

function normalizeVersionSegment(value: string): string {
  const version = value.trim();
  if (version.length === 0) throw new Error("launcher packaged version must not be empty");
  if (
    version !== value ||
    /[<>:"/\\|?*\x00-\x1f\s]/.test(version) ||
    version === "." ||
    version === ".." ||
    version.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(version)
  ) {
    throw new Error(`launcher packaged version must be a safe path segment: ${value}`);
  }
  return version;
}

export function resolveWinLauncherInstallLayout(
  config: Pick<ToolPackConfig, "appVersion" | "namespace">,
  paths: Pick<WinPaths, "launcherInstallRoot">,
  packagedVersion: string,
): WinLauncherInstallLayout {
  const version = normalizeVersionSegment(packagedVersion);
  const identity = resolveWinInstallIdentity(config);
  const versionRootRelativePath = toManifestRelativePath(VERSIONS_DIR_NAME, version);
  const payloadRootRelativePath = toManifestRelativePath(versionRootRelativePath, PAYLOAD_DIR_NAME);
  const payloadExecutableRelativePath = toManifestRelativePath(PAYLOAD_DIR_NAME, `${PRODUCT_NAME}.exe`);
  const versionRoot = join(paths.launcherInstallRoot, VERSIONS_DIR_NAME, version);
  const payloadRoot = join(versionRoot, PAYLOAD_DIR_NAME);
  const versionLauncherRoot = join(versionRoot, "launcher");
  const sevenZipRelativePath = SEVEN_ZIP_EXE_RELATIVE_PATH;
  const sevenZipRoot = join(paths.launcherInstallRoot, LIB_DIR_NAME, SEVEN_ZIP_DIR_NAME);
  return {
    attemptRelativePath: "state/attempt.json",
    cleanupMarkerPath: join(paths.launcherInstallRoot, "state", "cleanup.json"),
    installMetadataPath: join(paths.launcherInstallRoot, "install.json"),
    launcherConfigPath: join(paths.launcherInstallRoot, "launcher.json"),
    lockPath: join(paths.launcherInstallRoot, "state", "lock"),
    payloadExecutablePath: join(payloadRoot, `${PRODUCT_NAME}.exe`),
    payloadExecutableRelativePath,
    payloadManifestPath: join(versionRoot, "manifest.json"),
    payloadRoot,
    payloadRootRelativePath,
    publicExecutablePath: join(paths.launcherInstallRoot, identity.exeName),
    root: paths.launcherInstallRoot,
    runtimeConfigPath: join(paths.launcherInstallRoot, "runtime.json"),
    sevenZipDllPath: join(sevenZipRoot, "7z.dll"),
    sevenZipExePath: join(sevenZipRoot, "7z.exe"),
    sevenZipRelativePath,
    sevenZipRoot,
    stateRoot: join(paths.launcherInstallRoot, "state"),
    versionRoot,
    versionRootRelativePath,
    versionLauncherPath: join(versionLauncherRoot, identity.exeName),
    versionLauncherRoot,
    versionsRoot: join(paths.launcherInstallRoot, VERSIONS_DIR_NAME),
  };
}

export function buildWinLauncherConfig(layout: Pick<WinLauncherInstallLayout, "attemptRelativePath">): LauncherConfig {
  return buildLauncherConfig({
    attemptPath: layout.attemptRelativePath,
    runtimePath: "runtime.json",
  });
}

export function buildWinRuntimeConfig(
  config: Pick<ToolPackConfig, "namespace">,
  layout: Pick<WinLauncherInstallLayout, "payloadExecutableRelativePath" | "versionRootRelativePath">,
  packagedVersion: string,
): RuntimeConfig {
  const versionName = normalizeVersionSegment(packagedVersion);
  const version = {
    apps: {},
    entry: {
      args: [],
      cwd: PAYLOAD_DIR_NAME,
      env: {},
      executable: layout.payloadExecutableRelativePath,
    },
    root: layout.versionRootRelativePath,
    version: versionName,
  };
  return buildRuntimeConfig({
    active: version,
    generation: 0,
    lastSuccessful: version,
    namespace: config.namespace,
    namespaceRoot: ".",
  });
}

export function buildWinPayloadManifest(
  layout: Pick<WinLauncherInstallLayout, "payloadExecutableRelativePath">,
  packagedVersion: string,
): WinPayloadManifest {
  const version = normalizeVersionSegment(packagedVersion);
  return {
    entry: {
      cwd: PAYLOAD_DIR_NAME,
      executable: layout.payloadExecutableRelativePath,
    },
    payloadRoot: PAYLOAD_DIR_NAME,
    schemaVersion: 1,
    version,
  };
}

export function createWinLauncherBuiltAppManifest(
  builtApp: WinBuiltAppManifest,
  layout: Pick<WinLauncherInstallLayout, "payloadRoot" | "publicExecutablePath">,
): Omit<WinBuiltAppManifest, "version"> {
  return {
    ...builtApp,
    executablePath: layout.publicExecutablePath,
    source: "namespace",
    unpackedRoot: layout.payloadRoot,
  };
}

export async function writeWinLauncherJsonFileAtomic(filePath: string, payload: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export function buildWinInstallMetadata(
  config: Pick<ToolPackConfig, "appVersion" | "namespace">,
  packagedVersion: string,
): WinInstallMetadata {
  const version = normalizeVersionSegment(packagedVersion);
  const identity = resolveWinInstallIdentity(config);
  return {
    currentVersion: version,
    displayName: identity.displayName,
    exeName: identity.exeName,
    launcher: {
      executable: identity.exeName,
    },
    helpers: {
      sevenZip: SEVEN_ZIP_EXE_RELATIVE_PATH,
      sevenZipDll: SEVEN_ZIP_DLL_RELATIVE_PATH,
    },
    namespace: config.namespace,
    runtimePath: "runtime.json",
    schemaVersion: 1,
    versionsRoot: VERSIONS_DIR_NAME,
  };
}

export function buildWinInstallLockOwner(
  config: Pick<ToolPackConfig, "namespace">,
  operation: WinInstallLockOperation,
  now = new Date(),
): WinInstallLockOwner {
  return {
    namespace: config.namespace,
    operation,
    pid: process.pid,
    schemaVersion: INSTALL_LOCK_OWNER_SCHEMA_VERSION,
    startedAt: now.toISOString(),
  };
}

export async function withWinLauncherInstallLock<T>(
  layout: Pick<WinLauncherInstallLayout, "lockPath">,
  owner: WinInstallLockOwner,
  callback: () => Promise<T>,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const timeoutMs = options.timeoutMs ?? 0;
  const startedAt = Date.now();
  await mkdir(dirname(layout.lockPath), { recursive: true });

  while (true) {
    try {
      await mkdir(layout.lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`install root lock is already held at ${layout.lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    await writeWinLauncherJsonFileAtomic(join(layout.lockPath, "owner.json"), owner);
    return await callback();
  } finally {
    await rm(layout.lockPath, { force: true, recursive: true });
  }
}

export function buildWinReadyCleanupMarker(
  config: Pick<ToolPackConfig, "namespace">,
  input: { deleteVersions: readonly string[]; readyVersion: string },
  now = new Date(),
): WinCleanupMarker {
  const readyVersion = normalizeVersionSegment(input.readyVersion);
  const uniqueVersions = [
    ...new Set(
      input.deleteVersions
        .filter((version) => version.trim().length > 0)
        .map((version) => normalizeVersionSegment(version)),
    ),
  ];
  if (uniqueVersions.includes(readyVersion)) {
    throw new Error(`cleanup marker must not delete the ready version: ${readyVersion}`);
  }
  return {
    createdAt: now.toISOString(),
    namespace: config.namespace,
    readyVersion,
    schemaVersion: CLEANUP_MARKER_SCHEMA_VERSION,
    strategy: "lazyQuickDelete",
    versions: uniqueVersions.map((version) => ({
      root: toManifestRelativePath(VERSIONS_DIR_NAME, version),
      version,
    })),
  };
}

export async function writeWinCleanupMarker(
  layout: Pick<WinLauncherInstallLayout, "cleanupMarkerPath">,
  marker: WinCleanupMarker,
): Promise<void> {
  await writeWinLauncherJsonFileAtomic(layout.cleanupMarkerPath, marker);
}

export async function buildWinLauncherExecutable(
  config: Pick<ToolPackConfig, "workspaceRoot">,
  paths: Pick<WinPaths, "winIconPath">,
): Promise<string> {
  const manifestPath = join(config.workspaceRoot, "apps", "launcher", "Cargo.toml");
  const executablePath = join(config.workspaceRoot, "apps", "launcher", "target", "release", LAUNCHER_BINARY_NAME);
  await execFileAsync("cargo", ["build", "--manifest-path", manifestPath, "--release"], {
    cwd: config.workspaceRoot,
    env: {
      ...process.env,
      OD_LAUNCHER_WIN_ICON: paths.winIconPath,
    },
    windowsHide: true,
  });
  await stat(executablePath);
  return executablePath;
}

async function assertNoInstallRootLayerEntries(versionRoot: string): Promise<void> {
  const entries = await readdir(versionRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (INSTALL_ROOT_LAYER_VERSION_ENTRY_NAMES.has(entry.name.toLowerCase())) {
      throw new Error(`launcher version root must not contain install-root layer entry: ${join(versionRoot, entry.name)}`);
    }
  }
}

async function assertNoVersionScopedSevenZip(versionRoot: string): Promise<void> {
  const entries = await readdir(versionRoot, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(versionRoot, entry.name);
    const lowerName = entry.name.toLowerCase();
    if (lowerName === "7z.exe" || lowerName === "7z.dll") {
      throw new Error(`launcher version root must not contain version-scoped 7z helper: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await assertNoVersionScopedSevenZip(entryPath);
    }
  }
}

async function assertWinLauncherVersionRootShape(versionRoot: string): Promise<void> {
  await assertNoInstallRootLayerEntries(versionRoot);
  await assertNoVersionScopedSevenZip(versionRoot);
}

export async function assembleWinLauncherInstallRoot(input: WinAssembleLauncherInstallRootInput): Promise<WinLauncherInstallLayout> {
  const layout = resolveWinLauncherInstallLayout(input.config, input.paths, input.packagedVersion);
  await rm(layout.root, { force: true, recursive: true });
  await mkdir(layout.payloadRoot, { recursive: true });
  await cp(input.builtApp.unpackedRoot, layout.payloadRoot, { recursive: true });
  await mkdir(layout.versionLauncherRoot, { recursive: true });
  await mkdir(layout.stateRoot, { recursive: true });
  await mkdir(join(layout.root, "logs", "launcher"), { recursive: true });
  await mkdir(join(layout.root, "logs", "updater"), { recursive: true });
  await mkdir(layout.sevenZipRoot, { recursive: true });
  await cp(input.launcherExecutablePath, layout.publicExecutablePath);
  await cp(input.launcherExecutablePath, layout.versionLauncherPath);
  await cp(winResources.sevenZipExe, layout.sevenZipExePath);
  await cp(winResources.sevenZipDll, layout.sevenZipDllPath);
  await writeWinLauncherJsonFileAtomic(layout.installMetadataPath, buildWinInstallMetadata(input.config, input.packagedVersion));
  await writeWinLauncherJsonFileAtomic(layout.launcherConfigPath, buildWinLauncherConfig(layout));
  await writeWinLauncherJsonFileAtomic(layout.runtimeConfigPath, buildWinRuntimeConfig(input.config, layout, input.packagedVersion));
  await writeWinLauncherJsonFileAtomic(layout.payloadManifestPath, buildWinPayloadManifest(layout, input.packagedVersion));
  await assertWinLauncherVersionRootShape(layout.versionRoot);
  await stat(layout.publicExecutablePath);
  await stat(layout.versionLauncherPath);
  await stat(layout.payloadExecutablePath);
  await stat(layout.sevenZipExePath);
  await stat(layout.sevenZipDllPath);
  return layout;
}

export async function writeWinLauncherUpdatePayloadArchive(input: WinWriteLauncherUpdatePayloadInput): Promise<string> {
  await mkdir(dirname(input.paths.updatePayloadPath), { recursive: true });
  await rm(input.paths.updatePayloadPath, { force: true });
  await assertWinLauncherVersionRootShape(input.layout.versionRoot);
  await execFileAsync(winResources.sevenZipExe, ["a", "-t7z", "-mx=1", "-ms=off", input.paths.updatePayloadPath, ".\\*"], {
    cwd: input.layout.versionRoot,
    windowsHide: true,
  });
  await stat(input.paths.updatePayloadPath);
  return input.paths.updatePayloadPath;
}
