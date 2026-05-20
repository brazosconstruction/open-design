import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SIDECAR_MODES, SIDECAR_SOURCES } from '@open-design/sidecar-proto';
import { describe, expect, it, vi } from 'vitest';

import {
  checkDaemonCliBuild,
  prepareDaemonSidecarDevRuntime,
} from '../src/sidecar/dev-runtime.js';

async function makeDaemonPackageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'open-design-daemon-dev-runtime-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"@open-design/daemon"}\n', 'utf8');
  await writeFile(join(root, 'tsconfig.json'), '{}\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export {};\n', 'utf8');
  return root;
}

async function setMtime(path: string, seconds: number): Promise<void> {
  const date = new Date(seconds * 1000);
  await utimes(path, date, date);
}

async function setSourceMtime(root: string, seconds: number): Promise<void> {
  await setMtime(join(root, 'src', 'index.ts'), seconds);
  await setMtime(join(root, 'src'), seconds);
  await setMtime(join(root, 'package.json'), seconds);
  await setMtime(join(root, 'tsconfig.json'), seconds);
}

describe('daemon sidecar dev runtime preparation', () => {
  it('requires a daemon CLI build when dist/cli.js is missing', async () => {
    const root = await makeDaemonPackageRoot();

    try {
      const check = await checkDaemonCliBuild(root);

      expect(check.required).toBe(true);
      expect(check.reason).toBe('apps/daemon/dist/cli.js is missing');
      expect(check.distCliPath).toBe(join(root, 'dist', 'cli.js'));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('requires a daemon CLI build when source files are newer than dist/cli.js', async () => {
    const root = await makeDaemonPackageRoot();

    try {
      await writeFile(join(root, 'dist', 'cli.js'), 'export {};\n', 'utf8');
      await setMtime(join(root, 'dist', 'cli.js'), 100);
      await setSourceMtime(root, 200);

      const check = await checkDaemonCliBuild(root);

      expect(check.required).toBe(true);
      expect(check.reason).toBe('source is newer than apps/daemon/dist/cli.js');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('skips the daemon CLI build when dist/cli.js is current', async () => {
    const root = await makeDaemonPackageRoot();

    try {
      await writeFile(join(root, 'dist', 'cli.js'), 'export {};\n', 'utf8');
      await setSourceMtime(root, 100);
      await setMtime(join(root, 'dist', 'cli.js'), 200);

      const check = await checkDaemonCliBuild(root);

      expect(check.required).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('runs the daemon-owned build only for tools-dev source sidecars', async () => {
    const root = await makeDaemonPackageRoot();
    const runBuild = vi.fn(async () => undefined);
    const log = vi.fn();

    try {
      await prepareDaemonSidecarDevRuntime({
        log,
        packageRoot: root,
        runBuild,
        runtime: {
          mode: SIDECAR_MODES.DEV,
          source: SIDECAR_SOURCES.TOOLS_DEV,
        },
        workspaceRoot: '/workspace',
      });

      expect(runBuild).toHaveBeenCalledWith({
        workspaceRoot: '/workspace',
      });
      expect(log.mock.calls[0]?.[0]).toContain('apps/daemon/dist/cli.js is missing');

      runBuild.mockClear();
      await prepareDaemonSidecarDevRuntime({
        packageRoot: root,
        runBuild,
        runtime: {
          mode: SIDECAR_MODES.RUNTIME,
          source: SIDECAR_SOURCES.PACKAGED,
        },
        workspaceRoot: '/workspace',
      });
      expect(runBuild).not.toHaveBeenCalled();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
