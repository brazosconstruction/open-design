import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  activatePackagedBuiltinWebBundle,
  activatePackagedWebBundle,
  readPackagedWebBundleActivation,
  readPackagedWebBundleStatus,
} from "../src/bundles.js";
import type { ToolPackConfig } from "../src/config.js";

function makeConfig(root: string): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "bundle-smoke",
    platform: "mac",
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    roots: {
      output: {
        appBuilderRoot: join(root, "out", "builder"),
        namespaceRoot: join(root, "out"),
        platformRoot: join(root, "out"),
        root: join(root, "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, "runtime", "namespaces"),
        namespaceRoot: join(root, "runtime", "namespaces", "bundle-smoke"),
      },
      cacheRoot: join(root, "cache"),
      toolPackRoot: root,
    },
    silent: true,
    signed: false,
    to: "app",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

describe("packaged web bundle activation", () => {
  it("writes and reads a simple key/version activation pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);

      const activated = await activatePackagedWebBundle(config, "0.8.0-beta.4.web.2");
      const raw = JSON.parse(await readFile(activated.activationPath, "utf8")) as unknown;

      expect(raw).toEqual({
        key: "od:sidecar:web",
        version: "0.8.0-beta.4.web.2",
      });
      await expect(readPackagedWebBundleActivation(config)).resolves.toMatchObject({
        source: "bundle",
        version: "0.8.0-beta.4.web.2",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can switch the pointer back to builtin", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);

      await activatePackagedWebBundle(config, "0.8.0.web.1");
      const builtin = await activatePackagedBuiltinWebBundle(config);

      expect(JSON.parse(await readFile(builtin.activationPath, "utf8"))).toEqual({
        key: "od:sidecar:web",
        source: "builtin",
      });
      await expect(readPackagedWebBundleActivation(config)).resolves.toMatchObject({
        source: "builtin",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects non-web bundle versions before writing activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      await expect(activatePackagedWebBundle(makeConfig(root), "0.8.0.daemon.1")).rejects.toThrow(/\.web\.M/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back to offline activation status when packaged IPC is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-tools-pack-bundles-"));
    try {
      const config = makeConfig(root);
      await activatePackagedWebBundle(config, "0.8.0.web.1");

      await expect(readPackagedWebBundleStatus(config)).resolves.toMatchObject({
        mode: "offline",
        source: "bundle",
        version: "0.8.0.web.1",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
