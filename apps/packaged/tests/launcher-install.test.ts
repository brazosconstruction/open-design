import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePackagedLauncherInstallContext } from "../src/launcher-install.js";

function runtimeConfigJson(namespace: string, options: {
  activeCwd?: string;
  activeExecutable?: string;
  activeVersion?: string;
  lastSuccessfulCwd?: string;
  lastSuccessfulExecutable?: string;
  lastSuccessfulVersion?: string;
  namespaceRoot?: string;
} = {}): string {
  const activeVersion = options.activeVersion ?? "0.8.0-beta.2";
  const lastSuccessfulVersion = options.lastSuccessfulVersion ?? activeVersion;
  const activeExecutable = options.activeExecutable ?? "payload/Open Design.exe";
  const activeCwd = options.activeCwd ?? "payload";
  const lastSuccessfulExecutable = options.lastSuccessfulExecutable ?? "payload/Open Design.exe";
  const lastSuccessfulCwd = options.lastSuccessfulCwd ?? "payload";
  const namespaceRoot = options.namespaceRoot ?? ".";
  return JSON.stringify({
    active: {
      apps: {},
      entry: { args: [], cwd: activeCwd, env: {}, executable: activeExecutable },
      root: `versions/${activeVersion}`,
      version: activeVersion,
    },
    generation: 1,
    lastSuccessful: {
      apps: {},
      entry: { args: [], cwd: lastSuccessfulCwd, env: {}, executable: lastSuccessfulExecutable },
      root: `versions/${lastSuccessfulVersion}`,
      version: lastSuccessfulVersion,
    },
    namespace,
    namespaceRoot,
    schemaVersion: 1,
  });
}

describe("packaged launcher install context", () => {
  it("detects the launcher install root from a Windows version payload executable", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");

    expect(resolvePackagedLauncherInstallContext(executablePath)).toEqual({
      cleanupMarkerPath: win32.join(installRoot, "state", "cleanup.json"),
      installMetadataPath: win32.join(installRoot, "install.json"),
      launcherConfigPath: win32.join(installRoot, "launcher.json"),
      installRoot,
      lockPath: win32.join(installRoot, "state", "lock"),
      payloadRoot: win32.join(installRoot, "versions", "0.8.0-beta.2", "payload"),
      runtimeConfigPath: win32.join(installRoot, "runtime.json"),
      sevenZipDllPath: win32.join(installRoot, "lib", "7z", "7z.dll"),
      sevenZipPath: win32.join(installRoot, "lib", "7z", "7z.exe"),
      version: "0.8.0-beta.2",
      versionRoot: win32.join(installRoot, "versions", "0.8.0-beta.2"),
    });
  });

  it("detects the launcher install root from a posix-style version payload executable", () => {
    const installRoot = "/Users/ada/Library/Application Support/Open Design Beta";
    const executablePath = posix.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design");

    expect(resolvePackagedLauncherInstallContext(executablePath)).toMatchObject({
      cleanupMarkerPath: posix.join(installRoot, "state", "cleanup.json"),
      installMetadataPath: posix.join(installRoot, "install.json"),
      launcherConfigPath: posix.join(installRoot, "launcher.json"),
      installRoot,
      lockPath: posix.join(installRoot, "state", "lock"),
      payloadRoot: posix.join(installRoot, "versions", "0.8.0-beta.2", "payload"),
      runtimeConfigPath: posix.join(installRoot, "runtime.json"),
      sevenZipDllPath: posix.join(installRoot, "lib", "7z", "7z.dll"),
      sevenZipPath: posix.join(installRoot, "lib", "7z", "7z.exe"),
      version: "0.8.0-beta.2",
    });
  });

  it("returns null for the old flat Electron install layout", () => {
    expect(
      resolvePackagedLauncherInstallContext(
        "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta\\Open Design.exe",
      ),
    ).toBeNull();
  });

  it("returns null for non-canonical launcher version path segments", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";

    expect(
      resolvePackagedLauncherInstallContext(
        win32.join(installRoot, "versions", " 0.8.0-beta.2", "payload", "Open Design.exe"),
      ),
    ).toBeNull();
    expect(
      resolvePackagedLauncherInstallContext(
        win32.join(installRoot, "versions", "NUL", "payload", "Open Design.exe"),
      ),
    ).toBeNull();
  });

  it("requires valid install-root markers before enabling updater launcher context", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win")],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toMatchObject({
      installRoot,
      sevenZipDllPath,
      sevenZipPath,
    });

    files.set(installMetadataPath, JSON.stringify({
      currentVersion: "0.8.0-beta.2",
      displayName: "Open Design Beta",
      exeName: "Open Design Beta.exe",
      helpers: { sevenZip: "lib/7z/7z.exe" },
      namespace: "release-beta-win",
      runtimePath: "runtime.json",
      schemaVersion: 1,
      versionsRoot: "versions",
    }));
    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();

    files.set(installMetadataPath, JSON.stringify({
      currentVersion: "0.8.0-beta.2",
      displayName: "Open Design Beta",
      exeName: "Open Design Beta.exe",
      helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "versions/0.8.0-beta.2/payload/7z.dll" },
      namespace: "release-beta-win",
      runtimePath: "runtime.json",
      schemaVersion: 1,
      versionsRoot: "versions",
    }));
    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();

    files.set(installMetadataPath, JSON.stringify({
      currentVersion: "0.8.0-beta.2",
      displayName: "Open Design Beta",
      exeName: "Open Design Beta.exe",
      helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
      namespace: "release-beta-win",
      runtimePath: "runtime.json",
      schemaVersion: 1,
      versionsRoot: "versions",
    }));
    files.delete(sevenZipPath);
    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();

    files.set(sevenZipPath, "");
    files.delete(sevenZipDllPath);
    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("requires real install-root marker files when using filesystem checks", () => {
    const root = mkdtempSync(join(tmpdir(), "od-packaged-launcher-install-test-"));
    try {
      const installRoot = join(root, "Open Design Beta");
      const version = "0.8.0-beta.2";
      const executablePath = join(installRoot, "versions", version, "payload", "Open Design.exe");
      const launcherPath = join(installRoot, "Open Design Beta.exe");
      const launcherConfigPath = join(installRoot, "launcher.json");
      const installMetadataPath = join(installRoot, "install.json");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const sevenZipPath = join(installRoot, "lib", "7z", "7z.exe");
      const sevenZipDllPath = join(installRoot, "lib", "7z", "7z.dll");

      mkdirSync(join(installRoot, "versions", version, "payload"), { recursive: true });
      mkdirSync(join(installRoot, "lib", "7z"), { recursive: true });
      writeFileSync(executablePath, "payload", "utf8");
      writeFileSync(launcherPath, "launcher", "utf8");
      writeFileSync(installMetadataPath, JSON.stringify({
        currentVersion: version,
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");
      writeFileSync(launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      }), "utf8");
      writeFileSync(runtimeConfigPath, runtimeConfigJson("release-beta-win"), "utf8");
      writeFileSync(sevenZipDllPath, "7z dll", "utf8");
      mkdirSync(sevenZipPath, { recursive: true });

      expect(resolvePackagedLauncherInstallContext(executablePath, {
        namespace: "release-beta-win",
        requireInstallRootMarkers: true,
      })).toBeNull();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses displayName-derived launcher identity when stale metadata executable fields need repair", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open Design Beta",
        exeName: "Open Design.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        launcher: { executable: "Open Design.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win")],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toMatchObject({
      installRoot,
      version: "0.8.0-beta.2",
    });
  });

  it("rejects malformed install-root markers before exposing updater launcher context", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, JSON.stringify({
        namespace: "release-beta-win",
        schemaVersion: 1,
      })],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("rejects non install-root runtime namespace roots before exposing updater launcher context", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win", {
        namespaceRoot: "namespaces/release-beta-win",
      })],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("rejects Windows-unsafe launcher executable names before exposing updater launcher context", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open:Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win")],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("rejects namespace-mismatched install roots before exposing updater launcher context", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-preview-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-preview-win")],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("rejects missing or malformed launcher config before exposing updater launcher context", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.2",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        runtimePath: "versions/0.8.0-beta.2/runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win")],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();

    files.delete(launcherConfigPath);
    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("accepts fallback payload launches but rejects runtime descriptors unrelated to the running payload", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.3",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win", {
        activeVersion: "0.8.0-beta.3",
        lastSuccessfulVersion: "0.8.0-beta.2",
      })],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);
    const options = {
      namespace: "release-beta-win",
      pathExists: (path: string) => files.has(path),
      readTextFile: (path: string) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    };

    expect(resolvePackagedLauncherInstallContext(executablePath, options)).toMatchObject({
      installRoot,
      version: "0.8.0-beta.2",
    });

    files.set(runtimeConfigPath, runtimeConfigJson("release-beta-win", {
      activeVersion: "0.8.0-beta.3",
      lastSuccessfulVersion: "0.8.0-beta.1",
    }));
    expect(resolvePackagedLauncherInstallContext(executablePath, options)).toBeNull();
  });

  it("rejects launcher context when any runtime descriptor still uses the flat legacy executable shape", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.3",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win", {
        activeCwd: ".",
        activeExecutable: "Open Design.exe",
        activeVersion: "0.8.0-beta.3",
        lastSuccessfulVersion: "0.8.0-beta.2",
      })],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("rejects launcher context when runtime descriptors use Windows-reserved version path segments", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "NUL", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "NUL",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win", {
        activeVersion: "NUL",
      })],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);

    expect(resolvePackagedLauncherInstallContext(executablePath, {
      namespace: "release-beta-win",
      pathExists: (path) => files.has(path),
      readTextFile: (path) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    })).toBeNull();
  });

  it("rejects runtime descriptors whose running version entry does not match the payload executable", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");
    const launcherPath = win32.join(installRoot, "Open Design Beta.exe");
    const launcherConfigPath = win32.join(installRoot, "launcher.json");
    const installMetadataPath = win32.join(installRoot, "install.json");
    const runtimeConfigPath = win32.join(installRoot, "runtime.json");
    const sevenZipPath = win32.join(installRoot, "lib", "7z", "7z.exe");
    const sevenZipDllPath = win32.join(installRoot, "lib", "7z", "7z.dll");
    const files = new Map([
      [installMetadataPath, JSON.stringify({
        currentVersion: "0.8.0-beta.3",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe", sevenZipDll: "lib/7z/7z.dll" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      })],
      [launcherConfigPath, JSON.stringify({
        attemptPath: "state/attempt.json",
        runtimePath: "runtime.json",
        schemaVersion: 1,
      })],
      [runtimeConfigPath, runtimeConfigJson("release-beta-win", {
        activeVersion: "0.8.0-beta.3",
        lastSuccessfulExecutable: "payload/Other.exe",
        lastSuccessfulVersion: "0.8.0-beta.2",
      })],
      [launcherPath, ""],
      [sevenZipDllPath, ""],
      [sevenZipPath, ""],
    ]);
    const options = {
      namespace: "release-beta-win",
      pathExists: (path: string) => files.has(path),
      readTextFile: (path: string) => {
        const content = files.get(path);
        if (content == null) throw new Error(`missing ${path}`);
        return content;
      },
      requireInstallRootMarkers: true,
    };

    expect(resolvePackagedLauncherInstallContext(executablePath, options)).toBeNull();

    files.set(runtimeConfigPath, runtimeConfigJson("release-beta-win", {
      activeCwd: ".",
      activeVersion: "0.8.0-beta.2",
      lastSuccessfulVersion: "0.8.0-beta.1",
    }));
    expect(resolvePackagedLauncherInstallContext(executablePath, options)).toBeNull();
  });
});
