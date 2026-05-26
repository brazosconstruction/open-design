import { describe, expect, it } from "vitest";

import {
  RUNTIME_APPS,
  buildAttempt,
  buildLauncherConfig,
  buildRuntimeConfig,
  createEndpoint,
  normalizeEndpoint,
  normalizeNamespace,
} from "../src/index.js";

function packagedRuntime() {
  return buildRuntimeConfig({
    active: {
      apps: {
        daemon: {
          endpoint: createEndpoint(17401),
          entry: {
            args: ["--serve"],
            env: { OD_PORT: "17456" },
            executable: "payload/daemon.exe",
          },
        },
        web: {
          endpoint: "tcp://127.0.0.1:17402",
          entry: {
            env: { OD_WEB_PORT: "17573" },
            executable: "payload/web.exe",
          },
        },
      },
      entry: {
        executable: "payload/Open Design Payload.exe",
      },
      root: "namespaces/release-beta-win/versions/0.8.1",
      version: "0.8.1",
    },
    generation: 1,
    lastSuccessful: {
      entry: {
        executable: "payload/Open Design Payload.exe",
      },
      root: "namespaces/release-beta-win/versions/0.8.0",
      version: "0.8.0",
    },
    namespace: "release-beta-win",
    namespaceRoot: "namespaces/release-beta-win",
  });
}

describe("launcher proto", () => {
  it("builds launcher config", () => {
    expect(buildLauncherConfig()).toEqual({
      runtimePath: "runtime.json",
      schemaVersion: 1,
    });
    expect(buildLauncherConfig({ attemptPath: "state/attempt.json", runtimePath: "runtime.json" })).toEqual({
      attemptPath: "state/attempt.json",
      runtimePath: "runtime.json",
      schemaVersion: 1,
    });
  });

  it("builds runtime config", () => {
    const runtime = packagedRuntime();

    expect(runtime.schemaVersion).toBe(1);
    expect(runtime.active.version).toBe("0.8.1");
    expect(runtime.active.apps.daemon?.endpoint).toBe("tcp://127.0.0.1:17401");
    expect(runtime.active.apps.web?.entry.env).toEqual({ OD_WEB_PORT: "17573" });
    expect(runtime.lastSuccessful.apps).toEqual({});
    expect(JSON.stringify(runtime)).toContain("\"endpoint\"");
    expect(JSON.stringify(runtime)).not.toContain("\"ipc\"");
  });

  it("rejects descriptor paths that are absolute or escape their root", () => {
    expect(() => buildLauncherConfig({ runtimePath: "C:/outside/runtime.json" })).toThrow(/runtimePath/);
    expect(() => buildLauncherConfig({ attemptPath: "../attempt.json" })).toThrow(/attemptPath/);
    expect(() =>
      buildRuntimeConfig({
        ...packagedRuntime(),
        namespaceRoot: "../outside",
      }),
    ).toThrow(/namespaceRoot/);
    expect(() =>
      buildRuntimeConfig({
        ...packagedRuntime(),
        active: {
          ...packagedRuntime().active,
          root: "../versions/0.8.1",
        },
      }),
    ).toThrow(/active\.root/);
    expect(() =>
      buildRuntimeConfig({
        ...packagedRuntime(),
        active: {
          ...packagedRuntime().active,
          entry: {
            executable: "../Open Design Payload.exe",
          },
        },
      }),
    ).toThrow(/active\.entry\.executable/);
    expect(() =>
      buildRuntimeConfig({
        ...packagedRuntime(),
        active: {
          ...packagedRuntime().active,
          entry: {
            cwd: "payload/../outside",
            executable: "payload/Open Design Payload.exe",
          },
        },
      }),
    ).toThrow(/active\.entry\.cwd/);
  });

  it("normalizes endpoint", () => {
    expect(normalizeEndpoint("tcp://127.0.0.1:65535")).toBe("tcp://127.0.0.1:65535");
    expect(() => normalizeEndpoint("unix:///tmp/open-design.sock")).toThrow();
    expect(() => normalizeEndpoint("tcp://0.0.0.0:17401")).toThrow();
    expect(() => normalizeEndpoint("tcp://127.0.0.1:0")).toThrow();
    expect(() => normalizeEndpoint("tcp://127.0.0.1:017401")).toThrow();
  });

  it("matches namespace rules", () => {
    expect(normalizeNamespace("release-beta-win")).toBe("release-beta-win");
    expect(() => normalizeNamespace("")).toThrow();
    expect(() => normalizeNamespace(" beta")).toThrow();
    expect(() => normalizeNamespace("beta/local")).toThrow();
    expect(() => normalizeNamespace("-beta")).toThrow();
  });

  it("rejects unknown app descriptors", () => {
    expect(() =>
      buildRuntimeConfig({
        ...packagedRuntime(),
        active: {
          ...packagedRuntime().active,
          apps: {
            api: {
              endpoint: createEndpoint(17404),
              entry: { executable: "api.js" },
            },
          },
        },
      }),
    ).toThrow(/app/);
  });

  it("builds attempt", () => {
    expect(buildAttempt(7, "0.8.1")).toEqual({
      generation: 7,
      schemaVersion: 1,
      version: "0.8.1",
    });
    expect(() => buildAttempt(-1, "0.8.1")).toThrow();
  });

  it("exports app constants", () => {
    expect(Object.values(RUNTIME_APPS)).toEqual(["daemon", "desktop", "web"]);
  });
});
