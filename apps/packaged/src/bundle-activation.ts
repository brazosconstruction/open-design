import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  BundleStoreError,
  parseBundleEpochVersion,
  resolveBundle,
  resolveBundleArtifact,
  validateBundleRef,
  type BundleRef,
} from "@open-design/bundle";
import { SIDECAR_ENV, type SidecarImplementationSnapshot } from "@open-design/sidecar-proto";

import type { PackagedNamespacePaths } from "./paths.js";

export const PACKAGED_WEB_SIDECAR_BUNDLE_KEY = "od:sidecar:web";
export const PACKAGED_WEB_SIDECAR_BUNDLE_SLUG = "web";
export const SIDECAR_IMPLEMENTATION_ENV = SIDECAR_ENV.IMPLEMENTATION;

const PACKAGED_WEB_STANDALONE_BUNDLE_ROOT = "web/standalone";

export type PackagedBundleActivationFile =
  | { key: typeof PACKAGED_WEB_SIDECAR_BUNDLE_KEY; source: "builtin" }
  | { key: typeof PACKAGED_WEB_SIDECAR_BUNDLE_KEY; version: string };

export type PackagedWebSidecarImplementation =
  | {
      entryPath: string | null;
      implementation: Extract<SidecarImplementationSnapshot, { source: "builtin" }>;
      webStandaloneRoot: null;
    }
  | {
      entryPath: string;
      implementation: Extract<SidecarImplementationSnapshot, { source: "bundle" }>;
      webStandaloneRoot: string;
    };

type ParsedActivation =
  | { type: "builtin" }
  | { ref: BundleRef; type: "bundle" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function containsPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function parseSimpleActivationFile(value: Record<string, unknown>): ParsedActivation {
  if (value.key !== PACKAGED_WEB_SIDECAR_BUNDLE_KEY) {
    throw new Error(`packaged bundle activation key must be ${PACKAGED_WEB_SIDECAR_BUNDLE_KEY}`);
  }

  if (value.source === "builtin") return { type: "builtin" };

  const version = stringField(value, "version");
  if (version == null) {
    throw new Error("packaged bundle activation must contain key/version or key/source=builtin");
  }
  return {
    ref: validateBundleRef({ key: PACKAGED_WEB_SIDECAR_BUNDLE_KEY, version }),
    type: "bundle",
  };
}

function parseLegacyActivationFile(value: Record<string, unknown>): ParsedActivation {
  if (value.version !== 1 || !isRecord(value.bindings)) {
    throw new Error("packaged bundle activation must contain key/version");
  }

  const binding = value.bindings[PACKAGED_WEB_SIDECAR_BUNDLE_KEY];
  if (!isRecord(binding) || !isRecord(binding.source)) {
    throw new Error(`packaged bundle activation binding ${PACKAGED_WEB_SIDECAR_BUNDLE_KEY} must contain an object source`);
  }
  const type = stringField(binding.source, "type");
  if (type === "builtin") return { type };
  if (type !== "bundle") {
    throw new Error(`unsupported packaged bundle activation source for ${PACKAGED_WEB_SIDECAR_BUNDLE_KEY}: ${String(type)}`);
  }

  const ref = binding.source.ref;
  if (!isRecord(ref)) {
    throw new Error(`packaged bundle activation binding ${PACKAGED_WEB_SIDECAR_BUNDLE_KEY} must contain ref`);
  }
  const parsedRef = validateBundleRef(ref as BundleRef);
  if (parsedRef.key !== PACKAGED_WEB_SIDECAR_BUNDLE_KEY) {
    throw new Error(`packaged bundle activation ref key must be ${PACKAGED_WEB_SIDECAR_BUNDLE_KEY}`);
  }
  return { ref: parsedRef, type };
}

function parseActivationFile(value: unknown): ParsedActivation {
  if (!isRecord(value)) throw new Error("packaged bundle activation must be a JSON object");
  return "bindings" in value ? parseLegacyActivationFile(value) : parseSimpleActivationFile(value);
}

async function readActivation(path: string): Promise<ParsedActivation | null> {
  try {
    return parseActivationFile(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function builtin(entryPath: string | null, fallbackReason?: string): PackagedWebSidecarImplementation {
  return {
    entryPath,
    implementation: {
      source: "builtin",
      ...(entryPath == null ? {} : { entryPath }),
      ...(fallbackReason == null ? {} : { fallbackReason }),
    },
    webStandaloneRoot: null,
  };
}

function webStandaloneRootFromDescriptor(input: {
  bundlePath: string;
  descriptor: Record<string, unknown>;
}): string {
  const web = isRecord(input.descriptor.web) ? input.descriptor.web : {};
  const outputMode = stringField(web, "outputMode");
  if (outputMode != null && outputMode !== "standalone") {
    throw new Error(`bundle web outputMode must be standalone: ${outputMode}`);
  }

  const standaloneRoot = stringField(web, "standaloneRoot") ?? PACKAGED_WEB_STANDALONE_BUNDLE_ROOT;
  if (isAbsolute(standaloneRoot)) throw new Error("bundle web standaloneRoot must be relative");
  const root = resolve(input.bundlePath, standaloneRoot);
  if (!containsPath(input.bundlePath, root)) {
    throw new Error("bundle web standaloneRoot escaped the bundle path");
  }
  return root;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
}

async function resolveParsedPackagedWebSidecarImplementation(options: {
  activation: ParsedActivation;
  builtinEntryPath: string | null;
  bundleEpoch: string | null;
  paths: PackagedNamespacePaths;
}): Promise<PackagedWebSidecarImplementation> {
  if (options.activation.type === "builtin") return builtin(options.builtinEntryPath, "binding-builtin");

  try {
    if (options.bundleEpoch == null) return builtin(options.builtinEntryPath, "host-epoch-missing");
    const parsedVersion = parseBundleEpochVersion(options.activation.ref.version);
    if (parsedVersion.slug !== PACKAGED_WEB_SIDECAR_BUNDLE_SLUG) {
      return builtin(options.builtinEntryPath, `bundle-slug-mismatch:${parsedVersion.slug}`);
    }
    if (parsedVersion.epoch !== options.bundleEpoch) {
      return builtin(options.builtinEntryPath, `bundle-epoch-mismatch:${parsedVersion.epoch}`);
    }

    const resolved = await resolveBundle({
      basePath: options.paths.bundleBasePath,
      ref: options.activation.ref,
    });
    const artifact = await resolveBundleArtifact(resolved.path);
    if (artifact.descriptor.schemaVersion !== 2) {
      return builtin(options.builtinEntryPath, "bundle-descriptor-unsupported");
    }
    if (artifact.descriptor.key !== options.activation.ref.key || artifact.descriptor.version !== options.activation.ref.version) {
      return builtin(options.builtinEntryPath, "bundle-descriptor-ref-mismatch");
    }

    const webStandaloneRoot = webStandaloneRootFromDescriptor({
      bundlePath: artifact.bundlePath,
      descriptor: artifact.descriptor,
    });
    await assertDirectory(webStandaloneRoot, "bundle web standaloneRoot");

    return {
      entryPath: artifact.entryPath,
      implementation: {
        basePath: resolved.basePath,
        bundlePath: artifact.bundlePath,
        descriptorPath: artifact.descriptorPath,
        entryPath: artifact.entryPath,
        metadataPath: resolved.metadataPath,
        ref: resolved.ref,
        source: "bundle",
      },
      webStandaloneRoot,
    };
  } catch (error) {
    const reason = error instanceof BundleStoreError ? `${error.code}:${error.message}` : error instanceof Error ? error.message : String(error);
    return builtin(options.builtinEntryPath, `bundle-unresolved:${reason}`);
  }
}

export async function resolvePackagedWebSidecarImplementation(options: {
  builtinEntryPath: string | null;
  bundleEpoch: string | null;
  paths: PackagedNamespacePaths;
}): Promise<PackagedWebSidecarImplementation> {
  let activation: ParsedActivation | null;
  try {
    activation = await readActivation(options.paths.bundleActivationPath);
  } catch (error) {
    return builtin(options.builtinEntryPath, `activation-invalid:${error instanceof Error ? error.message : String(error)}`);
  }

  if (activation == null) return builtin(options.builtinEntryPath, "activation-missing");
  return await resolveParsedPackagedWebSidecarImplementation({
    ...options,
    activation,
  });
}

export async function resolvePackagedWebSidecarImplementationForActivation(options: {
  activation: PackagedBundleActivationFile;
  builtinEntryPath: string | null;
  bundleEpoch: string | null;
  paths: PackagedNamespacePaths;
}): Promise<PackagedWebSidecarImplementation> {
  return await resolveParsedPackagedWebSidecarImplementation({
    ...options,
    activation: parseActivationFile(options.activation),
  });
}

export function sidecarImplementationEnv(
  implementation: SidecarImplementationSnapshot,
): NodeJS.ProcessEnv {
  return {
    [SIDECAR_IMPLEMENTATION_ENV]: JSON.stringify(implementation),
  };
}

export function createPackagedBundleActivationFile(input: {
  web: "builtin" | { version: string };
}): PackagedBundleActivationFile {
  return input.web === "builtin"
    ? { key: PACKAGED_WEB_SIDECAR_BUNDLE_KEY, source: "builtin" }
    : { key: PACKAGED_WEB_SIDECAR_BUNDLE_KEY, version: input.web.version };
}

export async function readPackagedBundleActivationFile(
  paths: Pick<PackagedNamespacePaths, "bundleActivationPath">,
): Promise<PackagedBundleActivationFile | null> {
  const activation = await readActivation(paths.bundleActivationPath);
  if (activation == null) return null;
  return activation.type === "builtin"
    ? { key: PACKAGED_WEB_SIDECAR_BUNDLE_KEY, source: "builtin" }
    : { key: PACKAGED_WEB_SIDECAR_BUNDLE_KEY, version: activation.ref.version };
}

export async function writePackagedBundleActivationFile(options: {
  activation: PackagedBundleActivationFile;
  paths: Pick<PackagedNamespacePaths, "bundleActivationPath">;
}): Promise<void> {
  await mkdir(dirname(options.paths.bundleActivationPath), { recursive: true });
  await writeFile(
    options.paths.bundleActivationPath,
    `${JSON.stringify(options.activation, null, 2)}\n`,
    "utf8",
  );
}

export function packagedBundleActivationPath(paths: Pick<PackagedNamespacePaths, "dataRoot">): string {
  return join(paths.dataRoot, "bundle-activation.json");
}
