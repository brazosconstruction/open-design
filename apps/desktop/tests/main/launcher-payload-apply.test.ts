import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  applyLauncherPayloadArchive,
  buildReadyCleanupMarker,
  confirmLauncherPayloadReady,
} from "../../src/main/launcher-payload-apply.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "od-launcher-payload-apply-test-"));
}

async function writePayloadExecutable(versionRoot: string, content: string): Promise<void> {
  await mkdir(join(versionRoot, "payload"), { recursive: true });
  await writeFile(join(versionRoot, "payload", "Open Design.exe"), content, "utf8");
}

async function writeLauncherConfig(installRoot: string): Promise<void> {
  await writeFile(join(installRoot, "launcher.json"), JSON.stringify({
    attemptPath: "state/attempt.json",
    runtimePath: "runtime.json",
    schemaVersion: 1,
  }), "utf8");
}

async function writeApplyBaseline(input: {
  installMetadataPath: string;
  installRoot: string;
  runtimeConfigPath: string;
}): Promise<void> {
  await mkdir(join(input.installRoot, "state"), { recursive: true });
  await writeLauncherConfig(input.installRoot);
  await writePayloadExecutable(join(input.installRoot, "versions", "1.0.0"), "old payload");
  await writeFile(input.runtimeConfigPath, JSON.stringify({
    active: {
      apps: {},
      entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
      root: "versions/1.0.0",
      version: "1.0.0",
    },
    generation: 1,
    lastSuccessful: {
      apps: {},
      entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
      root: "versions/1.0.0",
      version: "1.0.0",
    },
    namespace: "release-beta-win",
    namespaceRoot: ".",
    schemaVersion: 1,
  }), "utf8");
  await writeFile(input.installMetadataPath, JSON.stringify({
    currentVersion: "1.0.0",
    displayName: "Open Design Beta",
    exeName: "Open Design Beta.exe",
    launcher: { executable: "Open Design Beta.exe" },
    namespace: "release-beta-win",
    runtimePath: "runtime.json",
    schemaVersion: 1,
    versionsRoot: "versions",
  }), "utf8");
}

describe("launcher payload apply", () => {
  it("rejects Windows-unsafe version path segments before extracting a payload", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async () => undefined);
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");
      await writeApplyBaseline({ installMetadataPath, installRoot, runtimeConfigPath });

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1:bad",
      })).rejects.toThrow(/safe path segment/);
      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: " 1.0.1",
      })).rejects.toThrow(/safe path segment/);

      expect(extractor).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects Windows-unsafe cleanup marker versions", () => {
    expect(() =>
      buildReadyCleanupMarker({
        deleteVersions: ["1.0.0"],
        namespace: "release-beta-win",
        readyVersion: "NUL",
      }),
    ).toThrow(/safe path segment/);
    expect(() =>
      buildReadyCleanupMarker({
        deleteVersions: [" 1.0.0"],
        namespace: "release-beta-win",
        readyVersion: "1.0.1",
      }),
    ).toThrow(/safe path segment/);
  });

  it("rejects Windows-unsafe launcher executable names before extracting a payload", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async () => undefined);
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");
      await writeApplyBaseline({ installMetadataPath, installRoot, runtimeConfigPath });
      const metadata = JSON.parse(await readFile(installMetadataPath, "utf8")) as Record<string, unknown>;
      await writeFile(installMetadataPath, JSON.stringify({
        ...metadata,
        displayName: "Open:Design Beta",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/safe Windows file name/);

      expect(extractor).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires exact install-root schema paths before extracting a payload", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async () => undefined);
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");
      await writeApplyBaseline({ installMetadataPath, installRoot, runtimeConfigPath });

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "other-lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/install-root path/);

      expect(extractor).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves lastSuccessful when the active payload version is applied again before ready", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.1"), "active payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.1",
          version: "1.0.1",
        },
        generation: 7,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.1",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "fresh active payload");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      });

      await expect(readFile(join(installRoot, "versions", "1.0.0", "payload", "Open Design.exe"), "utf8")).resolves.toBe("old payload");
      const runtime = JSON.parse(await readFile(runtimeConfigPath, "utf8")) as {
        generation: number;
        lastSuccessful: { root: string; version: string };
      };
      expect(runtime.generation).toBe(8);
      expect(runtime.lastSuccessful).toMatchObject({
        root: "versions/1.0.0",
        version: "1.0.0",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves lastSuccessful when a different unconfirmed active payload is superseded before ready", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "ready payload");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.1"), "unconfirmed payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.1",
          version: "1.0.1",
        },
        generation: 8,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.1",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "fresh payload");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.2",
      });

      const runtime = JSON.parse(await readFile(runtimeConfigPath, "utf8")) as {
        active: { root: string; version: string };
        generation: number;
        lastSuccessful: { root: string; version: string };
      };
      expect(runtime.generation).toBe(9);
      expect(runtime.active).toMatchObject({
        root: "versions/1.0.2",
        version: "1.0.2",
      });
      expect(runtime.lastSuccessful).toMatchObject({
        root: "versions/1.0.0",
        version: "1.0.0",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("normalizes install metadata to the stable launcher-layer schema after apply", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 1,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design.exe",
        helpers: {
          sevenZip: "versions/1.0.0/payload/7z.exe",
        },
        launcher: { executable: "Open Design.exe" },
        namespace: "release-beta-win",
        runtimePath: "legacy-runtime.json",
        schemaVersion: 1,
        versionsRoot: "legacy-versions",
      }), "utf8");

      await applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      });

      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.1",
        exeName: "Open Design Beta.exe",
        helpers: {
          sevenZip: "lib/7z/7z.exe",
          sevenZipDll: "lib/7z/7z.dll",
        },
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid install metadata schema before extracting or promoting a payload", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async ({ destinationRoot }: { destinationRoot: string }) => {
      await writePayloadExecutable(destinationRoot, "new payload");
    });
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 1,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/install metadata is missing or invalid/);

      expect(extractor).not.toHaveBeenCalled();
      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid launcher config before extracting or promoting a payload", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async ({ destinationRoot }: { destinationRoot: string }) => {
      await writePayloadExecutable(destinationRoot, "new payload");
    });
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(join(installRoot, "launcher.json"), JSON.stringify({
        runtimePath: "legacy-runtime.json",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 1,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe" },
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/launcher config is missing or invalid/);

      expect(extractor).not.toHaveBeenCalled();
      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid runtime config before extracting or promoting a payload", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async ({ destinationRoot }: { destinationRoot: string }) => {
      await writePayloadExecutable(destinationRoot, "new payload");
    });
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        namespace: "release-beta-win",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe" },
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/runtime config is missing or invalid/);

      expect(extractor).not.toHaveBeenCalled();
      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        namespace: "release-beta-win",
        schemaVersion: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects non install-root runtime namespace roots before extracting or promoting a payload", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async ({ destinationRoot }: { destinationRoot: string }) => {
      await writePayloadExecutable(destinationRoot, "new payload");
    });
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 1,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: "namespaces/release-beta-win",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe" },
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/runtime config is missing or invalid/);

      expect(extractor).not.toHaveBeenCalled();
      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects runtime descriptors that do not point at the launcher version payload schema", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async ({ destinationRoot }: { destinationRoot: string }) => {
      await writePayloadExecutable(destinationRoot, "new payload");
    });
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: ".", env: {}, executable: "Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 1,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        helpers: { sevenZip: "lib/7z/7z.exe" },
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/runtime config is missing or invalid/);

      expect(extractor).not.toHaveBeenCalled();
      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: {
          entry: { cwd: ".", executable: "Open Design.exe" },
          version: "1.0.0",
        },
        generation: 1,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails before extraction when the install root lock is already held", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async ({ destinationRoot }: { destinationRoot: string }) => {
      await writePayloadExecutable(destinationRoot, "new payload");
    });
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      const lockPath = join(installRoot, "state", "lock");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(lockPath, { recursive: true });
      await writeFile(archivePath, "archive", "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath: join(installRoot, "install.json"),
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath,
        namespace: "release-beta-win",
        runtimeConfigPath: join(installRoot, "runtime.json"),
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/lock is already held/);

      expect(extractor).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a version-scoped 7z helper before extraction", async () => {
    const root = makeRoot();
    const extractor = vi.fn(async ({ destinationRoot }: { destinationRoot: string }) => {
      await writePayloadExecutable(destinationRoot, "new payload");
    });
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor,
        installMetadataPath: join(installRoot, "install.json"),
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath: join(installRoot, "runtime.json"),
        sevenZipPath: join(installRoot, "versions", "1.0.0", "payload", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/stable launcher helper/);

      expect(extractor).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("requires the stable 7z DLL before extracting with the default extractor", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      const sevenZipPath = join(installRoot, "lib", "7z", "7z.exe");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "lib", "7z"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");
      await writeFile(sevenZipPath, "7z exe", "utf8");
      await writeApplyBaseline({ installMetadataPath, installRoot, runtimeConfigPath });

      await expect(applyLauncherPayloadArchive({
        archivePath,
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath,
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/7z helper DLL is missing/);

      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects payload archives that include a nested version-scoped 7z helper", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 1,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
          await mkdir(join(destinationRoot, "payload", "resources"), { recursive: true });
          await writeFile(join(destinationRoot, "payload", "resources", "7z.dll"), "nested 7z", "utf8");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/version-scoped 7z helper/);

      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 1,
        lastSuccessful: { version: "1.0.0" },
      });
      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects payload archives that contain install-root layer entries under the version root", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");
      await writeApplyBaseline({
        installMetadataPath,
        installRoot,
        runtimeConfigPath,
      });

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
          await mkdir(join(destinationRoot, "state", "lock"), { recursive: true });
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/install-root layer entry/);

      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 1,
        lastSuccessful: { version: "1.0.0" },
      });
      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an existing target version root that contains a nested version-scoped 7z helper", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.1"), "existing malformed payload");
      await mkdir(join(installRoot, "versions", "1.0.1", "payload", "resources"), { recursive: true });
      await writeFile(join(installRoot, "versions", "1.0.1", "payload", "resources", "7z.dll"), "nested 7z", "utf8");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 1,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/version-scoped 7z helper/);

      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 1,
        lastSuccessful: { version: "1.0.0" },
      });
      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an existing target version root that contains install-root layer entries", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await writeFile(archivePath, "archive", "utf8");
      await writeApplyBaseline({
        installMetadataPath,
        installRoot,
        runtimeConfigPath,
      });
      await writePayloadExecutable(join(installRoot, "versions", "1.0.1"), "existing malformed payload");
      await writeFile(join(installRoot, "versions", "1.0.1", "runtime.json"), "{}", "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/install-root layer entry/);

      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 1,
        lastSuccessful: { version: "1.0.0" },
      });
      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects malformed launcher self-update candidates before mutating active state", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 3,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
          await mkdir(join(destinationRoot, "launcher", "Open Design Beta.exe"), { recursive: true });
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/launcher self-update candidate is not a normal file/);

      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 3,
        lastSuccessful: { version: "1.0.0" },
      });
      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects install metadata namespace mismatch before promoting a payload", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 3,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Preview",
        exeName: "Open Design Preview.exe",
        launcher: { executable: "Open Design Preview.exe" },
        namespace: "release-preview-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/install metadata namespace mismatch/);

      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 3,
        lastSuccessful: { version: "1.0.0" },
        namespace: "release-beta-win",
      });
      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
        namespace: "release-preview-win",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects runtime namespace mismatch before promoting a payload", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const updateRoot = join(root, "updates");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const installMetadataPath = join(installRoot, "install.json");
      const archivePath = join(updateRoot, "downloads", "payload.7z");
      await mkdir(join(updateRoot, "downloads"), { recursive: true });
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(archivePath, "archive", "utf8");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        generation: 3,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-preview-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");
      await writeFile(installMetadataPath, JSON.stringify({
        currentVersion: "1.0.0",
        displayName: "Open Design Beta",
        exeName: "Open Design Beta.exe",
        launcher: { executable: "Open Design Beta.exe" },
        namespace: "release-beta-win",
        runtimePath: "runtime.json",
        schemaVersion: 1,
        versionsRoot: "versions",
      }), "utf8");

      await expect(applyLauncherPayloadArchive({
        archivePath,
        extractor: async ({ destinationRoot }) => {
          await writePayloadExecutable(destinationRoot, "new payload");
        },
        installMetadataPath,
        installRoot,
        launcherConfigPath: join(installRoot, "launcher.json"),
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        sevenZipPath: join(installRoot, "lib", "7z", "7z.exe"),
        updateRoot,
        version: "1.0.1",
      })).rejects.toThrow(/runtime namespace mismatch/);

      await expect(readFile(join(installRoot, "versions", "1.0.1", "payload", "Open Design.exe"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.0" },
        generation: 3,
        lastSuccessful: { version: "1.0.0" },
        namespace: "release-preview-win",
      });
      expect(JSON.parse(await readFile(installMetadataPath, "utf8"))).toMatchObject({
        currentVersion: "1.0.0",
        namespace: "release-beta-win",
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("marks every non-ready version directory for lazy cleanup after ready", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const cleanupMarkerPath = join(installRoot, "state", "cleanup.json");
      const attemptMarkerPath = join(installRoot, "state", "attempt.json");
      await writePayloadExecutable(join(installRoot, "versions", "0.9.0"), "older payload");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.1"), "ready payload");
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(attemptMarkerPath, JSON.stringify({
        generation: 4,
        schemaVersion: 1,
        version: "1.0.1",
      }), "utf8");
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.1",
          version: "1.0.1",
        },
        generation: 4,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");

      const ready = await confirmLauncherPayloadReady({
        cleanupMarkerPath,
        installRoot,
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        version: "1.0.1",
      });

      expect(ready).toMatchObject({
        advancedLastSuccessful: true,
        deleteVersions: ["0.9.0", "1.0.0"],
        ok: true,
        readyVersion: "1.0.1",
      });
      expect(JSON.parse(await readFile(cleanupMarkerPath, "utf8"))).toMatchObject({
        readyVersion: "1.0.1",
        versions: [
          { root: "versions/0.9.0", version: "0.9.0" },
          { root: "versions/1.0.0", version: "1.0.0" },
        ],
      });
      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: { version: "1.0.1" },
        lastSuccessful: { version: "1.0.1" },
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not advance ready when the active descriptor is malformed", async () => {
    const root = makeRoot();
    try {
      const installRoot = join(root, "install", "Open Design");
      const runtimeConfigPath = join(installRoot, "runtime.json");
      const cleanupMarkerPath = join(installRoot, "state", "cleanup.json");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.0"), "old payload");
      await writePayloadExecutable(join(installRoot, "versions", "1.0.1"), "ready payload");
      await mkdir(join(installRoot, "state"), { recursive: true });
      await writeLauncherConfig(installRoot);
      await writeFile(runtimeConfigPath, JSON.stringify({
        active: {
          apps: {},
          entry: { args: [], cwd: ".", env: {}, executable: "Open Design.exe" },
          root: "versions/1.0.1",
          version: "1.0.1",
        },
        generation: 4,
        lastSuccessful: {
          apps: {},
          entry: { args: [], cwd: "payload", env: {}, executable: "payload/Open Design.exe" },
          root: "versions/1.0.0",
          version: "1.0.0",
        },
        namespace: "release-beta-win",
        namespaceRoot: ".",
        schemaVersion: 1,
      }), "utf8");

      await expect(confirmLauncherPayloadReady({
        cleanupMarkerPath,
        installRoot,
        lockPath: join(installRoot, "state", "lock"),
        namespace: "release-beta-win",
        runtimeConfigPath,
        version: "1.0.1",
      })).rejects.toThrow(/runtime config is missing or invalid/);

      expect(JSON.parse(await readFile(runtimeConfigPath, "utf8"))).toMatchObject({
        active: {
          entry: { cwd: ".", executable: "Open Design.exe" },
          version: "1.0.1",
        },
        lastSuccessful: { version: "1.0.0" },
      });
      await expect(readFile(cleanupMarkerPath, "utf8")).rejects.toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
