import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { pathExists } from "../src/win/fs.js";
import { resolveWinInstallIdentity } from "../src/win/identity.js";
import {
  removePartialWinInstallRootIfUnlocked,
  removeWinShortcutResidues,
  resolveWinStartTarget,
} from "../src/win/lifecycle.js";
import { writeBuiltAppManifest } from "../src/win/manifest.js";
import { resolveWinPaths } from "../src/win/paths.js";
import {
  parseWinAppPathsRegistryEntry,
  resolveWinRegisteredPathsFromEntry,
  winAppPathsEntryMatches,
} from "../src/win/registry.js";

function createConfig(root: string, namespace: string): ToolPackConfig {
  return {
    appVersion: "0.8.0-beta.2",
    containerized: false,
    electronBuilderCliPath: "electron-builder",
    electronDistPath: "electron-dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace,
    platform: "win",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      cacheRoot: join(root, "cache"),
      output: {
        appBuilderRoot: join(root, "out", "win", "namespaces", namespace, "builder"),
        namespaceRoot: join(root, "out", "win", "namespaces", namespace),
        platformRoot: join(root, "out", "win"),
        root: join(root, "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, "runtime", "win", "namespaces"),
        namespaceRoot: join(root, "runtime", "win", "namespaces", namespace),
      },
      toolPackRoot: root,
    },
    signed: false,
    silent: true,
    to: "nsis",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

async function writeCompleteLauncherRoot(input: {
  config: ToolPackConfig;
  displayName: string;
  exeName: string;
  launcherExecutablePath: string;
  launcherInstallRoot: string;
}): Promise<void> {
  if (input.config.appVersion == null) throw new Error("test config must define appVersion");
  const version = input.config.appVersion;
  const versionDescriptor = {
    apps: {},
    entry: {
      args: [],
      cwd: "payload",
      env: {},
      executable: "payload/Open Design.exe",
    },
    root: `versions/${version}`,
    version,
  };

  await mkdir(join(input.launcherInstallRoot, "lib", "7z"), { recursive: true });
  await mkdir(join(input.launcherInstallRoot, "versions", version, "payload"), { recursive: true });
  await writeFile(join(input.launcherInstallRoot, "install.json"), `${JSON.stringify({
    currentVersion: version,
    displayName: input.displayName,
    exeName: input.exeName,
    helpers: {
      sevenZip: "lib/7z/7z.exe",
      sevenZipDll: "lib/7z/7z.dll",
    },
    launcher: { executable: input.exeName },
    namespace: input.config.namespace,
    runtimePath: "runtime.json",
    schemaVersion: 1,
    versionsRoot: "versions",
  }, null, 2)}\n`, "utf8");
  await writeFile(join(input.launcherInstallRoot, "launcher.json"), `${JSON.stringify({
    attemptPath: "state/attempt.json",
    runtimePath: "runtime.json",
    schemaVersion: 1,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(input.launcherInstallRoot, "runtime.json"), `${JSON.stringify({
    active: versionDescriptor,
    generation: 0,
    lastSuccessful: versionDescriptor,
    namespace: input.config.namespace,
    namespaceRoot: ".",
    schemaVersion: 1,
  }, null, 2)}\n`, "utf8");
  await writeFile(join(input.launcherInstallRoot, "lib", "7z", "7z.exe"), "7z exe\n", "utf8");
  await writeFile(join(input.launcherInstallRoot, "lib", "7z", "7z.dll"), "7z dll\n", "utf8");
  await writeFile(join(input.launcherInstallRoot, "versions", version, "payload", "Open Design.exe"), "payload exe\n", "utf8");
  await writeFile(input.launcherExecutablePath, "launcher executable\n", "utf8");
}

describe("Windows packaged lifecycle launcher start target", () => {
  it("prefers the assembled launcher root over the flat Electron build output", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const config = createConfig(root, `lifecycle-${process.pid}-${Date.now()}`);
    const paths = resolveWinPaths(config);
    const identity = resolveWinInstallIdentity(config);
    const flatExecutablePath = join(paths.unpackedRoot, "Open Design.exe");
    const launcherExecutablePath = join(paths.launcherInstallRoot, identity.exeName);

    try {
      await mkdir(paths.unpackedRoot, { recursive: true });
      await mkdir(paths.launcherInstallRoot, { recursive: true });
      await writeFile(flatExecutablePath, "flat electron executable\n", "utf8");
      await writeCompleteLauncherRoot({
        config,
        displayName: identity.displayName,
        exeName: identity.exeName,
        launcherExecutablePath,
        launcherInstallRoot: paths.launcherInstallRoot,
      });
      await writeBuiltAppManifest(paths, {
        appBuilderOutputRoot: paths.appBuilderOutputRoot,
        cacheEntryPath: null,
        configPath: paths.packagedConfigPath,
        executablePath: flatExecutablePath,
        source: "namespace",
        unpackedRoot: paths.unpackedRoot,
        webStandaloneHookAuditPath: null,
      });

      await expect(resolveWinStartTarget(config)).resolves.toEqual({
        configPath: null,
        executablePath: launcherExecutablePath,
        source: "built",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("ignores incomplete assembled launcher roots when choosing a built start target", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const config = createConfig(root, `lifecycle-${process.pid}-${Date.now()}`);
    const paths = resolveWinPaths(config);
    const identity = resolveWinInstallIdentity(config);
    const flatExecutablePath = join(paths.unpackedRoot, "Open Design.exe");
    const launcherExecutablePath = join(paths.launcherInstallRoot, identity.exeName);

    try {
      await mkdir(paths.unpackedRoot, { recursive: true });
      await mkdir(paths.launcherInstallRoot, { recursive: true });
      await writeFile(flatExecutablePath, "flat electron executable\n", "utf8");
      await writeFile(launcherExecutablePath, "partial launcher executable\n", "utf8");
      await writeBuiltAppManifest(paths, {
        appBuilderOutputRoot: paths.appBuilderOutputRoot,
        cacheEntryPath: null,
        configPath: paths.packagedConfigPath,
        executablePath: flatExecutablePath,
        source: "namespace",
        unpackedRoot: paths.unpackedRoot,
        webStandaloneHookAuditPath: null,
      });

      await expect(resolveWinStartTarget(config)).resolves.toEqual({
        configPath: paths.packagedConfigPath,
        executablePath: flatExecutablePath,
        source: "built",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back to the flat Electron build when no assembled launcher exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const config = createConfig(root, `lifecycle-${process.pid}-${Date.now()}`);
    const paths = resolveWinPaths(config);
    const flatExecutablePath = join(paths.unpackedRoot, "Open Design.exe");

    try {
      await mkdir(paths.unpackedRoot, { recursive: true });
      await writeFile(flatExecutablePath, "flat electron executable\n", "utf8");
      await writeBuiltAppManifest(paths, {
        appBuilderOutputRoot: paths.appBuilderOutputRoot,
        cacheEntryPath: null,
        configPath: paths.packagedConfigPath,
        executablePath: flatExecutablePath,
        source: "namespace",
        unpackedRoot: paths.unpackedRoot,
        webStandaloneHookAuditPath: null,
      });

      await expect(resolveWinStartTarget(config)).resolves.toEqual({
        configPath: paths.packagedConfigPath,
        executablePath: flatExecutablePath,
        source: "built",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not treat a directory from the built manifest as a startable executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const config = createConfig(root, `lifecycle-${process.pid}-${Date.now()}`);
    const paths = resolveWinPaths(config);
    const directoryExecutablePath = join(paths.unpackedRoot, "Open Design.exe");

    try {
      await mkdir(directoryExecutablePath, { recursive: true });
      await writeBuiltAppManifest(paths, {
        appBuilderOutputRoot: paths.appBuilderOutputRoot,
        cacheEntryPath: null,
        configPath: paths.packagedConfigPath,
        executablePath: directoryExecutablePath,
        source: "namespace",
        unpackedRoot: paths.unpackedRoot,
        webStandaloneHookAuditPath: null,
      });

      await expect(resolveWinStartTarget(config)).rejects.toThrow(/no windows app executable found/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("removes a partial launcher install root when no NSIS uninstaller exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const installDir = join(root, "external-install", "Open Design");
    const uninstallerPath = join(installDir, "Uninstall Open Design.exe");

    try {
      await mkdir(join(installDir, "versions", "0.8.0-beta.2"), { recursive: true });
      await writeFile(join(installDir, "install.json"), "{}\n", "utf8");
      await writeFile(join(installDir, "runtime.json"), "{}\n", "utf8");

      await expect(removePartialWinInstallRootIfUnlocked({ installDir, uninstallerPath })).resolves.toBe(true);
      await expect(pathExists(installDir)).resolves.toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not remove a partial launcher install root while the shared lock exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const installDir = join(root, "external-install", "Open Design");
    const uninstallerPath = join(installDir, "Uninstall Open Design.exe");

    try {
      await mkdir(join(installDir, "state", "lock"), { recursive: true });
      await writeFile(join(installDir, "runtime.json"), "{}\n", "utf8");

      await expect(removePartialWinInstallRootIfUnlocked({ installDir, uninstallerPath })).rejects.toThrow(/cleanup launcher root/);
      await expect(pathExists(installDir)).resolves.toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("leaves a complete launcher install root for the NSIS uninstaller path", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const installDir = join(root, "external-install", "Open Design");
    const uninstallerPath = join(installDir, "Uninstall Open Design.exe");

    try {
      await mkdir(installDir, { recursive: true });
      await writeFile(uninstallerPath, "uninstaller\n", "utf8");
      await writeFile(join(installDir, "runtime.json"), "{}\n", "utf8");

      await expect(removePartialWinInstallRootIfUnlocked({ installDir, uninstallerPath })).resolves.toBe(false);
      await expect(pathExists(installDir)).resolves.toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("removes shortcut residues created by launcher reconciliation without an NSIS uninstaller", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const paths = {
      publicDesktopShortcutPath: join(root, "public-desktop", "Open Design smoke.lnk"),
      startMenuShortcutPath: join(root, "start-menu", "Open Design smoke.lnk"),
      userDesktopShortcutPath: join(root, "user-desktop", "Open Design smoke.lnk"),
    };

    try {
      await mkdir(join(root, "public-desktop"), { recursive: true });
      await mkdir(join(root, "start-menu"), { recursive: true });
      await mkdir(join(root, "user-desktop"), { recursive: true });
      await writeFile(paths.publicDesktopShortcutPath, "shortcut\n", "utf8");
      await writeFile(paths.startMenuShortcutPath, "shortcut\n", "utf8");
      await writeFile(paths.userDesktopShortcutPath, "shortcut\n", "utf8");

      await removeWinShortcutResidues(paths);

      await expect(pathExists(paths.publicDesktopShortcutPath)).resolves.toBe(false);
      await expect(pathExists(paths.startMenuShortcutPath)).resolves.toBe(false);
      await expect(pathExists(paths.userDesktopShortcutPath)).resolves.toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("observes App Paths residues only when they point at this launcher install", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const config = createConfig(root, "release-beta-win");
    const paths = resolveWinPaths(config);
    const appPathsKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe";
    const entry = parseWinAppPathsRegistryEntry(
      appPathsKey,
      [
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
        `    (Default)    REG_SZ    ${paths.installedExePath}`,
        "",
      ].join("\r\n"),
    );
    const otherEntry = parseWinAppPathsRegistryEntry(
      appPathsKey,
      [
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
        `    (Default)    REG_SZ    ${join(root, "other", "Open Design Beta.exe")}`,
        "",
      ].join("\r\n"),
    );
    const builtLauncherEntry = parseWinAppPathsRegistryEntry(
      appPathsKey,
      [
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
        `    (Default)    REG_SZ    ${join(paths.launcherInstallRoot, "Open Design Beta.exe")}`,
        "",
      ].join("\r\n"),
    );
    const localizedDefaultEntry = parseWinAppPathsRegistryEntry(
      appPathsKey,
      [
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
        `    (LocalizedDefault)    REG_SZ    ${paths.installedExePath}`,
        "",
      ].join("\r\n"),
    );

    try {
      expect(entry).toEqual({
        defaultPath: paths.installedExePath,
        keyPath: "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Open Design Beta.exe",
      });
      expect(localizedDefaultEntry.defaultPath).toBe(paths.installedExePath);
      expect(winAppPathsEntryMatches(paths, entry)).toBe(true);
      expect(winAppPathsEntryMatches(paths, builtLauncherEntry, config)).toBe(true);
      expect(winAppPathsEntryMatches(paths, otherEntry)).toBe(false);

      const lifecycleSource = await readFile(new URL("../src/win/lifecycle.ts", import.meta.url), "utf8");
      expect(lifecycleSource).toContain("queryWinRegistryResiduePaths(paths, config)");
      expect(lifecycleSource).toContain("queryWinRegistryResiduePaths(registeredPaths, config)");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("derives registered lifecycle executables from the stable launcher identity, not stale DisplayIcon paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-lifecycle-"));
    const config = createConfig(root, "release-beta-win");
    const paths = resolveWinPaths(config);
    const identity = resolveWinInstallIdentity(config);
    const stalePayloadExe = join(paths.installDir, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");

    try {
      const registered = resolveWinRegisteredPathsFromEntry(config, paths, {
        displayIcon: `${stalePayloadExe},0`,
        displayName: "Open Design Beta",
        displayVersion: "0.8.0-beta.2",
        installLocation: paths.installDir,
        keyPath: "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Open Design-release-beta-win",
        publisher: "Open Design",
        quietUninstallString: `"${paths.uninstallerPath}" /currentuser /S`,
        uninstallString: `"${paths.uninstallerPath}" /currentuser`,
      });

      expect(registered.installedExePath).toBe(join(paths.installDir, identity.exeName));
      expect(registered.installedExePath).not.toBe(stalePayloadExe);
      expect(registered.uninstallerPath).toBe(paths.uninstallerPath);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
