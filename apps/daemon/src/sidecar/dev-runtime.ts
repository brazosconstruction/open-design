import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPackageManagerInvocation } from "@open-design/platform";
import {
  SIDECAR_SOURCES,
  type SidecarStamp,
} from "@open-design/sidecar-proto";

export type DaemonCliBuildCheck = {
  distCliPath: string;
  distMtime: number;
  required: boolean;
  sourceMtime: number;
  reason?: string;
};

export type DaemonCliBuildRequest = {
  env?: NodeJS.ProcessEnv;
  workspaceRoot: string;
};

type DaemonSidecarRuntimeIdentity = Pick<SidecarStamp, "mode" | "source">;

async function latestMtimeMs(filePath: string): Promise<number> {
  const entry = await lstat(filePath).catch(() => null);
  if (entry == null) return 0;
  if (!entry.isDirectory()) return entry.mtimeMs;

  const children = await readdir(filePath, { withFileTypes: true }).catch(() => []);
  let latest = entry.mtimeMs;
  for (const child of children) {
    if (child.name === "node_modules" || child.name === "dist" || child.name === ".tmp") continue;
    latest = Math.max(latest, await latestMtimeMs(join(filePath, child.name)));
  }
  return latest;
}

export function resolveDaemonPackageRoot(moduleUrl = import.meta.url): string {
  return dirname(dirname(dirname(fileURLToPath(moduleUrl))));
}

export function resolveDaemonWorkspaceRoot(packageRoot: string): string {
  return dirname(dirname(packageRoot));
}

export async function checkDaemonCliBuild(packageRoot: string): Promise<DaemonCliBuildCheck> {
  const distCliPath = join(packageRoot, "dist", "cli.js");
  const distMtime = await latestMtimeMs(distCliPath);
  const sourceMtime = Math.max(
    await latestMtimeMs(join(packageRoot, "src")),
    await latestMtimeMs(join(packageRoot, "package.json")),
    await latestMtimeMs(join(packageRoot, "tsconfig.json")),
  );
  if (distMtime > 0 && distMtime >= sourceMtime) {
    return { distCliPath, distMtime, required: false, sourceMtime };
  }

  return {
    distCliPath,
    distMtime,
    reason: distMtime > 0 ? "source is newer than apps/daemon/dist/cli.js" : "apps/daemon/dist/cli.js is missing",
    required: true,
    sourceMtime,
  };
}

export async function runDaemonCliBuild(request: DaemonCliBuildRequest): Promise<void> {
  const invocation = createPackageManagerInvocation(
    ["--filter", "@open-design/daemon", "build"],
    request.env ?? process.env,
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: request.workspaceRoot,
    env: request.env ?? process.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: process.platform === "win32",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  await new Promise<void>((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`command failed: ${invocation.command} ${invocation.args.join(" ")} (${signal ?? code})`));
    });
  });
}

export async function prepareDaemonSidecarDevRuntime(options: {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  packageRoot?: string;
  runBuild?: (request: DaemonCliBuildRequest) => Promise<void>;
  runtime: DaemonSidecarRuntimeIdentity;
  workspaceRoot?: string;
}): Promise<DaemonCliBuildCheck | null> {
  if (options.runtime.mode !== "dev" || options.runtime.source !== SIDECAR_SOURCES.TOOLS_DEV) return null;

  const packageRoot = options.packageRoot ?? resolveDaemonPackageRoot();
  const check = await checkDaemonCliBuild(packageRoot);
  if (!check.required) return check;

  const log = options.log ?? console.log;
  log(`[open-design daemon] building @open-design/daemon because ${check.reason} at ${new Date().toISOString()}`);
  await (options.runBuild ?? runDaemonCliBuild)({
    workspaceRoot: options.workspaceRoot ?? resolveDaemonWorkspaceRoot(packageRoot),
    ...(options.env == null ? {} : { env: options.env }),
  });
  return check;
}
