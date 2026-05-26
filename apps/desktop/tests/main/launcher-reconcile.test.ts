import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  reconcileLauncherInstall,
  type LauncherReconcileExecFile,
} from "../../src/main/launcher-reconcile.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "od-launcher-reconcile-test-"));
}

async function writeInstallFixture(installRoot: string): Promise<{
  installMetadataPath: string;
  launcherConfigPath: string;
  launcherPath: string;
  lockPath: string;
  runtimeConfigPath: string;
  sevenZipDllPath: string;
  sevenZipPath: string;
}> {
  const installMetadataPath = join(installRoot, "install.json");
  const launcherConfigPath = join(installRoot, "launcher.json");
  const runtimeConfigPath = join(installRoot, "runtime.json");
  const lockPath = join(installRoot, "state", "lock");
  const launcherPath = join(installRoot, "Open Design Beta.exe");
  const sevenZipDllPath = join(installRoot, "lib", "7z", "7z.dll");
  const sevenZipPath = join(installRoot, "lib", "7z", "7z.exe");
  await mkdir(join(installRoot, "lib", "7z"), { recursive: true });
  await mkdir(join(installRoot, "state"), { recursive: true });
  await writeFile(launcherPath, "launcher", "utf8");
  await writeFile(sevenZipDllPath, "7z dll", "utf8");
  await writeFile(sevenZipPath, "7z", "utf8");
  await writeFile(installMetadataPath, JSON.stringify({
    currentVersion: "1.0.0",
    displayName: "Open Design Beta",
    exeName: "Open Design.exe",
    helpers: {
      sevenZip: "versions/1.0.0/payload/7z.exe",
    },
    launcher: {
      executable: "Open Design.exe",
    },
    namespace: "release-beta-win",
    runtimePath: "runtime.json",
    schemaVersion: 1,
    versionsRoot: "versions",
  }), "utf8");
  await writeFile(launcherConfigPath, JSON.stringify({
    runtimePath: "legacy-runtime.json",
    schemaVersion: 0,
  }), "utf8");
  await writeFile(runtimeConfigPath, JSON.stringify({
    active: {
      version: "1.0.1",
    },
    lastSuccessful: {
      version: "1.0.0",
    },
    namespace: "release-beta-win",
    namespaceRoot: ".",
    schemaVersion: 1,
  }), "utf8");
  return {
    installMetadataPath,
    launcherConfigPath,
    launcherPath,
    lockPath,
    runtimeConfigPath,
    sevenZipDllPath,
    sevenZipPath,
  };
}

describe("launcher install reconciliation", () => {
  it("repairs launcher install metadata and ensures registry and shortcut targets", async () => {
    const root = makeRoot();
    const calls: Array<{ args: string[]; command: string; timeout?: number }> = [];
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async (command, args, options) => {
      calls.push({ args, command, timeout: options.timeout });
      return {
        stderr: "",
        stdout: command === "pwsh.exe" ? JSON.stringify([{ kind: "start-menu", status: "ok" }]) : "",
      };
    });
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);

      const result = await reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: paths.lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      });

      expect(result).toMatchObject({
        appPathsKey: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
        displayName: "Open Design Beta",
        displayVersion: "1.0.1",
        launcherConfigChanged: true,
        launcherConfigPath: paths.launcherConfigPath,
        launcherPath: paths.launcherPath,
        metadataChanged: true,
        ok: true,
        registryKey: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-beta-win",
        sevenZipDllPath: paths.sevenZipDllPath,
        sevenZipPath: paths.sevenZipPath,
        shortcutCommand: "pwsh.exe",
      });

      const metadata = JSON.parse(await readFile(paths.installMetadataPath, "utf8")) as {
        currentVersion: string;
        exeName: string;
        helpers: { sevenZip: string; sevenZipDll: string };
        launcher: { executable: string };
      };
      expect(metadata.currentVersion).toBe("1.0.1");
      expect(metadata.exeName).toBe("Open Design Beta.exe");
      expect(metadata.helpers.sevenZip).toBe("lib/7z/7z.exe");
      expect(metadata.helpers.sevenZipDll).toBe("lib/7z/7z.dll");
      expect(metadata.launcher.executable).toBe("Open Design Beta.exe");
      expect(JSON.parse(await readFile(paths.launcherConfigPath, "utf8"))).toMatchObject({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      });

      const regCalls = calls.filter((call) => call.command === "reg.exe");
      expect(regCalls).toHaveLength(7);
      expect(regCalls.every((call) => call.timeout === 5_000)).toBe(true);
      expect(regCalls.some((call) => call.args.includes("DisplayVersion") && call.args.includes("1.0.1"))).toBe(true);
      expect(regCalls.some((call) => call.args.includes("DisplayIcon") && call.args.includes(`${paths.launcherPath},0`))).toBe(true);
      expect(regCalls.some((call) => call.args.includes("/ve") && call.args.includes(paths.launcherPath))).toBe(true);

      const powershellCall = calls.find((call) => call.command === "pwsh.exe");
      expect(powershellCall?.timeout).toBe(10_000);
      expect(powershellCall?.args).toContain("-ExecutionPolicy");
      expect(powershellCall?.args).toContain(paths.launcherPath);

      const summary = JSON.parse(await readFile(join(installRoot, "logs", "updater", "latest-reconcile.json"), "utf8")) as {
        details: { sevenZipDllPath: string; sevenZipPath: string };
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        operation: "reconcile",
        status: "ok",
      });
      expect(summary.details.sevenZipDllPath).toBe(paths.sevenZipDllPath);
      expect(summary.details.sevenZipPath).toBe(paths.sevenZipPath);
      expect(existsSync(paths.lockPath)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails fast and records an observation when the install-root lock is held", async () => {
    const root = makeRoot();
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);
      await mkdir(paths.lockPath, { recursive: true });

      await expect(reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: paths.lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      })).rejects.toThrow(/lock is already held/);

      expect(execFileMock).not.toHaveBeenCalled();
      expect(existsSync(paths.lockPath)).toBe(true);
      const summary = JSON.parse(await readFile(join(installRoot, "logs", "updater", "latest-reconcile.json"), "utf8")) as {
        error: string;
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        operation: "reconcile",
        status: "failed",
      });
      expect(summary.error).toContain("lock is already held");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires the stable 7z DLL before registry or shortcut repair", async () => {
    const root = makeRoot();
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);
      await rm(paths.sevenZipDllPath, { force: true });

      await expect(reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: paths.lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      })).rejects.toThrow(/7z helper DLL is missing/);

      expect(execFileMock).not.toHaveBeenCalled();
      const summary = JSON.parse(await readFile(join(installRoot, "logs", "updater", "latest-reconcile.json"), "utf8")) as {
        error: string;
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        operation: "reconcile",
        status: "failed",
      });
      expect(summary.error).toContain("7z helper DLL is missing");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires stable launcher-layer files to be normal files before registry or shortcut repair", async () => {
    const root = makeRoot();
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);
      await rm(paths.sevenZipPath, { force: true });
      await mkdir(paths.sevenZipPath, { recursive: true });

      await expect(reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: paths.lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      })).rejects.toThrow(/7z helper is missing/);

      expect(execFileMock).not.toHaveBeenCalled();
      const summary = JSON.parse(await readFile(join(installRoot, "logs", "updater", "latest-reconcile.json"), "utf8")) as {
        error: string;
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        operation: "reconcile",
        status: "failed",
      });
      expect(summary.error).toContain("7z helper is missing");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects install metadata namespace mismatch before registry or shortcut repair", async () => {
    const root = makeRoot();
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);
      const metadata = JSON.parse(await readFile(paths.installMetadataPath, "utf8")) as Record<string, unknown>;
      await writeFile(paths.installMetadataPath, JSON.stringify({
        ...metadata,
        namespace: "release-preview-win",
      }), "utf8");

      await expect(reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: paths.lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      })).rejects.toThrow(/install metadata namespace mismatch/);

      expect(execFileMock).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(paths.installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
        namespace: "release-preview-win",
      });
      const summary = JSON.parse(await readFile(join(installRoot, "logs", "updater", "latest-reconcile.json"), "utf8")) as {
        error: string;
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        operation: "reconcile",
        status: "failed",
      });
      expect(summary.error).toContain("install metadata namespace mismatch");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects non install-root runtime namespace roots before registry or shortcut repair", async () => {
    const root = makeRoot();
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);
      const runtime = JSON.parse(await readFile(paths.runtimeConfigPath, "utf8")) as Record<string, unknown>;
      await writeFile(paths.runtimeConfigPath, JSON.stringify({
        ...runtime,
        namespaceRoot: "namespaces/release-beta-win",
      }), "utf8");

      await expect(reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: paths.lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      })).rejects.toThrow(/runtime config is missing or invalid/);

      expect(execFileMock).not.toHaveBeenCalled();
      const summary = JSON.parse(await readFile(join(installRoot, "logs", "updater", "latest-reconcile.json"), "utf8")) as {
        error: string;
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        operation: "reconcile",
        status: "failed",
      });
      expect(summary.error).toContain("runtime config is missing or invalid");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects Windows-unsafe launcher executable names before registry or shortcut repair", async () => {
    const root = makeRoot();
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);
      const metadata = JSON.parse(await readFile(paths.installMetadataPath, "utf8")) as Record<string, unknown>;
      await writeFile(paths.installMetadataPath, JSON.stringify({
        ...metadata,
        displayName: "NUL",
      }), "utf8");

      await expect(reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: paths.lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      })).rejects.toThrow(/safe Windows file name/);

      expect(execFileMock).not.toHaveBeenCalled();
      const summary = JSON.parse(await readFile(join(installRoot, "logs", "updater", "latest-reconcile.json"), "utf8")) as {
        error: string;
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        operation: "reconcile",
        status: "failed",
      });
      expect(summary.error).toContain("safe Windows file name");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires exact install-root schema paths before registry or shortcut repair", async () => {
    const root = makeRoot();
    const execFileMock = vi.fn<LauncherReconcileExecFile>(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const paths = await writeInstallFixture(installRoot);

      await expect(reconcileLauncherInstall({
        currentVersion: "1.0.1",
        execFile: execFileMock,
        installMetadataPath: paths.installMetadataPath,
        installRoot,
        launcherConfigPath: paths.launcherConfigPath,
        lockPath: join(installRoot, "state", "other-lock"),
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        runtimeConfigPath: paths.runtimeConfigPath,
      })).rejects.toThrow(/install-root path/);

      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
