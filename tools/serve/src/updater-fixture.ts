import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";

type UpdaterFixtureChannel = "stable" | "beta" | "nightly" | "preview";
type UpdaterFixtureArtifactKind = "dmg" | "installer" | "payload";

export type UpdaterFixtureOptions = {
  artifactBody?: Buffer | string;
  artifactKind?: UpdaterFixtureArtifactKind;
  artifactName?: string;
  artifactPath?: string;
  channel?: UpdaterFixtureChannel;
  host?: string;
  platform?: "mac" | "win";
  port?: number;
  version?: string;
};

export type UpdaterFixtureInfo = {
  artifactKind: UpdaterFixtureArtifactKind;
  artifactUrl: string;
  channel: UpdaterFixtureChannel;
  checksumUrl: string;
  metadataUrl: string;
  origin: string;
  platform: "mac" | "win";
  sha256: string;
  version: string;
};

export type UpdaterFixtureServer = {
  close(): Promise<void>;
  info: UpdaterFixtureInfo;
};

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error == null ? resolveClose() : rejectClose(error)));
  });
}

function serverOrigin(server: Server): string {
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("updater fixture did not listen on TCP");
  return `http://127.0.0.1:${address.port}`;
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

function prereleaseCounterParts(version: string): { baseVersion: string; number: number } | null {
  const prerelease = /^(\d+\.\d+\.\d+)-.+\.(\d+)$/.exec(version);
  if (prerelease?.[1] != null && prerelease[2] != null) {
    return { baseVersion: prerelease[1], number: Number(prerelease[2]) };
  }
  const nightly = /^(\d+\.\d+\.\d+)\.nightly\.(\d+)$/i.exec(version);
  if (nightly?.[1] != null && nightly[2] != null) {
    return { baseVersion: nightly[1], number: Number(nightly[2]) };
  }
  return null;
}

type ParsedRange = { end: number; start: number } | "invalid" | "unsatisfiable" | null;

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseByteRange(value: string | undefined, size: number): ParsedRange {
  if (value == null) return null;
  if (!value.startsWith("bytes=")) return "invalid";
  const spec = value.slice("bytes=".length).trim();
  if (spec.length === 0 || spec.includes(",")) return "invalid";

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (match == null) return "invalid";
  const [, startText, endText] = match;
  if (startText == null || endText == null || (startText.length === 0 && endText.length === 0)) {
    return "invalid";
  }
  if (size <= 0) return "unsatisfiable";

  if (startText.length === 0) {
    const suffixLength = parseNonNegativeInteger(endText);
    if (suffixLength == null || suffixLength === 0) return "invalid";
    return {
      end: size - 1,
      start: Math.max(size - suffixLength, 0),
    };
  }

  const start = parseNonNegativeInteger(startText);
  if (start == null) return "invalid";
  const end = endText.length === 0 ? size - 1 : parseNonNegativeInteger(endText);
  if (end == null || start > end) return "invalid";
  if (start >= size) return "unsatisfiable";
  return {
    end: Math.min(end, size - 1),
    start,
  };
}

function endWithOptionalBody(request: IncomingMessage, response: ServerResponse, body: Buffer | string): void {
  response.end(request.method === "HEAD" ? undefined : body);
}

function sendArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  artifactBody: Buffer,
  contentType: string,
): void {
  response.setHeader("accept-ranges", "bytes");
  response.setHeader("content-type", contentType);
  const range = parseByteRange(request.headers.range, artifactBody.byteLength);
  if (range === "invalid" || range === "unsatisfiable") {
    response.statusCode = 416;
    response.setHeader("content-range", `bytes */${artifactBody.byteLength}`);
    response.end();
    return;
  }

  if (range != null) {
    const body = artifactBody.subarray(range.start, range.end + 1);
    response.statusCode = 206;
    response.setHeader("content-length", String(body.byteLength));
    response.setHeader("content-range", `bytes ${range.start}-${range.end}/${artifactBody.byteLength}`);
    endWithOptionalBody(request, response, body);
    return;
  }

  response.setHeader("content-length", String(artifactBody.byteLength));
  endWithOptionalBody(request, response, artifactBody);
}

function normalizeChannel(value: string | undefined): UpdaterFixtureChannel {
  if (value == null || value.length === 0) return "stable";
  if (value === "stable" || value === "beta" || value === "nightly" || value === "preview") return value;
  throw new Error(`unsupported updater fixture channel: ${value}`);
}

function normalizeArtifactKind(
  platform: "mac" | "win",
  value: UpdaterFixtureArtifactKind | undefined,
): UpdaterFixtureArtifactKind {
  const kind = value ?? (platform === "win" ? "installer" : "dmg");
  if (platform === "mac" && kind !== "dmg") throw new Error("mac updater fixture only supports dmg artifacts");
  if (platform === "win" && kind !== "installer" && kind !== "payload") {
    throw new Error("win updater fixture supports installer or payload artifacts");
  }
  return kind;
}

function artifactDefaults(input: {
  artifactName: string | undefined;
  artifactPath: string | undefined;
  kind: UpdaterFixtureArtifactKind;
  platform: "mac" | "win";
  version: string;
}): { artifactKey: string; artifactName: string; contentType: string } {
  const artifactName = input.artifactName ?? (input.artifactPath == null ? undefined : basename(input.artifactPath));
  if (input.kind === "payload") {
    return {
      artifactKey: "payload",
      artifactName: artifactName ?? `open-design-${input.version}-win-x64-payload.7z`,
      contentType: "application/x-7z-compressed",
    };
  }
  if (input.kind === "installer") {
    return {
      artifactKey: "installer",
      artifactName: artifactName ?? `open-design-${input.version}-win-x64-setup.exe`,
      contentType: "application/vnd.microsoft.portable-executable",
    };
  }
  return {
    artifactKey: "dmg",
    artifactName: artifactName ?? `open-design-${input.version}-mac-arm64.dmg`,
    contentType: "application/x-apple-diskimage",
  };
}

function channelMetadata(channel: UpdaterFixtureChannel, version: string): Record<string, unknown> {
  if (channel === "stable") {
    return {
      baseVersion: version,
      releaseVersion: version,
      stableVersion: version,
    };
  }

  if (channel === "beta") {
    const countedVersion = prereleaseCounterParts(version);
    if (countedVersion == null) {
      throw new Error(`beta updater fixture version must match x.y.z-<label>.N; got ${version}`);
    }
    return {
      baseVersion: countedVersion.baseVersion,
      betaNumber: countedVersion.number,
      betaVersion: version,
    };
  }

  const countedVersion = prereleaseCounterParts(version);
  if (countedVersion == null) {
    throw new Error(`${channel} updater fixture version must match x.y.z-<label>.N; got ${version}`);
  }
  if (channel === "nightly") {
    return {
      baseVersion: countedVersion.baseVersion,
      nightlyNumber: countedVersion.number,
      nightlyVersion: version,
      releaseVersion: version,
      stableVersion: countedVersion.baseVersion,
    };
  }

  return {
    baseVersion: countedVersion.baseVersion,
    previewNumber: countedVersion.number,
    previewVersion: version,
    releaseVersion: version,
  };
}

export async function startUpdaterFixtureServer(options: UpdaterFixtureOptions = {}): Promise<UpdaterFixtureServer> {
  const channel = normalizeChannel(options.channel);
  const host = options.host ?? "127.0.0.1";
  const platform = options.platform ?? "mac";
  const artifactKind = normalizeArtifactKind(platform, options.artifactKind);
  const port = options.port ?? 0;
  const version = options.version ?? "99.0.0";
  const platformKey = platform === "win" ? "win" : "mac";
  const { artifactKey, artifactName, contentType } = artifactDefaults({
    artifactName: options.artifactName,
    artifactPath: options.artifactPath,
    kind: artifactKind,
    platform,
    version,
  });
  const artifactBody =
    options.artifactPath == null
      ? Buffer.isBuffer(options.artifactBody)
        ? options.artifactBody
        : Buffer.from(options.artifactBody ?? `Open Design updater fixture ${version}\n`, "utf8")
      : await readFile(options.artifactPath);
  const sha256 = createHash("sha256").update(artifactBody).digest("hex");

  let info: UpdaterFixtureInfo | null = null;
  const server = createServer((request, response) => {
    if (info == null) {
      response.statusCode = 503;
      response.end("fixture not ready");
      return;
    }
    const path = new URL(request.url ?? "/", info.origin).pathname;
    if (path === `/${channel}/latest/metadata.json`) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        channel,
        generatedAt: new Date().toISOString(),
        ...channelMetadata(channel, version),
        platforms: {
          [platformKey]: {
            arch: platform === "win" ? "x64" : "arm64",
            artifacts: {
              [artifactKey]: {
                contentType,
                name: artifactName,
                sha256Url: info.checksumUrl,
                size: artifactBody.byteLength,
                url: info.artifactUrl,
              },
            },
            channel,
            enabled: true,
            feed: null,
            label: platform === "win" ? "Windows x64" : "macOS arm64",
            platform,
            platformKey,
            signed: false,
          },
        },
        version: 1,
      }));
      return;
    }
    const encodedArtifactName = pathSegment(artifactName);
    if (path === `/${channel}/versions/${version}/${encodedArtifactName}`) {
      sendArtifact(request, response, artifactBody, contentType);
      return;
    }
    if (path === `/${channel}/versions/${version}/${encodedArtifactName}.sha256`) {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(`${sha256}  ${artifactName}\n`);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  await listen(server, port, host);
  const origin = serverOrigin(server);
  const artifactUrl = `${origin}/${channel}/versions/${version}/${pathSegment(artifactName)}`;
  info = {
    artifactKind,
    artifactUrl,
    channel,
    checksumUrl: `${artifactUrl}.sha256`,
    metadataUrl: `${origin}/${channel}/latest/metadata.json`,
    origin,
    platform,
    sha256,
    version,
  };

  return {
    close: () => close(server),
    info,
  };
}
