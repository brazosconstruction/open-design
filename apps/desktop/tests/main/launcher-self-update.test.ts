import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildLauncherSelfUpdateHelperScript,
  scheduleLauncherSelfUpdate,
} from "../../src/main/launcher-self-update.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "od-launcher-self-update-test-"));
}

async function waitForTextFile(path: string, timeoutMs = 10_000): Promise<string> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`timed out waiting for ${path}`);
}

async function waitForPathAbsent(path: string, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${path} to be removed`);
}

async function removeRoot(path: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(path, { force: true, recursive: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`failed to remove ${path}`);
}

describe("launcher self-update", () => {
  it("schedules a hidden PowerShell helper for top-level launcher replacement", async () => {
    const root = makeRoot();
    const launchHelper = vi.fn(async (_command: string, _args: string[], _options: { cwd: string; windowsHide: true }) => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const candidatePath = join(installRoot, "versions", "1.0.1", "launcher", "Open Design Beta.exe");
      const targetPath = join(installRoot, "Open Design Beta.exe");
      const lockPath = join(installRoot, "state", "lock");
      await mkdir(join(installRoot, "versions", "1.0.1", "launcher"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeFile(candidatePath, "new launcher", "utf8");
      await writeFile(targetPath, "old launcher", "utf8");

      const scheduled = await scheduleLauncherSelfUpdate({
        candidatePath,
        installRoot,
        launchHelper,
        lockPath,
        namespace: "release-beta-win",
        now: () => new Date("2026-05-25T00:00:00.000Z"),
        platform: "win32",
        targetPath,
      });

      expect(scheduled).toMatchObject({
        ok: true,
      });
      if (!scheduled.ok) throw new Error("expected launcher self-update to schedule");
      expect(scheduled.latestSummaryPath).toBe(join(installRoot, "logs", "updater", "latest-launcher-self-update.json"));
      expect(scheduled.summaryPath).toContain("launcher-self-update");
      expect(existsSync(scheduled.helperPath)).toBe(true);
      expect(existsSync(scheduled.launcherPath)).toBe(true);
      expect(await readFile(scheduled.helperPath, "utf8")).toContain("operation = \"launcher-self-update\"");
      expect(await readFile(scheduled.helperPath, "utf8")).toContain("[System.IO.FileShare]::None");
      expect(await readFile(scheduled.launcherPath, "utf8")).toContain("Start-Process -FilePath $PowerShellPath -WindowStyle Hidden -WorkingDirectory $InstallRoot");
      expect(launchHelper).toHaveBeenCalledTimes(1);
      const [command, args, options] = launchHelper.mock.calls[0] ?? [];
      expect(command).toMatch(/powershell\.exe$/i);
      expect(args).toContain("-ExecutionPolicy");
      expect(args).toContain("Bypass");
      expect(args[args.indexOf("-File") + 1]).toBe(relative(installRoot, scheduled.launcherPath));
      expect(args[args.indexOf("-HelperPath") + 1]).toBe(relative(installRoot, scheduled.helperPath));
      expect(args[args.indexOf("-SummaryPath") + 1]).toBe(relative(installRoot, scheduled.summaryPath));
      expect(args[args.indexOf("-LatestSummaryPath") + 1]).toBe(relative(installRoot, scheduled.latestSummaryPath));
      expect(args[args.indexOf("-LogPath") + 1]).toBe(relative(installRoot, scheduled.logPath));
      expect(args).toContain("-CandidatePath");
      expect(args).toContain(candidatePath);
      expect(args).toContain("-TargetPath");
      expect(args).toContain(targetPath);
      expect(options).toMatchObject({ cwd: installRoot, windowsHide: true });
    } finally {
      await removeRoot(root);
    }
  });

  it("rejects targets outside the top-level install root", async () => {
    const root = makeRoot();
    const launchHelper = vi.fn(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(
        root,
        `install-root-with-long-self-update-observation-path-segment-${"x".repeat(55)}`,
        "Open Design",
      );
      const candidatePath = join(installRoot, "versions", "1.0.1", "launcher", "Open Design Beta.exe");
      await mkdir(join(installRoot, "versions", "1.0.1", "launcher"), { recursive: true });
      await writeFile(candidatePath, "new launcher", "utf8");

      await expect(scheduleLauncherSelfUpdate({
        candidatePath,
        installRoot,
        launchHelper,
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        platform: "win32",
        targetPath: join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"),
      })).rejects.toThrow(/top-level install-root file/);
      expect(launchHelper).not.toHaveBeenCalled();
    } finally {
      await removeRoot(root);
    }
  });

  it("requires the exact shared install-root lock path", async () => {
    const root = makeRoot();
    const launchHelper = vi.fn(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const candidatePath = join(installRoot, "versions", "1.0.1", "launcher", "Open Design Beta.exe");
      const targetPath = join(installRoot, "Open Design Beta.exe");
      await mkdir(join(installRoot, "versions", "1.0.1", "launcher"), { recursive: true });
      await writeFile(candidatePath, "new launcher", "utf8");
      await writeFile(targetPath, "old launcher", "utf8");

      await expect(scheduleLauncherSelfUpdate({
        candidatePath,
        installRoot,
        launchHelper,
        lockPath: join(installRoot, "state", "other-lock"),
        namespace: "release-beta-win",
        platform: "win32",
        targetPath,
      })).rejects.toThrow(/install-root path/);
      expect(launchHelper).not.toHaveBeenCalled();
    } finally {
      await removeRoot(root);
    }
  });

  it("requires candidates to come from the promoted version launcher directory", async () => {
    const root = makeRoot();
    const launchHelper = vi.fn(async () => ({
      stderr: "",
      stdout: "",
    }));
    try {
      const installRoot = join(root, "Open Design");
      const candidatePath = join(installRoot, "versions", "1.0.1", "payload", "Open Design Beta.exe");
      const targetPath = join(installRoot, "Open Design Beta.exe");
      await mkdir(join(installRoot, "versions", "1.0.1", "payload"), { recursive: true });
      await writeFile(candidatePath, "not a launcher candidate", "utf8");
      await writeFile(targetPath, "old launcher", "utf8");

      await expect(scheduleLauncherSelfUpdate({
        candidatePath,
        installRoot,
        launchHelper,
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        platform: "win32",
        targetPath,
      })).rejects.toThrow(/versions\/<version>\/launcher/);
      expect(launchHelper).not.toHaveBeenCalled();
    } finally {
      await removeRoot(root);
    }
  });

  it("keeps helper replacement semantics fail-fast and restorable", () => {
    const script = buildLauncherSelfUpdateHelperScript();

    expect(script).toContain("New-Item -ItemType Directory -Path $LockPath -ErrorAction Stop");
    expect(script).toContain("Convert-ToExtendedLengthPath");
    expect(script).toContain("[System.IO.File]::WriteAllText((Convert-ToExtendedLengthPath $SummaryPath)");
    expect(script).toContain("Test-ExclusiveFileAccess -Path $TargetPath");
    expect(script).toContain("Move-Item -LiteralPath $TargetPath -Destination $backupPath -Force");
    expect(script).toContain("Move-Item -LiteralPath $backupPath -Destination $TargetPath -Force");
    expect(script).toContain("$LatestSummaryPath");
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("runs the hidden PowerShell helper and writes the self-update observation", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "Open Design");
      const candidatePath = join(installRoot, "versions", "1.0.1", "launcher", "Open Design Beta.exe");
      const targetPath = join(installRoot, "Open Design Beta.exe");
      const lockPath = join(installRoot, "state", "lock");
      await mkdir(join(installRoot, "versions", "1.0.1", "launcher"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeFile(candidatePath, "new launcher", "utf8");
      await writeFile(targetPath, "old launcher", "utf8");

      const scheduled = await scheduleLauncherSelfUpdate({
        candidatePath,
        installRoot,
        lockPath,
        namespace: "release-beta-win",
        targetPath,
      });

      expect(scheduled.ok).toBe(true);
      if (!scheduled.ok) throw new Error("expected launcher self-update to schedule");
      const summary = JSON.parse(await waitForTextFile(scheduled.latestSummaryPath)) as {
        details?: { candidatePath?: string; targetPath?: string };
        operation: string;
        status: string;
      };
      expect(summary).toMatchObject({
        details: {
          candidatePath,
          targetPath,
        },
        operation: "launcher-self-update",
        status: "ok",
      });
      await expect(readFile(targetPath, "utf8")).resolves.toBe("new launcher");
      await waitForPathAbsent(lockPath);
    } finally {
      await removeRoot(root);
    }
  });
});
