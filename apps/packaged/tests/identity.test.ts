import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import {
  APP_KEYS,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
} from "@open-design/sidecar-proto";
import { describe, expect, it } from "vitest";

import {
  resolvePackagedDesktopAppPath,
  writePackagedDesktopIdentity,
} from "../src/identity.js";
import type { PackagedNamespacePaths } from "../src/paths.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function fakePaths(root: string): PackagedNamespacePaths {
  return {
    cacheRoot: join(root, "cache"),
    dataRoot: join(root, "data"),
    desktopIdentityPath: join(root, "runtime", "desktop-root.json"),
    desktopLogPath: join(root, "logs", "desktop", "latest.log"),
    desktopLogsRoot: join(root, "logs", "desktop"),
    electronSessionDataRoot: join(root, "user-data", "session"),
    electronUserDataRoot: join(root, "user-data"),
    headlessIdentityPath: join(root, "runtime", "headless-root.json"),
    installationRoot: join(root, ".."),
    installerObservationRoot: join(root, "data", "observations", "installer"),
    logsRoot: join(root, "logs"),
    namespaceRoot: root,
    resourceRoot: join(root, "resources"),
    runtimeRoot: join(root, "runtime"),
    updateRoot: join(root, "updates"),
    webIdentityPath: join(root, "runtime", "web-root.json"),
  };
}

describe("packaged identity markers", () => {
  it("reports the launcher install root as the desktop app path for versioned Windows payloads", () => {
    const installRoot = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Open Design Beta";
    const executablePath = win32.join(installRoot, "versions", "0.8.0-beta.2", "payload", "Open Design.exe");

    expect(resolvePackagedDesktopAppPath(executablePath)).toBe(installRoot);
  });

  it("keeps the existing .app bundle fallback outside launcher installs", () => {
    expect(resolvePackagedDesktopAppPath("/Applications/Open Design.app/Contents/MacOS/Open Design")).toBe(
      "/Applications/Open Design.app",
    );
  });

  it("can write and close the desktop identity shape at the headless marker path", async () => {
    const root = join(tmpdir(), `od-packaged-identity-${process.pid}-${Date.now()}`);
    const paths = fakePaths(root);
    const stamp = {
      app: APP_KEYS.DESKTOP,
      endpoint: "tcp://127.0.0.1:17401",
      mode: SIDECAR_MODES.RUNTIME,
      namespace: "default",
      source: SIDECAR_SOURCES.PACKAGED,
    };

    try {
      const handle = await writePackagedDesktopIdentity({
        identityPath: paths.headlessIdentityPath,
        paths,
        stamp,
      });

      expect(await pathExists(paths.headlessIdentityPath)).toBe(true);
      expect(await pathExists(paths.desktopIdentityPath)).toBe(false);

      await handle.close();
      expect(await pathExists(paths.headlessIdentityPath)).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
