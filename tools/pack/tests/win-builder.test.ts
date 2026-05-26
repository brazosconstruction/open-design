import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "../src/config.js";
import { materializeCachedUnpackedForInstaller } from "../src/win/builder.js";
import {
  assembleWinLauncherInstallRoot,
  buildWinInstallLockOwner,
  buildWinReadyCleanupMarker,
  createWinLauncherBuiltAppManifest,
  resolveWinLauncherInstallLayout,
  withWinLauncherInstallLock,
  writeWinLauncherUpdatePayloadArchive,
  writeWinCleanupMarker,
} from "../src/win/launcher-layout.js";
import { resolveWinPaths } from "../src/win/paths.js";
import type { WinPaths } from "../src/win/types.js";

function createPaths(root: string): WinPaths {
  const namespaceRoot = join(root, "namespaces", "second");
  return {
    appBuilderConfigPath: join(namespaceRoot, "builder-config.json"),
    appBuilderOutputRoot: join(namespaceRoot, "builder"),
    assembledAppRoot: join(namespaceRoot, "assembled", "app"),
    assembledMainEntryPath: join(namespaceRoot, "assembled", "app", "main.cjs"),
    assembledPackageJsonPath: join(namespaceRoot, "assembled", "app", "package.json"),
    assembledPrebundledRoot: join(namespaceRoot, "assembled", "app", "prebundled"),
    blockmapPath: join(namespaceRoot, "builder", "Open Design-second-setup.exe.blockmap"),
    builtManifestPath: join(namespaceRoot, "built-app.json"),
    daemonCliPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-cli.js"),
    daemonCliPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-cli.mjs"),
    daemonPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "daemon.meta.json"),
    daemonPrebundleRoot: join(namespaceRoot, "assembled", "app", "prebundled", "daemon"),
    daemonSidecarPrebundleEntrypointPath: join(namespaceRoot, "prebundle-entrypoints", "daemon-sidecar.js"),
    daemonSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "daemon", "daemon-sidecar.mjs"),
    exePath: join(namespaceRoot, "builder", "Open Design-second.exe"),
    installDir: join(namespaceRoot, "runtime", "install", "Open Design"),
    installedExePath: join(namespaceRoot, "runtime", "install", "Open Design", "Open Design.exe"),
    launcherInstallRoot: join(namespaceRoot, "installer", "app"),
    installerPayloadPath: join(namespaceRoot, "installer", "payload.7z"),
    installerScriptPath: join(namespaceRoot, "installer", "installer.nsi"),
    publicDesktopShortcutPath: join(namespaceRoot, "desktop", "public.lnk"),
    latestYmlPath: join(namespaceRoot, "builder", "latest.yml"),
    installMarkerPath: join(namespaceRoot, "logs", "install.marker.json"),
    installTimingPath: join(namespaceRoot, "logs", "install.timing.json"),
    nsisLogPath: join(namespaceRoot, "logs", "nsis.log"),
    nsisIncludePath: join(namespaceRoot, "nsis", "installer.nsh"),
    packagedConfigPath: join(namespaceRoot, "open-design-config.json"),
    packagedMainPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "packaged-main.meta.json"),
    packagedMainPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "packaged-main.mjs"),
    resourceRoot: join(namespaceRoot, "resources", "open-design"),
    setupPath: join(namespaceRoot, "builder", "Open Design-second-setup.exe"),
    startMenuShortcutPath: join(namespaceRoot, "start-menu.lnk"),
    tarballsRoot: join(namespaceRoot, "tarballs"),
    userDesktopShortcutPath: join(namespaceRoot, "desktop", "user.lnk"),
    uninstallMarkerPath: join(namespaceRoot, "logs", "uninstall.marker.json"),
    uninstallTimingPath: join(namespaceRoot, "logs", "uninstall.timing.json"),
    uninstallerPath: join(namespaceRoot, "runtime", "install", "Open Design", "Uninstall.exe"),
    webStandaloneHookAuditPath: join(namespaceRoot, "web-standalone-after-pack-audit.json"),
    webStandaloneHookConfigPath: join(namespaceRoot, "web-standalone-after-pack-config.json"),
    webSidecarPrebundleMetaPath: join(namespaceRoot, "prebundle-meta", "web-sidecar.meta.json"),
    webSidecarPrebundlePath: join(namespaceRoot, "assembled", "app", "prebundled", "web-sidecar.mjs"),
    winIconPath: join(namespaceRoot, "resources", "win", "icon.ico"),
    unpackedExePath: join(namespaceRoot, "builder", "win-unpacked", "Open Design.exe"),
    unpackedRoot: join(namespaceRoot, "builder", "win-unpacked"),
    updatePayloadPath: join(namespaceRoot, "builder", "Open Design-second-payload.7z"),
  };
}

function createConfig(root: string): ToolPackConfig {
  const namespace = "release-beta-win";
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

describe("materializeCachedUnpackedForInstaller", () => {
  it("assembles the launcher install root before the NSIS-only packaging branch", async () => {
    const source = await readFile(new URL("../src/win/builder.ts", import.meta.url), "utf8");
    const assemblyIndex = source.indexOf(
      "const launcherLayout = await buildWinLauncherInstallRootArtifacts(config, paths, launcherBuiltApp);",
    );
    const nsisBranchIndex = source.indexOf('if (config.to === "nsis" || config.to === "all")');

    expect(source).toContain("buildWinLauncherInstallRootArtifacts");
    expect(source).toContain(
      "const launcherBuiltApp = await materializeCachedUnpackedForInstaller(cachedUnpackedRoot, paths, packagedVersion);",
    );
    expect(source).toContain(
      "await writeBuiltAppManifest(paths, createWinLauncherBuiltAppManifest(launcherBuiltApp, launcherLayout));",
    );
    expect(assemblyIndex).toBeGreaterThan(-1);
    expect(nsisBranchIndex).toBeGreaterThan(-1);
    expect(assemblyIndex).toBeLessThan(nsisBranchIndex);
  });

  it("overwrites cached packaged config and app package version", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-builder-"));
    const cachedUnpackedRoot = join(root, "cache", "builder", "win-unpacked");
    const paths = createPaths(root);

    try {
      await mkdir(join(cachedUnpackedRoot, "resources"), { recursive: true });
      await writeFile(join(cachedUnpackedRoot, "Open Design.exe"), "exe\n", "utf8");
      await writeFile(
        join(cachedUnpackedRoot, "resources", "open-design-config.json"),
        `${JSON.stringify({ namespace: "first", version: 1 })}\n`,
        "utf8",
      );
      await mkdir(join(cachedUnpackedRoot, "resources", "app"), { recursive: true });
      await writeFile(
        join(cachedUnpackedRoot, "resources", "app", "package.json"),
        `${JSON.stringify({ name: "open-design-packaged-app", version: "0.5.0-beta.1" })}\n`,
        "utf8",
      );
      await mkdir(join(paths.packagedConfigPath, ".."), { recursive: true });
      await writeFile(paths.packagedConfigPath, `${JSON.stringify({ namespace: "second", version: 1 })}\n`, "utf8");

      const manifest = await materializeCachedUnpackedForInstaller(cachedUnpackedRoot, paths, "0.5.0-beta.2");

      expect(manifest.source).toBe("namespace");
      expect(manifest.unpackedRoot).toBe(paths.unpackedRoot);
      await expect(readFile(join(paths.unpackedRoot, "Open Design.exe"), "utf8")).resolves.toBe("exe\n");
      await expect(readFile(join(paths.unpackedRoot, "resources", "open-design-config.json"), "utf8")).resolves.toContain(
        '"namespace":"second"',
      );
      await expect(readFile(join(paths.unpackedRoot, "resources", "app", "package.json"), "utf8")).resolves.toContain(
        '"version": "0.5.0-beta.2"',
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("assembles a launcher install root with the Electron app under versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-launcher-layout-"));
    const config = createConfig(root);
    const paths = resolveWinPaths(config);
    const unpackedRoot = join(root, "builder", "win-unpacked");
    const launcherPath = join(root, "launcher", "open-design-launcher.exe");

    try {
      await mkdir(join(unpackedRoot, "resources"), { recursive: true });
      await writeFile(join(unpackedRoot, "Open Design.exe"), "payload exe\n", "utf8");
      await writeFile(join(unpackedRoot, "resources", "open-design-config.json"), "{}\n", "utf8");
      await mkdir(join(root, "launcher"), { recursive: true });
      await writeFile(launcherPath, "launcher exe\n", "utf8");
      const builtApp = {
        appBuilderOutputRoot: join(root, "builder"),
        cacheEntryPath: null,
        configPath: paths.packagedConfigPath,
        executablePath: join(unpackedRoot, "Open Design.exe"),
        source: "namespace" as const,
        unpackedRoot,
        version: 1 as const,
        webStandaloneHookAuditPath: null,
      };

      const layout = await assembleWinLauncherInstallRoot({
        builtApp,
        config,
        launcherExecutablePath: launcherPath,
        packagedVersion: "0.8.0-beta.2",
        paths,
      });

      expect(layout.root).toBe(paths.launcherInstallRoot);
      expect(layout.cleanupMarkerPath).toBe(join(paths.launcherInstallRoot, "state", "cleanup.json"));
      expect(layout.lockPath).toBe(join(paths.launcherInstallRoot, "state", "lock"));
      const manifest = createWinLauncherBuiltAppManifest(builtApp, layout);
      expect(manifest.executablePath).toBe(layout.publicExecutablePath);
      expect(manifest.unpackedRoot).toBe(layout.payloadRoot);
      expect(manifest.source).toBe("namespace");
      expect(layout.sevenZipExePath).toBe(join(paths.launcherInstallRoot, "lib", "7z", "7z.exe"));
      expect(layout.sevenZipDllPath).toBe(join(paths.launcherInstallRoot, "lib", "7z", "7z.dll"));
      await expect(readFile(join(paths.launcherInstallRoot, "Open Design Beta.exe"), "utf8")).resolves.toBe("launcher exe\n");
      await expect(readFile(join(paths.launcherInstallRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe"), "utf8")).resolves.toBe("payload exe\n");
      await expect(readFile(join(paths.launcherInstallRoot, "versions", "0.8.0-beta.2", "launcher", "Open Design Beta.exe"), "utf8")).resolves.toBe("launcher exe\n");
      await expect(readFile(join(paths.launcherInstallRoot, "Open Design.exe"), "utf8")).rejects.toThrow();
      await expect(readFile(join(paths.launcherInstallRoot, "lib", "7z", "7z.exe"))).resolves.toBeInstanceOf(Buffer);
      await expect(readFile(join(paths.launcherInstallRoot, "lib", "7z", "7z.dll"))).resolves.toBeInstanceOf(Buffer);
      await expect(readFile(join(paths.launcherInstallRoot, "versions", "0.8.0-beta.2", "lib", "7z", "7z.exe"))).rejects.toThrow();
      await expect(readFile(join(paths.launcherInstallRoot, "versions", "0.8.0-beta.2", "payload", "7z.exe"))).rejects.toThrow();

      const install = JSON.parse(await readFile(join(paths.launcherInstallRoot, "install.json"), "utf8")) as {
        currentVersion: string;
        displayName: string;
        exeName: string;
        helpers: { sevenZip: string; sevenZipDll: string };
        launcher: { executable: string };
        namespace: string;
      };
      expect(install).toMatchObject({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: {
          sevenZip: "lib/7z/7z.exe",
          sevenZipDll: "lib/7z/7z.dll",
        },
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
      });
      await expect(readFile(join(paths.launcherInstallRoot, "launcher.json"), "utf8")).resolves.toContain('"attemptPath": "state/attempt.json"');
      const runtime = JSON.parse(await readFile(join(paths.launcherInstallRoot, "runtime.json"), "utf8")) as {
        active: { entry: { cwd: string; executable: string }; root: string };
        lastSuccessful: { root: string };
        namespace: string;
        namespaceRoot: string;
      };
      expect(runtime.namespace).toBe("release-beta-win");
      expect(runtime.namespaceRoot).toBe(".");
      expect(runtime.active.root).toBe("versions/0.8.0-beta.2");
      expect(runtime.active.entry.cwd).toBe("payload");
      expect(runtime.active.entry.executable).toBe("payload/Open Design.exe");
      expect(runtime.lastSuccessful.root).toBe("versions/0.8.0-beta.2");
      await expect(readFile(join(paths.launcherInstallRoot, "versions", "0.8.0-beta.2", "manifest.json"), "utf8")).resolves.toContain(
        '"payloadRoot": "payload"',
      );
      expect((await readdir(join(paths.launcherInstallRoot, "versions", "0.8.0-beta.2"))).sort()).toEqual([
        "launcher",
        "manifest.json",
        "payload",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects unsafe packaged version path segments before writing launcher layout descriptors", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-launcher-version-"));
    const config = createConfig(root);
    const paths = resolveWinPaths(config);

    try {
      expect(() => resolveWinLauncherInstallLayout(config, paths, "0.8.0-beta.2/escaped")).toThrow(
        /safe path segment/,
      );
      expect(() => resolveWinLauncherInstallLayout(config, paths, " 0.8.0-beta.2")).toThrow(
        /safe path segment/,
      );
      expect(() => resolveWinLauncherInstallLayout(config, paths, "0.8.0-beta.2:ads")).toThrow(
        /safe path segment/,
      );
      expect(() => resolveWinLauncherInstallLayout(config, paths, "0.8.0-beta.2.")).toThrow(
        /safe path segment/,
      );
      expect(() => resolveWinLauncherInstallLayout(config, paths, "NUL")).toThrow(/safe path segment/);
      expect(() =>
        buildWinReadyCleanupMarker(
          config,
          { deleteVersions: [" 0.8.0-beta.1"], readyVersion: "0.8.1-beta.1" },
        ),
      ).toThrow(/safe path segment/);
      expect(() =>
        buildWinReadyCleanupMarker(
          config,
          { deleteVersions: ["0.8.0-beta.1"], readyVersion: ".." },
        ),
      ).toThrow(/safe path segment/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects launcher install roots with version-scoped 7z helpers in the payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-launcher-layout-7z-"));
    const config = createConfig(root);
    const paths = resolveWinPaths(config);
    const unpackedRoot = join(root, "builder", "win-unpacked");
    const launcherPath = join(root, "launcher", "open-design-launcher.exe");

    try {
      await mkdir(join(unpackedRoot, "resources"), { recursive: true });
      await writeFile(join(unpackedRoot, "Open Design.exe"), "payload exe\n", "utf8");
      await writeFile(join(unpackedRoot, "resources", "7z.dll"), "payload scoped 7z\n", "utf8");
      await mkdir(join(root, "launcher"), { recursive: true });
      await writeFile(launcherPath, "launcher exe\n", "utf8");
      const builtApp = {
        appBuilderOutputRoot: join(root, "builder"),
        cacheEntryPath: null,
        configPath: paths.packagedConfigPath,
        executablePath: join(unpackedRoot, "Open Design.exe"),
        source: "namespace" as const,
        unpackedRoot,
        version: 1 as const,
        webStandaloneHookAuditPath: null,
      };

      await expect(assembleWinLauncherInstallRoot({
        builtApp,
        config,
        launcherExecutablePath: launcherPath,
        packagedVersion: "0.8.0-beta.2",
        paths,
      })).rejects.toThrow(/version-scoped 7z helper/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects update payload archives with install-root layer entries under the version root", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-launcher-payload-shape-"));
    const config = createConfig(root);
    const paths = resolveWinPaths(config);
    const layout = resolveWinLauncherInstallLayout(config, paths, "0.8.0-beta.2");

    try {
      await mkdir(layout.payloadRoot, { recursive: true });
      await writeFile(layout.payloadExecutablePath, "payload exe\n", "utf8");
      await mkdir(join(layout.versionRoot, "state"), { recursive: true });

      await expect(writeWinLauncherUpdatePayloadArchive({ layout, paths })).rejects.toThrow(/install-root layer entry/);
      await expect(readFile(paths.updatePayloadPath, "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses one exact install-root lock path with owner metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-install-lock-"));
    const config = createConfig(root);
    const paths = resolveWinPaths(config);
    const layout = resolveWinLauncherInstallLayout(config, paths, "0.8.0-beta.2");

    try {
      const owner = buildWinInstallLockOwner(config, "cleanup", new Date("2026-05-25T00:00:00.000Z"));
      await withWinLauncherInstallLock(layout, owner, async () => {
        const ownerJson = JSON.parse(await readFile(join(layout.lockPath, "owner.json"), "utf8")) as {
          namespace: string;
          operation: string;
          schemaVersion: number;
          startedAt: string;
        };
        expect(ownerJson).toMatchObject({
          namespace: "release-beta-win",
          operation: "cleanup",
          schemaVersion: 1,
          startedAt: "2026-05-25T00:00:00.000Z",
        });
        await expect(
          withWinLauncherInstallLock(layout, owner, async () => "nested"),
        ).rejects.toThrow(/install root lock is already held/);
      });
      await expect(readFile(join(layout.lockPath, "owner.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes a lazy quick delete cleanup marker without deleting the ready version", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-cleanup-marker-"));
    const config = createConfig(root);
    const paths = resolveWinPaths(config);
    const layout = resolveWinLauncherInstallLayout(config, paths, "0.8.1-beta.1");

    try {
      const marker = buildWinReadyCleanupMarker(
        config,
        { deleteVersions: ["0.8.0-beta.1", "0.8.0-beta.1", "  "], readyVersion: "0.8.1-beta.1" },
        new Date("2026-05-25T01:00:00.000Z"),
      );
      expect(marker).toEqual({
        createdAt: "2026-05-25T01:00:00.000Z",
        namespace: "release-beta-win",
        readyVersion: "0.8.1-beta.1",
        schemaVersion: 1,
        strategy: "lazyQuickDelete",
        versions: [
          {
            root: "versions/0.8.0-beta.1",
            version: "0.8.0-beta.1",
          },
        ],
      });

      await writeWinCleanupMarker(layout, marker);
      await expect(readFile(layout.cleanupMarkerPath, "utf8")).resolves.toContain('"strategy": "lazyQuickDelete"');
      expect(() =>
        buildWinReadyCleanupMarker(config, { deleteVersions: ["0.8.1-beta.1"], readyVersion: "0.8.1-beta.1" }),
      ).toThrow(/must not delete the ready version/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
