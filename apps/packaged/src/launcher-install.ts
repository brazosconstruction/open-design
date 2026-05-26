import { lstatSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

type PathApi = Pick<typeof win32, "basename" | "dirname" | "join">;

export type PackagedLauncherInstallContextOptions = {
  pathIsFile?: (path: string) => boolean;
  namespace?: string;
  pathExists?: (path: string) => boolean;
  readTextFile?: (path: string) => string;
  requireInstallRootMarkers?: boolean;
};

export type PackagedLauncherInstallContext = {
  cleanupMarkerPath: string;
  installMetadataPath: string;
  launcherConfigPath: string;
  installRoot: string;
  lockPath: string;
  payloadRoot: string;
  runtimeConfigPath: string;
  sevenZipDllPath: string;
  sevenZipPath: string;
  version: string;
  versionRoot: string;
};

type LauncherInstallMetadata = {
  currentVersion?: unknown;
  displayName?: unknown;
  exeName?: unknown;
  helpers?: unknown;
  launcher?: unknown;
  namespace?: unknown;
  runtimePath?: unknown;
  schemaVersion?: unknown;
  versionsRoot?: unknown;
};

type LauncherConfig = {
  attemptPath?: unknown;
  runtimePath?: unknown;
  schemaVersion?: unknown;
};

type RuntimeVersionDescriptor = {
  apps: Record<string, unknown>;
  entry: Record<string, unknown>;
  root: string;
  version: string;
};

type RuntimeConfig = {
  active: RuntimeVersionDescriptor;
  generation: number;
  lastSuccessful: RuntimeVersionDescriptor;
  namespace: string;
  namespaceRoot: string;
  schemaVersion: 1;
};

const RUNTIME_NAMESPACE_ROOT = ".";
const SEVEN_ZIP_RELATIVE_PATH = "lib/7z/7z.exe";
const SEVEN_ZIP_DLL_RELATIVE_PATH = "lib/7z/7z.dll";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function readJsonMarker(path: string, options: PackagedLauncherInstallContextOptions): unknown {
  try {
    const readTextFile = options.readTextFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
    return JSON.parse(readTextFile(path)) as unknown;
  } catch {
    return null;
  }
}

function defaultPathIsFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function installRootMarkerExists(path: string, options: PackagedLauncherInstallContextOptions): boolean {
  if (options.pathIsFile != null) return options.pathIsFile(path);
  if (options.pathExists != null) return options.pathExists(path);
  return defaultPathIsFile(path);
}

function safeFileName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (
    trimmed !== value ||
    /[<>:"/\\|?*\x00-\x1f]/.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function normalizeVersionSegment(value: string): string | null {
  const version = value.trim();
  if (version.length === 0) return null;
  if (
    version !== value ||
    /[<>:"/\\|?*\x00-\x1f\s]/.test(version) ||
    version === "." ||
    version === ".." ||
    version.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(version)
  ) {
    return null;
  }
  return version;
}

function launcherExecutableName(metadata: LauncherInstallMetadata): string | null {
  if (typeof metadata.displayName === "string") return safeFileName(`${metadata.displayName.trim()}.exe`);
  return null;
}

function isExpectedInstallMetadata(value: unknown, options: PackagedLauncherInstallContextOptions): value is LauncherInstallMetadata {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.currentVersion !== "string" || value.currentVersion.length === 0) return false;
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0) return false;
  if (value.runtimePath !== "runtime.json") return false;
  if (value.versionsRoot !== "versions") return false;
  if (options.namespace != null && value.namespace !== options.namespace) return false;
  if (typeof value.namespace !== "string" || value.namespace.length === 0) return false;
  if (
    !isRecord(value.helpers) ||
    value.helpers.sevenZip !== SEVEN_ZIP_RELATIVE_PATH ||
    value.helpers.sevenZipDll !== SEVEN_ZIP_DLL_RELATIVE_PATH
  ) {
    return false;
  }
  return launcherExecutableName(value) != null;
}

function isExpectedLauncherConfig(value: unknown): value is LauncherConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (value.runtimePath !== "runtime.json") return false;
  if (value.attemptPath != null && value.attemptPath !== "state/attempt.json") return false;
  return true;
}

function isRuntimeVersionDescriptor(value: unknown, payloadExecutableName: string): value is RuntimeVersionDescriptor {
  if (!isRecord(value)) return false;
  if (typeof value.version !== "string" || value.version.length === 0) return false;
  if (typeof value.root !== "string" || value.root.length === 0) return false;
  if (!isRecord(value.entry)) return false;
  if (typeof value.entry.executable !== "string" || value.entry.executable.length === 0) return false;
  if (!Array.isArray(value.entry.args)) return false;
  if (!isRecord(value.entry.env)) return false;
  if (!isRecord(value.apps)) return false;
  const version = normalizeVersionSegment(value.version);
  if (version == null) return false;
  return (
    value.root === `versions/${version}` &&
    value.entry.cwd === "payload" &&
    value.entry.executable === `payload/${payloadExecutableName}`
  );
}

function isExpectedRuntimeConfig(
  value: unknown,
  options: PackagedLauncherInstallContextOptions,
  payloadExecutableName: string,
): value is RuntimeConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0) return false;
  if (options.namespace != null && value.namespace !== options.namespace) return false;
  if (typeof value.namespace !== "string" || value.namespace.length === 0) return false;
  if (value.namespaceRoot !== RUNTIME_NAMESPACE_ROOT) return false;
  return (
    isRuntimeVersionDescriptor(value.active, payloadExecutableName) &&
    isRuntimeVersionDescriptor(value.lastSuccessful, payloadExecutableName)
  );
}

function isRuntimeVersionForContext(
  descriptor: RuntimeVersionDescriptor,
  context: PackagedLauncherInstallContext,
  payloadExecutableName: string,
): boolean {
  return (
    descriptor.version === context.version &&
    descriptor.root === `versions/${context.version}` &&
    descriptor.entry.executable === `payload/${payloadExecutableName}` &&
    descriptor.entry.cwd === "payload"
  );
}

function hasRequiredInstallRootMarkers(
  path: PathApi,
  context: PackagedLauncherInstallContext,
  options: PackagedLauncherInstallContextOptions,
  payloadExecutableName: string,
): boolean {
  if (options.requireInstallRootMarkers !== true) return true;
  if (![
    context.installMetadataPath,
    context.launcherConfigPath,
    context.runtimeConfigPath,
    context.sevenZipDllPath,
    context.sevenZipPath,
  ].every((markerPath) => installRootMarkerExists(markerPath, options))) {
    return false;
  }

  const installMetadata = readJsonMarker(context.installMetadataPath, options);
  if (!isExpectedInstallMetadata(installMetadata, options)) return false;
  const launcherConfig = readJsonMarker(context.launcherConfigPath, options);
  if (!isExpectedLauncherConfig(launcherConfig)) return false;
  if (launcherConfig.runtimePath !== installMetadata.runtimePath) return false;
  const runtimeConfig = readJsonMarker(context.runtimeConfigPath, options);
  if (!isExpectedRuntimeConfig(runtimeConfig, options, payloadExecutableName)) return false;
  if (runtimeConfig.namespace !== installMetadata.namespace) return false;
  if (
    !isRuntimeVersionForContext(runtimeConfig.active, context, payloadExecutableName) &&
    !isRuntimeVersionForContext(runtimeConfig.lastSuccessful, context, payloadExecutableName)
  ) {
    return false;
  }

  const launcherName = launcherExecutableName(installMetadata);
  if (launcherName == null) return false;
  return installRootMarkerExists(path.join(context.installRoot, launcherName), options);
}

function resolveWithPathApi(
  path: PathApi,
  executablePath: string,
  options: PackagedLauncherInstallContextOptions,
): PackagedLauncherInstallContext | null {
  const payloadRoot = path.dirname(executablePath);
  if (path.basename(payloadRoot) !== "payload") return null;
  const payloadExecutableName = path.basename(executablePath);
  const versionRoot = path.dirname(payloadRoot);
  const version = path.basename(versionRoot);
  if (normalizeVersionSegment(version) == null) return null;
  const versionsRoot = path.dirname(versionRoot);
  if (path.basename(versionsRoot) !== "versions") return null;
  const installRoot = path.dirname(versionsRoot);
  const context = {
    cleanupMarkerPath: path.join(installRoot, "state", "cleanup.json"),
    installMetadataPath: path.join(installRoot, "install.json"),
    launcherConfigPath: path.join(installRoot, "launcher.json"),
    installRoot,
    lockPath: path.join(installRoot, "state", "lock"),
    payloadRoot,
    runtimeConfigPath: path.join(installRoot, "runtime.json"),
    sevenZipDllPath: path.join(installRoot, "lib", "7z", "7z.dll"),
    sevenZipPath: path.join(installRoot, "lib", "7z", "7z.exe"),
    version,
    versionRoot,
  };
  return hasRequiredInstallRootMarkers(path, context, options, payloadExecutableName) ? context : null;
}

export function resolvePackagedLauncherInstallContext(
  executablePath: string,
  options: PackagedLauncherInstallContextOptions = {},
): PackagedLauncherInstallContext | null {
  if (executablePath.includes("\\") || /^[A-Za-z]:/.test(executablePath)) {
    return resolveWithPathApi(win32, executablePath, options);
  }
  return resolveWithPathApi(posix, executablePath, options);
}
