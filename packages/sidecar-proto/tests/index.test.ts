import { describe, expect, it } from "vitest";

import {
  APP_KEYS,
  DESKTOP_UPDATE_ACTIONS,
  DESKTOP_UPDATE_CHANNELS,
  DESKTOP_UPDATE_MODES,
  DESKTOP_UPDATE_STATES,
  normalizeDaemonSidecarMessage,
  normalizeDesktopSidecarMessage,
  normalizeNamespace,
  normalizeSidecarStamp,
  normalizeWebSidecarMessage,
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_EVENTS,
  SIDECAR_MESSAGES,
  SIDECAR_SOURCES,
  SIDECAR_STAMP_FIELDS,
  STAMP_APP_FLAG,
  STAMP_IPC_FLAG,
  STAMP_MODE_FLAG,
  STAMP_NAMESPACE_FLAG,
  STAMP_SOURCE_FLAG,
  type DaemonStatusSnapshot,
} from "../src/index.js";

const validStamp = {
  app: APP_KEYS.WEB,
  ipc: "/tmp/open-design/ipc/contract-check/web.sock",
  mode: "dev" as const,
  namespace: "contract-check",
  source: SIDECAR_SOURCES.TOOLS_DEV,
};

describe("open-design sidecar contract", () => {
  it("exports the canonical five-field stamp descriptor", () => {
    expect(SIDECAR_STAMP_FIELDS).toEqual(["app", "mode", "namespace", "ipc", "source"]);
    expect(OPEN_DESIGN_SIDECAR_CONTRACT.stampFlags).toEqual({
      app: STAMP_APP_FLAG,
      ipc: STAMP_IPC_FLAG,
      mode: STAMP_MODE_FLAG,
      namespace: STAMP_NAMESPACE_FLAG,
      source: STAMP_SOURCE_FLAG,
    });
    expect(OPEN_DESIGN_SIDECAR_CONTRACT.updateActions).toBe(DESKTOP_UPDATE_ACTIONS);
    expect(OPEN_DESIGN_SIDECAR_CONTRACT.events).toBe(SIDECAR_EVENTS);
    expect(OPEN_DESIGN_SIDECAR_CONTRACT.updateChannels).toBe(DESKTOP_UPDATE_CHANNELS);
    expect(OPEN_DESIGN_SIDECAR_CONTRACT.updateModes).toBe(DESKTOP_UPDATE_MODES);
    expect(OPEN_DESIGN_SIDECAR_CONTRACT.updateStates).toBe(DESKTOP_UPDATE_STATES);
  });

  it("accepts the explicit namespace contract", () => {
    expect(normalizeNamespace("contract-check_1.alpha")).toBe("contract-check_1.alpha");
  });

  it("rejects path-like or whitespace namespaces", () => {
    expect(() => normalizeNamespace("../other")).toThrow();
    expect(() => normalizeNamespace(" contract-check")).toThrow();
    expect(() => normalizeNamespace("contract check")).toThrow();
  });

  it("accepts exactly app, mode, namespace, ipc, and source", () => {
    expect(normalizeSidecarStamp(validStamp)).toEqual(validStamp);
  });

  it("rejects legacy or extra stamp fields", () => {
    expect(() => normalizeSidecarStamp({ ...validStamp, runtimeToken: "legacy" })).toThrow();
    expect(() => normalizeSidecarStamp({ ...validStamp, role: "web-sidecar" })).toThrow();
  });

  it("rejects non-contract sidecar sources", () => {
    expect(() => normalizeSidecarStamp({ ...validStamp, source: "custom-script" })).toThrow();
  });

  it("validates daemon IPC messages", () => {
    expect(normalizeDaemonSidecarMessage({ type: SIDECAR_MESSAGES.STATUS })).toEqual({ type: "status" });
    expect(normalizeDaemonSidecarMessage({ type: SIDECAR_MESSAGES.SHUTDOWN })).toEqual({ type: "shutdown" });
    expect(() => normalizeDaemonSidecarMessage({ input: {}, type: SIDECAR_MESSAGES.EVAL })).toThrow();
  });

  it("validates generic sidecar event messages", () => {
    expect(normalizeDaemonSidecarMessage({
      key: SIDECAR_EVENTS.INSPECT_STATUS,
      type: SIDECAR_MESSAGES.EVENT,
    })).toEqual({
      key: "inspect.status",
      type: "event",
    });
    expect(normalizeDesktopSidecarMessage({
      key: SIDECAR_EVENTS.INSPECT_SCREENSHOT,
      payload: { path: "/tmp/screen.png" },
      type: SIDECAR_MESSAGES.EVENT,
    })).toEqual({
      key: "inspect.screenshot",
      payload: { path: "/tmp/screen.png" },
      type: "event",
    });
    expect(normalizeDesktopSidecarMessage({
      key: SIDECAR_EVENTS.INSPECT_UPDATE,
      payload: { action: DESKTOP_UPDATE_ACTIONS.STATUS },
      type: SIDECAR_MESSAGES.EVENT,
    })).toEqual({
      key: "inspect.update",
      payload: { action: "status" },
      type: "event",
    });
    expect(() =>
      normalizeDesktopSidecarMessage({
        key: SIDECAR_EVENTS.INSPECT_STATUS,
        payload: { noisy: true },
        type: SIDECAR_MESSAGES.EVENT,
      }),
    ).toThrow(/unsupported fields/);
    expect(() =>
      normalizeWebSidecarMessage({
        key: "inspect.unknown",
        type: SIDECAR_MESSAGES.EVENT,
      }),
    ).toThrow(/unknown sidecar event/);
  });

  it("validates packaged bundle IPC event payloads", () => {
    expect(normalizeDesktopSidecarMessage({
      key: SIDECAR_EVENTS.PACKAGED_BUNDLE_STATUS,
      payload: { key: "od:sidecar:web" },
      type: SIDECAR_MESSAGES.EVENT,
    })).toEqual({
      key: "packaged.bundle.status",
      payload: { key: "od:sidecar:web" },
      type: "event",
    });
    expect(normalizeDesktopSidecarMessage({
      key: SIDECAR_EVENTS.PACKAGED_BUNDLE_SWITCH,
      payload: { key: "od:sidecar:web", version: "0.8.0-beta.4.web.2" },
      type: SIDECAR_MESSAGES.EVENT,
    })).toEqual({
      key: "packaged.bundle.switch",
      payload: { key: "od:sidecar:web", version: "0.8.0-beta.4.web.2" },
      type: "event",
    });
    expect(normalizeDesktopSidecarMessage({
      key: SIDECAR_EVENTS.PACKAGED_BUNDLE_ACTIVATE,
      payload: { key: "od:sidecar:web", source: "builtin" },
      type: SIDECAR_MESSAGES.EVENT,
    })).toEqual({
      key: "packaged.bundle.activate",
      payload: { key: "od:sidecar:web", source: "builtin" },
      type: "event",
    });
    expect(() =>
      normalizeDesktopSidecarMessage({
        key: SIDECAR_EVENTS.PACKAGED_BUNDLE_SWITCH,
        payload: { key: "od:sidecar:web", source: "builtin", version: "0.8.0.web.1" },
        type: SIDECAR_MESSAGES.EVENT,
      }),
    ).toThrow(/must not include version/);
    expect(() =>
      normalizeDesktopSidecarMessage({
        key: SIDECAR_EVENTS.PACKAGED_BUNDLE_RESTART,
        payload: { key: "od:sidecar:web", noisy: true },
        type: SIDECAR_MESSAGES.EVENT,
      }),
    ).toThrow(/unsupported fields/);
  });

  it("accepts a base64 register-desktop-auth payload", () => {
    const message = {
      input: { secret: "AAECAwQFBgcICQoLDA0ODw==" },
      type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
    };
    expect(normalizeDaemonSidecarMessage(message)).toEqual(message);
  });

  it("rejects register-desktop-auth payloads that are not base64-shaped", () => {
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: { secret: "not base64!" },
        type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
      }),
    ).toThrow(/base64/i);
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: { secret: "" },
        type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
      }),
    ).toThrow();
    expect(() =>
      normalizeDaemonSidecarMessage({
        input: {},
        type: SIDECAR_MESSAGES.REGISTER_DESKTOP_AUTH,
      }),
    ).toThrow();
  });

  it("validates desktop IPC message inputs", () => {
    expect(normalizeDesktopSidecarMessage({ input: { expression: "location.href" }, type: SIDECAR_MESSAGES.EVAL })).toEqual({
      input: { expression: "location.href" },
      type: "eval",
    });
    expect(() => normalizeDesktopSidecarMessage({ input: { expression: 42 }, type: SIDECAR_MESSAGES.EVAL })).toThrow();
    expect(() => normalizeDesktopSidecarMessage({ input: { selector: "" }, type: SIDECAR_MESSAGES.CLICK })).toThrow();
  });

  it("requires DaemonStatusSnapshot to carry desktopAuthGateActive (PR #974 round 6)", () => {
    // The TS compiler enforces that `desktopAuthGateActive: boolean` is
    // present on every constructed snapshot — tools-dev's split-start
    // hardening relies on the daemon STATUS IPC carrying this field so
    // `start desktop` can detect an ungated already-running daemon and
    // restart it before launching desktop main. Removing the field, or
    // softening it to optional, must fail this build.
    const armed: DaemonStatusSnapshot = {
      state: "running",
      url: "http://127.0.0.1:7456",
      desktopAuthGateActive: true,
    };
    const dormant: DaemonStatusSnapshot = {
      state: "running",
      url: "http://127.0.0.1:7456",
      desktopAuthGateActive: false,
    };
    expect(armed.desktopAuthGateActive).toBe(true);
    expect(dormant.desktopAuthGateActive).toBe(false);
  });

  it("validates desktop PDF export IPC message inputs", () => {
    expect(
      normalizeDesktopSidecarMessage({
        input: {
          baseHref: "http://127.0.0.1:7456/api/projects/proj/raw/deck/",
          deck: true,
          defaultFilename: "Seed Deck.pdf",
          html: "<!doctype html><section class=\"slide\">One</section>",
          title: "Seed Deck",
        },
        type: SIDECAR_MESSAGES.EXPORT_PDF,
      }),
    ).toEqual({
      input: {
        baseHref: "http://127.0.0.1:7456/api/projects/proj/raw/deck/",
        deck: true,
        defaultFilename: "Seed Deck.pdf",
        html: "<!doctype html><section class=\"slide\">One</section>",
        title: "Seed Deck",
      },
      type: "export-pdf",
    });
    expect(() =>
      normalizeDesktopSidecarMessage({
        input: { deck: true, defaultFilename: "x.pdf", html: "", title: "x" },
        type: SIDECAR_MESSAGES.EXPORT_PDF,
      }),
    ).toThrow();
    expect(() =>
      normalizeDesktopSidecarMessage({
        input: { deck: "yes", defaultFilename: "x.pdf", html: "<p>x</p>", title: "x" },
        type: SIDECAR_MESSAGES.EXPORT_PDF,
      }),
    ).toThrow();
  });

  it("validates desktop update IPC message inputs", () => {
    expect(
      normalizeDesktopSidecarMessage({
        input: { action: DESKTOP_UPDATE_ACTIONS.CHECK },
        type: SIDECAR_MESSAGES.UPDATE,
      }),
    ).toEqual({
      input: { action: "check" },
      type: "update",
    });
    expect(
      normalizeDesktopSidecarMessage({
        input: { action: DESKTOP_UPDATE_ACTIONS.INSTALL },
        type: SIDECAR_MESSAGES.UPDATE,
      }),
    ).toEqual({
      input: { action: "install" },
      type: "update",
    });
    expect(() =>
      normalizeDesktopSidecarMessage({
        input: { action: "apply" },
        type: SIDECAR_MESSAGES.UPDATE,
      }),
    ).toThrow(/unsupported desktop update action/);
    expect(() =>
      normalizeDesktopSidecarMessage({
        input: { action: "status", path: "/tmp/update.dmg" },
        type: SIDECAR_MESSAGES.UPDATE,
      }),
    ).toThrow(/unsupported fields/);
  });
});
