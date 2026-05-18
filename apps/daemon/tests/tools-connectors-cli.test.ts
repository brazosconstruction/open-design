import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runConnectorsToolCli } from '../src/tools-connectors-cli.js';

const ORIGINAL_ENV = { ...process.env };

const AUDIT_DESIGN_MD = `# Cherry Studio Design System

## Product Context

Cherry Studio is a desktop AI chat workspace with a dense shell, assistant navigation, model selection, and composer-first workflows. The design system should preserve the compact app frame, clear message hierarchy, and source-backed assets.

## Color Foundations

Use the captured primary green, dark theme surfaces, muted dividers, and neutral text colors from source evidence. Color rules must document backgrounds, elevated panels, borders, text, primary actions, and status states.

## Typography

Ubuntu is the core sans family. Use clear size steps for navigation, message content, titles, dense metadata, and button labels. Keep mono text for code-like paths, IDs, and technical details.

## Spacing And Layout

Use compact spacing, slim gutters, and split-pane app layout rules. Preserve sidebar density, toolbar rhythm, composer placement, and scrollable content regions.

## Components

Define buttons, inputs, assistant rows, message bubbles, model selectors, icon actions, settings controls, and status surfaces with concrete states and usage notes.

## Motion And Interaction

Use quick hover/focus feedback, subtle panel transitions, predictable loading states, and reduced-motion fallbacks for desktop productivity.

## Voice And Brand

Use direct product language. Keep labels calm, technical, and concise while preserving Cherry Studio naming and app terminology.

## Anti-patterns

Avoid generic marketing pages, oversized cards, invented palettes, missing source assets, and preview pages that do not show real product modules.
`;

const AUDIT_README = `# Cherry Studio Design System

This package captures a source-backed Open Design design system for a desktop AI chat workspace. It includes reusable rules, token CSS, focused review previews, preserved assets, preserved fonts, and an applied UI kit.

## Package Contents

- DESIGN.md is the canonical Open Design rules document.
- colors_and_type.css contains reusable variables for color, type, spacing, radius, and states.
- preview/ contains focused HTML cards for color, typography, spacing, components, and brand assets.
- ui_kits/app/ contains an applied interface example for future project reuse.
- assets/ and fonts/ preserve source-backed brand and typography evidence.

## Review Workflow

Start with DESIGN.md, compare the preview cards, then inspect the applied UI kit. Reuse assets and fonts directly when building product surfaces.
`;

const AUDIT_SKILL = `# Cherry Studio Design System

Use this skill when creating Open Design artifacts that should match the Cherry Studio desktop AI chat workspace.

## Workflow

1. Read DESIGN.md first and treat it as the source of truth.
2. Load colors_and_type.css for concrete tokens.
3. Inspect preview/ for focused review cards before inventing new styling.
4. Use ui_kits/app/ as the applied interface pattern for chat, assistant navigation, model controls, and composer surfaces.
5. Preserve source-backed assets and fonts from assets/ and fonts/.

## Output Rules

Keep layouts compact, app-like, and productivity-focused. Use real component states, avoid generic landing pages, and keep typography and spacing grounded in the captured evidence.
`;

const AUDIT_TOKENS_CSS = `:root {
  --cherry-bg: #f7f8fa;
  --cherry-surface: #ffffff;
  --cherry-surface-muted: #f1f3f5;
  --cherry-fg: #202124;
  --cherry-muted: #73777f;
  --cherry-border: #dfe3e8;
  --cherry-primary: #00b96b;
  --cherry-primary-hover: #00a862;
  --cherry-danger: #ef4444;
  --cherry-font-sans: Ubuntu, Inter, ui-sans-serif, system-ui, sans-serif;
  --cherry-font-mono: SFMono-Regular, ui-monospace, monospace;
  --cherry-radius-sm: 6px;
  --cherry-radius-md: 10px;
  --cherry-space-1: 4px;
  --cherry-space-2: 8px;
  --cherry-space-3: 12px;
  --cherry-space-4: 16px;
}
`;

function auditHtml(title: string): string {
  const cards = Array.from({ length: 8 }, (_, index) => `<article><h2>${title} ${index + 1}</h2><p>Source-backed review content for compact desktop app surfaces, component states, spacing, typography, and reusable product modules.</p><button>Review state</button></article>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: Ubuntu, Inter, sans-serif; background: #f7f8fa; color: #202124; }
    main { width: min(960px, calc(100vw - 48px)); margin: 40px auto; display: grid; gap: 16px; }
    article { border: 1px solid #dfe3e8; border-radius: 10px; background: #fff; padding: 16px; }
    button { border: 1px solid #00b96b; background: #00b96b; color: #fff; border-radius: 8px; padding: 8px 12px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>A focused review card that preserves product density, component rhythm, and real source-backed design evidence.</p>
    ${cards}
  </main>
</body>
</html>
`;
}

describe('connectors tool CLI', () => {
  let stdoutWrite: { mockRestore: () => void };
  let stderrWrite: { mockRestore: () => void };
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let cwd: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    cwd = process.cwd();
    stdoutOutput = [];
    stderrOutput = [];
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ connectors: [] }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.env = ORIGINAL_ENV;
    process.chdir(cwd);
  });

  it('appends curated useCase query params for connector listing', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456/base/';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ connectors: [] }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['list', '--use-case', 'personal_daily_digest']);

    expect(result.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/base/api/tools/connectors/list?useCase=personal_daily_digest',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer agent-run-token' }),
      }),
    );
  });

  it('includes curation in compact connector output', async () => {
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      connectors: [{
        id: 'slack',
        name: 'Slack',
        provider: 'composio',
        category: 'Communication',
        status: 'connected',
        tools: [{
          name: 'slack.slack_list_channels',
          description: 'List Slack channels',
          safety: { sideEffect: 'read', approval: 'auto', reason: 'read-only' },
          curation: { useCases: ['personal_daily_digest'], reason: 'Digest source' },
        }],
      }],
    }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['list']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toEqual({
      ok: true,
      connectors: [{
        id: 'slack',
        name: 'Slack',
        provider: 'composio',
        category: 'Communication',
        status: 'connected',
        accountLabel: undefined,
        tools: [{
          name: 'slack.slack_list_channels',
          description: 'List Slack channels',
          safety: { sideEffect: 'read', approval: 'auto', reason: 'read-only' },
          curation: { useCases: ['personal_daily_digest'], reason: 'Digest source' },
          inputSchema: undefined,
        }],
      }],
    });
    expect(stderrOutput.join('')).toBe('');
  });

  it('writes GitHub design evidence through connected connector tools', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
          tools: [{ name: 'github.github_get_repository_content' }],
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { default_branch: 'main', html_url: 'https://github.com/acme/ui' } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { path: 'README.md', encoding: 'base64', content: encode('# Acme UI') } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { tree: [
          { path: 'package.json', type: 'blob' },
          { path: 'src/components/Button.tsx', type: 'blob' },
          { path: 'src/styles.css', type: 'blob' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: ':root { --color-brand: #ff5500; --radius-md: 8px; }' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: { mimetype: 'text/plain', name: 'Button.tsx', s3url: 'https://signed.example/Button.tsx' } } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response('export function Button(){ return <button className="rounded-md" /> }', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: '{"dependencies":{"@radix-ui/react-slot":"latest"}}' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/ui', '--max-files', '3']);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join(''));
    expect(stdout).toEqual(expect.objectContaining({
      ok: true,
      repo: 'acme/ui',
      method: 'connector',
      outputPath: 'context/github/acme-ui.md',
    }));
    const evidenceNote = await readFile(path.join(tmpDir, 'context/github/acme-ui.md'), 'utf8');
    expect(evidenceNote).toContain('GitHub connector was used');
    expect(evidenceNote).toContain('Source Evidence Inventory');
    expect(evidenceNote).toContain('Theme, tokens, and styling');
    expect(evidenceNote).toContain('Reusable components');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-ui/files/src/components/Button.tsx'), 'utf8')).resolves.toContain('rounded-md');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/api/tools/connectors/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('github.github_get_raw_repository_content'),
      }),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes bounded local design evidence snapshots from a linked folder', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-local-context-'));
    process.chdir(tmpDir);
    const sourceDir = path.join(tmpDir, 'cherry-studio');
    await mkdir(path.join(sourceDir, 'src/components'), { recursive: true });
    await mkdir(path.join(sourceDir, 'src/assets/fonts/ubuntu'), { recursive: true });
    await mkdir(path.join(sourceDir, 'build'), { recursive: true });
    await writeFile(path.join(sourceDir, 'README.md'), '# Cherry Studio\n\nDesktop AI chat workspace.');
    await writeFile(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'cherry-studio' }));
    await writeFile(path.join(sourceDir, 'src/styles.css'), ':root { --color-primary: #db6f57; }');
    await writeFile(path.join(sourceDir, 'src/components/Button.tsx'), 'export function Button() { return <button className="rounded-lg" />; }');
    await writeFile(path.join(sourceDir, 'src/assets/fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));
    await writeFile(path.join(sourceDir, 'build/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await runConnectorsToolCli([
      'local-design-context',
      '--path',
      sourceDir,
      '--output',
      'context/local-code/cherry-studio.md',
      '--max-files',
      '8',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: true,
      sourcePath: sourceDir,
      method: 'local-folder',
      outputPath: 'context/local-code/cherry-studio.md',
      snapshotFiles: expect.arrayContaining([
        'context/local-code/cherry-studio/files/package.json',
        'context/local-code/cherry-studio/files/src/styles.css',
        'context/local-code/cherry-studio/files/src/components/Button.tsx',
        'context/local-code/cherry-studio/files/src/assets/fonts/ubuntu/Ubuntu-Regular.ttf',
        'context/local-code/cherry-studio/files/build/logo.png',
      ]),
    });
    const evidenceNote = await readFile(path.join(tmpDir, 'context/local-code/cherry-studio.md'), 'utf8');
    expect(evidenceNote).toContain('Local Design Evidence');
    expect(evidenceNote).toContain('Source Evidence Inventory');
    expect(evidenceNote).toContain('Brand assets and icons');
    expect(evidenceNote).toContain('Fonts');
    expect(evidenceNote).toContain('Claude Design-style package');
    await expect(readFile(path.join(tmpDir, 'context/local-code/cherry-studio/files/src/styles.css'), 'utf8')).resolves.toContain('--color-primary');
    const fontBytes = await readFile(path.join(tmpDir, 'context/local-code/cherry-studio/files/src/assets/fonts/ubuntu/Ubuntu-Regular.ttf'));
    expect(fontBytes.length).toBeGreaterThan(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('passes a Claude Design-style design-system package audit', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-package-audit-pass-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'fonts/ubuntu'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditHtml('Cherry Studio UI kit'));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));
    await writeFile(path.join(tmpDir, 'context/source-context.md'), [
      '# Design System Source Context',
      '',
      '## GitHub Repositories',
      '',
      '- None linked.',
      '',
      '## Local Code',
      '',
      'Linked folders readable by the local agent:',
      '- /tmp/cherry',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 2',
      '',
      '### Brand assets and icons',
      '- assets/logo.png -> `context/local-code/cherry/files/assets/logo.png` (binary asset)',
      '',
      '### Fonts',
      '- fonts/ubuntu/Ubuntu-Regular.ttf -> `context/local-code/cherry/files/fonts/ubuntu/Ubuntu-Regular.ttf` (binary asset)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/tokens.css'), ':root { --color-primary: #00b96b; }');

    const result = await runConnectorsToolCli(['design-system-package-audit', '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: true,
      errors: [],
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('fails a design-system package audit when evidence-backed artifacts are missing', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-package-audit-fail-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/generated_interface'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), '# Incomplete\n');
    await writeFile(path.join(tmpDir, 'preview/typography-scale.html'), '<!doctype html>');
    await writeFile(path.join(tmpDir, 'ui_kits/generated_interface/index.html'), '<!doctype html>');
    await writeFile(path.join(tmpDir, 'context/source-context.md'), [
      '# Design System Source Context',
      '',
      '## GitHub Repositories',
      '',
      '- https://github.com/acme/ui',
      '',
      '## Local Code',
      '',
      'Linked folders readable by the local agent:',
      '- /tmp/acme-ui',
    ].join('\n'));

    const result = await runConnectorsToolCli(['design-system-package-audit', '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(stdoutOutput.join(''));
    expect(output.ok).toBe(false);
    expect(output.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_required_file', path: 'README.md' }),
      expect.objectContaining({ code: 'missing_github_evidence' }),
      expect.objectContaining({ code: 'missing_local_evidence' }),
      expect.objectContaining({ code: 'old_generated_interface' }),
    ]));

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('can audit an external Claude Design reference package without DESIGN.md', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-package-audit-reference-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'fonts/ubuntu'), { recursive: true });
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'colors-theme-dark.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'spacing-radius.html',
      'components-buttons.html',
      'components-inputs.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditHtml('Cherry Studio UI kit'));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));

    const strict = await runConnectorsToolCli(['design-system-package-audit', '--path', tmpDir]);
    expect(strict.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_required_file', path: 'DESIGN.md' }),
    ]));

    stdoutOutput = [];
    const reference = await runConnectorsToolCli(['design-system-package-audit', '--path', tmpDir, '--reference-package']);
    expect(reference.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: true,
      errors: [],
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'missing_open_design_rules', path: 'DESIGN.md' }),
      ]),
    });

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('falls back to bounded connector directory browsing when the repository tree is too large', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
          tools: [{ name: 'github.github_get_repository_content' }],
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { default_branch: 'main', html_url: 'https://github.com/acme/ui' } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { path: 'README.md', encoding: 'base64', content: encode('# Acme UI') } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CONNECTOR_OUTPUT_TOO_LARGE', message: 'connector output exceeds max serialized size' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'package.json', type: 'file' },
          { path: 'src', type: 'dir' },
          { path: 'docs', type: 'dir' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'src/styles.css', type: 'file' },
          { path: 'src/components', type: 'dir' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [{ path: 'src/components/Button.tsx', type: 'file' }] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: '{"dependencies":{"@radix-ui/react-slot":"latest"}}' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: ':root { --color-brand: #ff5500; }' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: 'export function Button(){ return <button /> }' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/ui', '--max-files', '3', '--require-connector']);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join(''));
    expect(stdout).toEqual(expect.objectContaining({
      ok: true,
      method: 'connector',
      warnings: expect.arrayContaining([
        expect.stringContaining('Recursive tree connector read failed'),
      ]),
    }));
    await expect(readFile(path.join(tmpDir, 'context/github/acme-ui.md'), 'utf8')).resolves.toContain('bounded directory browsing');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-ui.md'), 'utf8')).resolves.toContain('src/components/Button.tsx');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:7456/api/tools/connectors/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('github.github_get_repository_content'),
      }),
    );

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('continues bounded GitHub intake when repository metadata is too large', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
          tools: [{ name: 'github.github_get_repository_content' }],
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CONNECTOR_OUTPUT_TOO_LARGE', message: 'connector output exceeds max serialized size' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { path: 'README.md', encoding: 'base64', content: encode('# Huge Repo UI') } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CONNECTOR_OUTPUT_TOO_LARGE', message: 'connector output exceeds max serialized size' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'package.json', type: 'file' },
          { path: 'src', type: 'dir' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'src/styles.css', type: 'file' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: ':root { --color-brand: #ff5500; }' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: '{"dependencies":{"@radix-ui/react-slot":"latest"}}' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/huge-ui', '--max-files', '2', '--require-connector']);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join(''));
    expect(stdout).toEqual(expect.objectContaining({
      ok: true,
      method: 'connector',
      warnings: expect.arrayContaining([
        expect.stringContaining('Repository metadata connector read failed'),
        expect.stringContaining('Recursive tree connector read failed'),
      ]),
    }));
    await expect(readFile(path.join(tmpDir, 'context/github/acme-huge-ui.md'), 'utf8')).resolves.toContain('Huge Repo UI');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-huge-ui/files/src/styles.css'), 'utf8')).resolves.toContain('--color-brand');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses shallow local clone fallback when connector rate limits all snapshot file reads', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const fakeBinDir = path.join(tmpDir, 'bin');
    await mkdir(fakeBinDir, { recursive: true });
    const fakeGitPath = path.join(fakeBinDir, 'git');
    await writeFile(fakeGitPath, `#!/bin/sh
for last do :; done
mkdir -p "$last/src"
mkdir -p "$last/build"
mkdir -p "$last/fonts/ubuntu"
cat > "$last/README.md" <<'EOF'
# Fallback UI
EOF
cat > "$last/package.json" <<'EOF'
{"dependencies":{"@radix-ui/react-dialog":"latest"}}
EOF
cat > "$last/src/styles.css" <<'EOF'
:root { --color-brand: #dc5b3e; --radius-md: 10px; }
EOF
printf '\\211PNG\\r\\n\\032\\n' > "$last/build/icon.png"
printf '\\211PNG\\r\\n\\032\\n' > "$last/build/logo.png"
printf 'font-data' > "$last/fonts/ubuntu/Ubuntu-Regular.ttf"
`, 'utf8');
    await chmod(fakeGitPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`;

    const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
          tools: [{ name: 'github.github_get_repository_content' }],
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { default_branch: 'main', html_url: 'https://github.com/acme/rate-limited-ui' } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { path: 'README.md', encoding: 'base64', content: encode('# Connector README') } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CONNECTOR_OUTPUT_TOO_LARGE', message: 'connector output exceeds max serialized size' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'package.json', type: 'file' },
          { path: 'src', type: 'dir' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        output: { data: { content: [
          { path: 'src/styles.css', type: 'file' },
        ] } },
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CONNECTOR_RATE_LIMITED', message: 'connector tool rate limit exceeded' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: 'CONNECTOR_RATE_LIMITED', message: 'connector tool rate limit exceeded' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 429 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/rate-limited-ui', '--max-files', '6', '--require-connector']);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join(''));
    expect(stdout).toEqual(expect.objectContaining({
      ok: true,
      method: 'git-clone-fallback',
      localCloneMethod: 'git',
      snapshotFiles: expect.arrayContaining([
        'context/github/acme-rate-limited-ui/files/package.json',
        'context/github/acme-rate-limited-ui/files/build/icon.png',
        'context/github/acme-rate-limited-ui/files/build/logo.png',
        'context/github/acme-rate-limited-ui/files/fonts/ubuntu/Ubuntu-Regular.ttf',
        'context/github/acme-rate-limited-ui/files/src/styles.css',
      ]),
      warnings: expect.arrayContaining([
        expect.stringContaining('CONNECTOR_RATE_LIMITED'),
        expect.stringContaining('GitHub connector bounded intake produced no snapshot files.'),
      ]),
    }));
    const evidenceNote = await readFile(path.join(tmpDir, 'context/github/acme-rate-limited-ui.md'), 'utf8');
    expect(evidenceNote).toContain('shallow local clone fallback');
    expect(evidenceNote).toContain('Source Evidence Inventory');
    expect(evidenceNote).toContain('Brand assets and icons');
    expect(evidenceNote).toContain('Fonts');
    expect(evidenceNote).toContain('Binary Assets Preserved');
    expect(evidenceNote).toContain('build/icon.png');
    expect(evidenceNote).toContain('Claude Design-style package');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-rate-limited-ui/files/src/styles.css'), 'utf8')).resolves.toContain('--color-brand');
    const iconBytes = await readFile(path.join(tmpDir, 'context/github/acme-rate-limited-ui/files/build/icon.png'));
    expect(iconBytes.length).toBeGreaterThan(0);
    const fontBytes = await readFile(path.join(tmpDir, 'context/github/acme-rate-limited-ui/files/fonts/ubuntu/Ubuntu-Regular.ttf'));
    expect(fontBytes.length).toBeGreaterThan(0);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('uses GitHub CLI authenticated clone when connector access fails', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const fakeBinDir = path.join(tmpDir, 'bin');
    await mkdir(fakeBinDir, { recursive: true });
    const fakeGitPath = path.join(fakeBinDir, 'git');
    await writeFile(fakeGitPath, `#!/bin/sh
echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2
exit 128
`, 'utf8');
    await chmod(fakeGitPath, 0o755);
    const fakeGhPath = path.join(fakeBinDir, 'gh');
    await writeFile(fakeGhPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.0.0"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "Logged in to github.com account qiongyu" >&2
  exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "clone" ]; then
  dest="$4"
  mkdir -p "$dest/src"
  cat > "$dest/README.md" <<'EOF'
# Private UI
EOF
  cat > "$dest/package.json" <<'EOF'
{"dependencies":{"@radix-ui/react-tabs":"latest"}}
EOF
  cat > "$dest/src/theme.css" <<'EOF'
:root { --color-brand: #f15a24; --space-md: 16px; }
EOF
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`, 'utf8');
    await chmod(fakeGhPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`;

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'repository access denied' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 403 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/private-ui', '--require-connector']);

    expect(result.exitCode).toBe(0);
    const stdout = JSON.parse(stdoutOutput.join(''));
    expect(stdout).toEqual(expect.objectContaining({
      ok: true,
      method: 'git-clone-fallback',
      localCloneMethod: 'gh-cli',
      snapshotFiles: expect.arrayContaining([
        'context/github/acme-private-ui/files/package.json',
        'context/github/acme-private-ui/files/src/theme.css',
      ]),
      warnings: expect.arrayContaining([
        expect.stringContaining('GitHub CLI clone'),
        expect.stringContaining('repository access denied'),
      ]),
    }));
    await expect(readFile(path.join(tmpDir, 'context/github/acme-private-ui.md'), 'utf8')).resolves.toContain('GitHub CLI authenticated clone');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-private-ui/files/src/theme.css'), 'utf8')).resolves.toContain('--color-brand');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports GitHub CLI login when connector and local clone cannot read a repository', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'od-connectors-cli-'));
    process.chdir(tmpDir);
    process.env.OD_DAEMON_URL = 'http://127.0.0.1:7456';
    process.env.OD_TOOL_TOKEN = 'agent-run-token';

    const fakeBinDir = path.join(tmpDir, 'bin');
    await mkdir(fakeBinDir, { recursive: true });
    const fakeGitPath = path.join(fakeBinDir, 'git');
    await writeFile(fakeGitPath, `#!/bin/sh
echo "fatal: repository not found" >&2
exit 128
`, 'utf8');
    await chmod(fakeGitPath, 0o755);
    const fakeGhPath = path.join(fakeBinDir, 'gh');
    await writeFile(fakeGhPath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version 2.0.0"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "You are not logged into any GitHub hosts" >&2
  exit 1
fi
echo "unexpected gh args: $*" >&2
exit 1
`, 'utf8');
    await chmod(fakeGhPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ''}`;

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        connectors: [{
          id: 'github',
          name: 'GitHub',
          provider: 'composio',
          category: 'Developer',
          status: 'connected',
        }],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'repository access denied' },
      }), { headers: { 'Content-Type': 'application/json' }, status: 403 }));

    const result = await runConnectorsToolCli(['github-design-context', '--repo', 'acme/private-ui', '--require-connector']);

    expect(result.exitCode).toBe(1);
    expect(stderrOutput.join('')).toContain('Required GitHub repository intake could not read the repository through connector, git, or GitHub CLI');
    expect(stderrOutput.join('')).toContain('gh auth login --web');
    await expect(readFile(path.join(tmpDir, 'context/github/acme-private-ui.md'), 'utf8')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
