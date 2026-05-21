import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  APP_KEYS,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_EVENTS,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  type AppKey,
  type DaemonStatusSnapshot,
  type PackagedBundleActivationInput,
  type PackagedBundleActivationSnapshot,
  type PackagedBundleOperation,
  type PackagedBundleOperationResult,
  type PackagedBundleRuntimeSnapshot,
  type SidecarEventMessage,
  type SidecarStamp,
  type WebStatusSnapshot,
} from "@open-design/sidecar-proto";
import {
  createSidecarLaunchEnv,
  requestJsonIpc,
  resolveAppIpcPath,
  type SidecarRuntimeContext,
} from "@open-design/sidecar";
import {
  createProcessStampArgs,
  stopProcesses,
  waitForProcessExit,
  wellKnownUserToolchainBins,
} from "@open-design/platform";

import {
  PACKAGED_WEB_SIDECAR_BUNDLE_KEY,
  createPackagedBundleActivationFile,
  readPackagedBundleActivationFile,
  resolvePackagedWebSidecarImplementation,
  resolvePackagedWebSidecarImplementationForActivation,
  sidecarImplementationEnv,
  writePackagedBundleActivationFile,
  type PackagedBundleActivationFile,
  type PackagedWebSidecarImplementation,
} from "./bundle-activation.js";
import type { PackagedWebOutputMode } from "./config.js";
import type { PackagedNamespacePaths } from "./paths.js";

const require = createRequire(import.meta.url);
const PACKAGED_CHILD_ENV_ALLOWLIST = [
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_PROXY",
  "TMPDIR",
  "USER",
  "VP_HOME",
] as const;

function shouldForwardPackagedChildEnv(key: string, includeProviderSecrets = false): boolean {
  return (
    PACKAGED_CHILD_ENV_ALLOWLIST.includes(
      key as (typeof PACKAGED_CHILD_ENV_ALLOWLIST)[number],
    ) ||
    (includeProviderSecrets && (key.endsWith("_API_KEY") || key.endsWith("_TOKEN")))
  );
}

export type PackagedSidecarHandle = {
  close(): Promise<void>;
  daemon: DaemonStatusSnapshot;
  handleBundleEvent(message: SidecarEventMessage): Promise<PackagedBundleOperationResult | undefined>;
  implementations: {
    web: PackagedWebSidecarImplementation["implementation"];
  };
  web: WebStatusSnapshot;
  webRuntimeTarget(): {
    unavailableReason?: string;
    url: string | null;
  };
};

export type StartPackagedSidecarsOptions = {
  appVersion: string | null;
  bundleEpoch: string | null;
  daemonCliEntry: string | null;
  daemonSidecarEntry: string | null;
  nodeCommand: string | null;
  onWebStatusChange?: (status: WebStatusSnapshot) => Promise<void>;
  telemetryRelayUrl: string | null;
  posthogKey: string | null;
  posthogHost: string | null;
  /**
   * PR #974 round-5 (lefarcen P2): caller asserts whether a desktop
   * runtime is being started in this packaged process group. The
   * Electron entry passes `true`; `headless.ts` passes `false` so the
   * daemon's import-folder gate stays dormant in headless mode where
   * there is no `shell.openPath` surface and no client to register a
   * secret. Required (no default) so a future packaged caller cannot
   * silently regress the gate by omitting it.
   */
  requireDesktopAuth: boolean;
  webSidecarEntry: string | null;
  webStandaloneRoot: string | null;
  webOutputMode: PackagedWebOutputMode;
};

type ManagedSidecarChild = {
  app: AppKey;
  child: ChildProcess;
  ipcPath: string;
  logHandle: FileHandle;
};

type PackagedDaemonManagedPathEnv = {
  OD_DATA_DIR: string;
  OD_RESOURCE_ROOT: string;
};

function resolveSidecarEntry(packageName: string, exportName: string): string {
  return require.resolve(`${packageName}/${exportName}`);
}

function logPathFor(paths: PackagedNamespacePaths, app: AppKey): string {
  return join(paths.logsRoot, app, "latest.log");
}

async function openLog(path: string): Promise<FileHandle> {
  await mkdir(dirname(path), { recursive: true });
  return await open(path, "w");
}

const DAEMON_STATUS_TIMEOUT_MS = 35_000;
const DAEMON_MIGRATION_STATUS_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Daemon status wait budget. The default 35s is fine for normal cold
 * boots, but the OD_LEGACY_DATA_DIR one-shot recovery flow can synch-
 * copy a multi-GB legacy `.od/` payload before SQLite even opens, and
 * killing the child mid-migration can leave dataDir half-promoted.
 * When the env var is set, use a 30-minute budget so the parent will
 * not tear the daemon down before the migration can complete.
 *
 * @see apps/daemon/src/legacy-data-migrator.ts
 * @see https://github.com/nexu-io/open-design/issues/710
 */
export function resolveDaemonStatusTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.OD_LEGACY_DATA_DIR;
  if (raw != null && raw.length > 0) return DAEMON_MIGRATION_STATUS_TIMEOUT_MS;
  return DAEMON_STATUS_TIMEOUT_MS;
}

/**
 * Waits for the sidecar to report a ready status over IPC.
 *
 * When `watch` is provided, the polling loop also races the spawned
 * child's `exit` event so a daemon that throws at startup (e.g. the
 * #710 migrator's LegacyMigrationError on invalid OD_LEGACY_DATA_DIR,
 * existing target payload, symlink in payload, or marker write
 * failure) surfaces immediately instead of leaving the packaged app
 * waiting the full DAEMON_MIGRATION_STATUS_TIMEOUT_MS for a process
 * that already exited. The error message includes the daemon log path
 * so the user can read the actual failure reason.
 */
export async function waitForStatus<T>(
  ipcPath: string,
  isReady: (status: T) => boolean,
  timeoutMs = DAEMON_STATUS_TIMEOUT_MS,
  watch: { child: { exitCode: number | null; signalCode: NodeJS.Signals | null; once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void; off: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void }; logPath: string } | null = null,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  let childExited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  // Cover the race between spawn-resolved and now: if the child has
  // already exited by the time we got here, the 'exit' event is gone,
  // so seed childExited from the synchronous status fields.
  if (watch != null && watch.child.exitCode !== null) {
    childExited = { code: watch.child.exitCode, signal: watch.child.signalCode };
  }

  const onChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    childExited = { code, signal };
  };
  watch?.child.once('exit', onChildExit);

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (childExited !== null) {
        throw new Error(
          `daemon exited before reporting status (code=${childExited.code}, signal=${childExited.signal ?? 'none'}); see ${watch?.logPath ?? '<no log path>'} for details`,
        );
      }
      try {
        const status = await requestJsonIpc<T>(
          ipcPath,
          { type: SIDECAR_MESSAGES.STATUS },
          { timeoutMs: 800 },
        );
        if (isReady(status)) return status;
      } catch (error) {
        lastError = error;
      }
      await sleep(150);
    }

    throw new Error(
      `timed out waiting for sidecar status at ${ipcPath}${
        lastError instanceof Error ? ` (${lastError.message})` : ""
      }`,
    );
  } finally {
    watch?.child.off('exit', onChildExit);
  }
}

function extractPort(url: string): string {
  const parsed = new URL(url);
  return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
}

// Hardcoded POSIX system bins the packaged daemon must always be able to
// reach even when the inherited PATH from launchd / a desktop launcher is
// stripped down to nothing. The user-toolchain portion of the search list
// (Homebrew, npm globals, nvm/fnm/mise, cargo, ...) lives in
// @open-design/platform's wellKnownUserToolchainBins so the daemon
// resolver and this PATH builder cannot drift again. See issue #442.
const PACKAGED_POSIX_SYSTEM_BINS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

export function resolvePackagedPathEnv(basePath = process.env.PATH ?? ""): string {
  const candidates = [
    ...basePath.split(delimiter),
    ...wellKnownUserToolchainBins(),
    ...PACKAGED_POSIX_SYSTEM_BINS,
  ];
  return [...new Set(candidates.filter((entry) => entry.length > 0))].join(delimiter);
}

export function resolvePackagedChildBaseEnv(
  env: NodeJS.ProcessEnv = process.env,
  includeProviderSecrets = false,
): NodeJS.ProcessEnv {
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value != null && value.length > 0 && shouldForwardPackagedChildEnv(key, includeProviderSecrets)) {
      baseEnv[key] = value;
    }
  }
  return baseEnv;
}

function createPackagedDaemonManagedPathEnv(
  paths: PackagedNamespacePaths,
): PackagedDaemonManagedPathEnv {
  return {
    OD_DATA_DIR: paths.dataRoot,
    OD_RESOURCE_ROOT: paths.resourceRoot,
  };
}

export type PackagedDaemonSpawnEnvOptions = {
  appVersion: string | null;
  daemonCliEntry: string | null;
  /**
   * PR #974 round-5 (lefarcen P2): only pin the daemon's import-folder
   * gate ON when the desktop runtime is actually being started in the
   * same packaged process group. Headless packaged deployments
   * (`tools-pack linux start --headless`) have no `shell.openPath`
   * surface, so leaving the gate dormant avoids the impossible-auth
   * state where the daemon waits forever for a registration that the
   * headless runtime can never deliver.
   */
  requireDesktopAuth: boolean;
  legacyDataDir?: string | null;
  telemetryRelayUrl?: string | null;
  posthogKey?: string | null;
  posthogHost?: string | null;
};

/**
 * Pure helper: assemble the daemon spawn env for a packaged sidecar.
 * Extracted from `startPackagedSidecars` so vitest can pin both
 * branches of `requireDesktopAuth` without spinning up a real child
 * process.
 */
export function buildPackagedDaemonSpawnEnv(
  paths: PackagedNamespacePaths,
  options: PackagedDaemonSpawnEnvOptions,
): NodeJS.ProcessEnv {
  return {
    [SIDECAR_ENV.DAEMON_PORT]: "0",
    ...(options.daemonCliEntry == null ? {} : { [SIDECAR_ENV.DAEMON_CLI_PATH]: options.daemonCliEntry }),
    // PR #974 round-4 P1 + round-5 P2: pinned ON when a desktop is
    // being started, OFF for headless. The daemon-side flag refuses
    // tokenless imports even before the desktop main process has
    // finished registering, closing the daemon-restart-mid-session
    // bypass that a runtime-only handshake left open. Headless skips
    // it because there is no privileged shell.openPath surface and
    // no client to register a secret.
    ...(options.requireDesktopAuth ? { OD_REQUIRE_DESKTOP_AUTH: "1" } : {}),
    // Packaged daemon managed paths are deliberately delivered through
    // the sidecar launch environment. The daemon may keep its own default
    // fallback, but packaged runtime must not rely on path inference from
    // Electron userData, bundle names, or ports.
    ...createPackagedDaemonManagedPathEnv(paths),
    ...(options.appVersion == null ? {} : { OD_APP_VERSION: options.appVersion }),
    ...(options.telemetryRelayUrl == null || options.telemetryRelayUrl.length === 0
      ? {}
      : { OPEN_DESIGN_TELEMETRY_RELAY_URL: options.telemetryRelayUrl }),
    // OD_LEGACY_DATA_DIR is the one-shot recovery handle for users
    // upgrading from 0.3.x .od/ layouts. The daemon's startup
    // migrator (legacy-data-migrator.ts) reads it; the env-allowlist
    // for packaged children would otherwise drop it. Forward only
    // when set so we do not invent an empty string and trigger the
    // daemon's "env set but path invalid" error path.
    ...(options.legacyDataDir == null || options.legacyDataDir.length === 0
      ? {}
      : { OD_LEGACY_DATA_DIR: options.legacyDataDir }),
    // PostHog analytics ingest key, baked into the bundle at packaging time
    // by tools/pack. Daemon reads this as POSTHOG_KEY at startup. Absent
    // for fork builds without the CI secret — the daemon's analytics
    // module no-ops cleanly in that case, and /api/analytics/config
    // returns enabled=false regardless of user consent.
    ...(options.posthogKey == null || options.posthogKey.length === 0
      ? {}
      : { POSTHOG_KEY: options.posthogKey }),
    ...(options.posthogHost == null || options.posthogHost.length === 0
      ? {}
      : { POSTHOG_HOST: options.posthogHost }),
  };
}

async function spawnSidecarChild(options: {
  app: AppKey;
  entryPath: string;
  env: NodeJS.ProcessEnv;
  nodeCommand: string | null;
  paths: PackagedNamespacePaths;
  runtime: SidecarRuntimeContext<SidecarStamp>;
}): Promise<ManagedSidecarChild> {
  const ipcPath = resolveAppIpcPath({
    app: options.app,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    namespace: options.runtime.namespace,
  });
  const stamp = {
    app: options.app,
    ipc: ipcPath,
    mode: SIDECAR_MODES.RUNTIME,
    namespace: options.runtime.namespace,
    source: options.runtime.source,
  } satisfies SidecarStamp;
  const logHandle = await openLog(logPathFor(options.paths, options.app));
  const childEnv = createSidecarLaunchEnv({
    base: options.paths.runtimeRoot,
    contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    extraEnv: {
      ...resolvePackagedChildBaseEnv(process.env, options.app === APP_KEYS.DAEMON),
      ...options.env,
      NODE_ENV: "production",
      PATH: resolvePackagedPathEnv(),
      ...(options.nodeCommand == null ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    stamp,
  });
  const command = options.nodeCommand ?? process.execPath;
  const child = spawn(
    command,
    [options.entryPath, ...createProcessStampArgs(stamp, OPEN_DESIGN_SIDECAR_CONTRACT)],
    {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    },
  );

  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once("error", rejectSpawn);
    child.once("spawn", resolveSpawn);
  });

  return { app: options.app, child, ipcPath, logHandle };
}

async function closeManagedChild(child: ManagedSidecarChild): Promise<void> {
  try {
    await requestJsonIpc(child.ipcPath, { type: SIDECAR_MESSAGES.SHUTDOWN }, { timeoutMs: 1200 });
  } catch {
    // Fall through to process cleanup.
  }

  if (!(await waitForProcessExit(child.child.pid, 5000))) {
    await stopProcesses([child.child.pid]);
  }

  await child.logHandle.close().catch(() => undefined);
}

class PackagedSidecarSupervisor implements PackagedSidecarHandle {
  daemon: DaemonStatusSnapshot = {
    desktopAuthGateActive: false,
    state: "idle",
    url: null,
  };

  implementations: PackagedSidecarHandle["implementations"] = {
    web: {
      fallbackReason: "not-started",
      source: "builtin",
    },
  };

  web: WebStatusSnapshot = {
    state: "idle",
    url: null,
  };

  private daemonChild: ManagedSidecarChild | null = null;
  private operation: PackagedBundleOperation | null = null;
  private webChild: ManagedSidecarChild | null = null;
  private webTransitionReason: string | null = null;

  constructor(
    private readonly runtime: SidecarRuntimeContext<SidecarStamp>,
    private readonly paths: PackagedNamespacePaths,
    private readonly options: StartPackagedSidecarsOptions,
  ) {}

  async start(): Promise<this> {
    await this.ensureRuntimeDirs();
    try {
      await this.startDaemon();
      await this.startWebFromActivation();
      return this;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const children = [this.webChild, this.daemonChild].filter((child): child is ManagedSidecarChild => child != null);
    this.webChild = null;
    this.daemonChild = null;
    for (const child of children) {
      await closeManagedChild(child).catch((error: unknown) => {
        console.error(`failed to close packaged ${child.app} sidecar`, error);
      });
    }
    const now = new Date().toISOString();
    this.web = { pid: null, state: "stopped", updatedAt: now, url: null };
    this.daemon = { desktopAuthGateActive: false, pid: null, state: "stopped", updatedAt: now, url: null };
  }

  webRuntimeTarget(): { unavailableReason?: string; url: string | null } {
    if (this.webTransitionReason != null) {
      return { unavailableReason: this.webTransitionReason, url: null };
    }
    if (this.web.url == null) return { unavailableReason: "web-unavailable", url: null };
    return { url: this.web.url };
  }

  async handleBundleEvent(
    message: SidecarEventMessage,
  ): Promise<PackagedBundleOperationResult | undefined> {
    switch (message.key) {
      case SIDECAR_EVENTS.PACKAGED_BUNDLE_STATUS:
        return await this.bundleStatus(message.payload.key);
      case SIDECAR_EVENTS.PACKAGED_BUNDLE_ENSURE:
        return await this.bundleEnsure(message.payload.key);
      case SIDECAR_EVENTS.PACKAGED_BUNDLE_RESTART:
        return await this.bundleRestart(message.payload.key);
      case SIDECAR_EVENTS.PACKAGED_BUNDLE_SWITCH:
        return await this.bundleSwitch(message.payload);
      case SIDECAR_EVENTS.PACKAGED_BUNDLE_ACTIVATE:
        return await this.bundleActivate(message.payload);
      default:
        return undefined;
    }
  }

  private async ensureRuntimeDirs(): Promise<void> {
    await mkdir(this.paths.namespaceRoot, { recursive: true });
    await mkdir(this.paths.cacheRoot, { recursive: true });
    await mkdir(this.paths.dataRoot, { recursive: true });
    await mkdir(this.paths.bundleBasePath, { recursive: true });
    await mkdir(this.paths.logsRoot, { recursive: true });
    await mkdir(this.paths.desktopLogsRoot, { recursive: true });
    await mkdir(this.paths.runtimeRoot, { recursive: true });
    await mkdir(this.paths.updateRoot, { recursive: true });
    await mkdir(this.paths.electronUserDataRoot, { recursive: true });
    await mkdir(this.paths.electronSessionDataRoot, { recursive: true });
  }

  private async startDaemon(): Promise<void> {
    const daemon = await spawnSidecarChild({
      app: APP_KEYS.DAEMON,
      entryPath: this.options.daemonSidecarEntry ?? resolveSidecarEntry("@open-design/daemon", "sidecar"),
      env: buildPackagedDaemonSpawnEnv(this.paths, {
        appVersion: this.options.appVersion,
        daemonCliEntry: this.options.daemonCliEntry,
        legacyDataDir: process.env.OD_LEGACY_DATA_DIR ?? null,
        requireDesktopAuth: this.options.requireDesktopAuth,
        telemetryRelayUrl: this.options.telemetryRelayUrl,
        posthogKey: this.options.posthogKey,
        posthogHost: this.options.posthogHost,
      }),
      nodeCommand: this.options.nodeCommand,
      paths: this.paths,
      runtime: this.runtime,
    });
    this.daemonChild = daemon;
    const daemonStatus = await waitForStatus<DaemonStatusSnapshot>(
      daemon.ipcPath,
      (status) => status.url != null,
      resolveDaemonStatusTimeoutMs(),
      // Race the IPC polling against the daemon child's exit. Without
      // this, a daemon that throws at startup (LegacyMigrationError on
      // invalid OD_LEGACY_DATA_DIR, existing target payload, symlink,
      // marker write failure) leaves the packaged app waiting the full
      // 30-minute migration budget for a process that already died.
      { child: daemon.child, logPath: logPathFor(this.paths, APP_KEYS.DAEMON) },
    );
    if (daemonStatus.url == null) throw new Error("daemon did not report a URL");
    this.daemon = daemonStatus;
  }

  private async startWebFromActivation(): Promise<void> {
    const webImplementation = await resolvePackagedWebSidecarImplementation({
      builtinEntryPath: this.options.webSidecarEntry,
      bundleEpoch: this.options.bundleEpoch,
      paths: this.paths,
    });
    await this.startWebWithImplementation(webImplementation);
  }

  private async startWebWithImplementation(
    webImplementation: PackagedWebSidecarImplementation,
  ): Promise<void> {
    if (this.daemon.url == null) throw new Error("daemon URL is required before starting web");
    const webStandaloneRoot = webImplementation.webStandaloneRoot ?? this.options.webStandaloneRoot;
    this.web = {
      pid: null,
      state: "starting",
      updatedAt: new Date().toISOString(),
      url: null,
    };
    const web = await spawnSidecarChild({
      app: APP_KEYS.WEB,
      entryPath: webImplementation.entryPath ?? resolveSidecarEntry("@open-design/web", "sidecar"),
      env: {
        [SIDECAR_ENV.DAEMON_PORT]: extractPort(this.daemon.url),
        [SIDECAR_ENV.WEB_PORT]: "0",
        ...sidecarImplementationEnv(webImplementation.implementation),
        ...(webStandaloneRoot == null ? {} : { OD_WEB_STANDALONE_ROOT: webStandaloneRoot }),
        OD_WEB_OUTPUT_MODE: this.options.webOutputMode,
        PORT: "0",
      },
      nodeCommand: this.options.nodeCommand,
      paths: this.paths,
      runtime: this.runtime,
    });
    this.webChild = web;
    try {
      const webStatus = await waitForStatus<WebStatusSnapshot>(
        web.ipcPath,
        (status) => status.url != null,
      );
      if (webStatus.url == null) throw new Error("web did not report a URL");
      this.web = webStatus;
      this.implementations.web = webImplementation.implementation;
      await this.options.onWebStatusChange?.(webStatus);
    } catch (error) {
      this.webChild = null;
      await closeManagedChild(web).catch(() => undefined);
      throw error;
    }
  }

  private async closeWebChild(): Promise<void> {
    const child = this.webChild;
    this.webChild = null;
    if (child != null) {
      await closeManagedChild(child).catch((error: unknown) => {
        console.error("failed to close packaged web sidecar", error);
      });
    }
    this.web = {
      pid: null,
      state: "stopped",
      updatedAt: new Date().toISOString(),
      url: null,
    };
  }

  private assertSupportedBundleKey(key: string): void {
    if (key !== PACKAGED_WEB_SIDECAR_BUNDLE_KEY) {
      throw new Error(`unsupported packaged bundle key: ${key}; only ${PACKAGED_WEB_SIDECAR_BUNDLE_KEY} is available`);
    }
  }

  private activationFromInput(input: PackagedBundleActivationInput): PackagedBundleActivationFile {
    return input.source === "builtin"
      ? createPackagedBundleActivationFile({ web: "builtin" })
      : createPackagedBundleActivationFile({ web: { version: input.version } });
  }

  private async activationSnapshot(key: string): Promise<PackagedBundleActivationSnapshot> {
    try {
      const activation = await readPackagedBundleActivationFile(this.paths);
      if (activation == null) {
        return { key, path: this.paths.bundleActivationPath, source: "missing" };
      }
      if ("source" in activation && activation.source === "builtin") {
        return { key: activation.key, path: this.paths.bundleActivationPath, source: "builtin" };
      }
      if (!("version" in activation)) {
        throw new Error("activation file did not contain source=builtin or version");
      }
      return {
        key: activation.key,
        path: this.paths.bundleActivationPath,
        source: "bundle",
        version: activation.version,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        key,
        path: this.paths.bundleActivationPath,
        source: "invalid",
      };
    }
  }

  private runtimeSnapshot(
    key: string,
    operation: PackagedBundleOperation | null = this.operation,
  ): PackagedBundleRuntimeSnapshot {
    const implementation = this.implementations.web;
    const version = implementation.source === "bundle" ? implementation.ref?.version : undefined;
    return {
      activationPath: this.paths.bundleActivationPath,
      bundleBasePath: this.paths.bundleBasePath,
      ...(implementation.source === "builtin" && implementation.fallbackReason != null
        ? { fallbackReason: implementation.fallbackReason }
        : {}),
      implementation,
      key,
      operation,
      pid: this.web.pid ?? null,
      source: implementation.source === "bundle" ? "bundle" : "builtin",
      state: this.webTransitionReason != null ? "switching" : this.web.state,
      updatedAt: this.web.updatedAt,
      url: this.webRuntimeTarget().url,
      ...(version == null ? {} : { version }),
    };
  }

  private async operationResult(
    operation: PackagedBundleOperation,
    previous: PackagedBundleRuntimeSnapshot | undefined,
    key = PACKAGED_WEB_SIDECAR_BUNDLE_KEY,
  ): Promise<PackagedBundleOperationResult> {
    return {
      accepted: true,
      activation: await this.activationSnapshot(key),
      mode: "online",
      operation,
      ...(previous == null ? {} : { previous }),
      runtime: this.runtimeSnapshot(key, operation === "status" ? this.operation : null),
    };
  }

  private async resolveCandidateImplementation(
    activation: PackagedBundleActivationFile,
  ): Promise<PackagedWebSidecarImplementation> {
    const implementation = await resolvePackagedWebSidecarImplementationForActivation({
      activation,
      builtinEntryPath: this.options.webSidecarEntry,
      bundleEpoch: this.options.bundleEpoch,
      paths: this.paths,
    });
    if ("version" in activation) {
      const resolved = implementation.implementation;
      if (resolved.source !== "bundle" || resolved.ref?.version !== activation.version) {
        const reason = resolved.source === "builtin"
          ? resolved.fallbackReason ?? "bundle-unresolved"
          : "bundle-ref-mismatch";
        throw new Error(`web bundle ${activation.version} is not available for this packaged runtime: ${reason}`);
      }
    }
    return implementation;
  }

  private isWebRunning(): boolean {
    return (
      this.web.url != null &&
      this.webChild != null &&
      this.webChild.child.exitCode == null &&
      this.webChild.child.signalCode == null
    );
  }

  private async runExclusive(
    operation: Exclude<PackagedBundleOperation, "status">,
    run: () => Promise<PackagedBundleOperationResult>,
  ): Promise<PackagedBundleOperationResult> {
    if (this.operation != null) {
      throw new Error(`packaged bundle operation already in progress: ${this.operation}`);
    }

    this.operation = operation;
    try {
      return await run();
    } finally {
      this.webTransitionReason = null;
      this.operation = null;
    }
  }

  private async bundleStatus(key: string): Promise<PackagedBundleOperationResult> {
    this.assertSupportedBundleKey(key);
    return await this.operationResult("status", undefined, key);
  }

  private async bundleEnsure(key: string): Promise<PackagedBundleOperationResult> {
    this.assertSupportedBundleKey(key);
    const transitionWeb = !this.isWebRunning();
    return await this.runExclusive("ensure", async () => {
      if (!transitionWeb) return await this.operationResult("ensure", undefined, key);
      const previous = this.runtimeSnapshot(key, null);
      this.webTransitionReason = "web-switching";
      await this.closeWebChild();
      await this.startWebFromActivation();
      this.webTransitionReason = null;
      return await this.operationResult("ensure", previous, key);
    });
  }

  private async bundleRestart(key: string): Promise<PackagedBundleOperationResult> {
    this.assertSupportedBundleKey(key);
    return await this.runExclusive("restart", async () => {
      const previous = this.runtimeSnapshot(key, null);
      this.webTransitionReason = "web-switching";
      await this.closeWebChild();
      await this.startWebFromActivation();
      this.webTransitionReason = null;
      return await this.operationResult("restart", previous, key);
    });
  }

  private async bundleActivate(input: PackagedBundleActivationInput): Promise<PackagedBundleOperationResult> {
    this.assertSupportedBundleKey(input.key);
    return await this.runExclusive("activate", async () => {
      const previous = this.runtimeSnapshot(input.key, null);
      const activation = this.activationFromInput(input);
      await this.resolveCandidateImplementation(activation);
      await writePackagedBundleActivationFile({ activation, paths: this.paths });
      return await this.operationResult("activate", previous, input.key);
    });
  }

  private async bundleSwitch(input: PackagedBundleActivationInput): Promise<PackagedBundleOperationResult> {
    this.assertSupportedBundleKey(input.key);
    return await this.runExclusive("switch", async () => {
      const previous = this.runtimeSnapshot(input.key, null);
      const activation = this.activationFromInput(input);
      const candidate = await this.resolveCandidateImplementation(activation);
      let previousStopped = false;

      try {
        this.webTransitionReason = "web-switching";
        await this.closeWebChild();
        previousStopped = true;
        await this.startWebWithImplementation(candidate);
        await writePackagedBundleActivationFile({ activation, paths: this.paths });
        this.webTransitionReason = null;
        return await this.operationResult("switch", previous, input.key);
      } catch (error) {
        if (!previousStopped) throw error;
        await this.closeWebChild().catch(() => undefined);
        try {
          await this.startWebFromActivation();
          this.webTransitionReason = null;
        } catch (rollbackError) {
          throw new Error(
            `web bundle switch failed (${error instanceof Error ? error.message : String(error)}); rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
          );
        }
        throw new Error(`web bundle switch failed and rolled back: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}

export async function startPackagedSidecars(
  runtime: SidecarRuntimeContext<SidecarStamp>,
  paths: PackagedNamespacePaths,
  options: StartPackagedSidecarsOptions,
): Promise<PackagedSidecarHandle> {
  return await new PackagedSidecarSupervisor(runtime, paths, options).start();
}
