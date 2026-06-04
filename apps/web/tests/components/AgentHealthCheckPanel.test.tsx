// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentHealthCheckPanel } from '../../src/components/AgentHealthCheckPanel';
import type { AgentHealthCheckResult } from '../../src/types';
import { en } from '../../src/i18n/locales/en';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const healthy: AgentHealthCheckResult = {
  agentId: 'cursor-agent',
  agentName: 'Cursor Agent',
  available: true,
  version: '2026.05.07',
  overall: 'pass',
  checks: [
    { id: 'detected', status: 'pass', label: 'Cursor Agent found at /usr/local/bin/cursor-agent' },
    { id: 'invocable', status: 'pass', label: 'Runs OK (v2026.05.07)' },
    { id: 'authenticated', status: 'pass', label: 'Authenticated.' },
    { id: 'smoke', status: 'pass', label: 'Live reply OK (12ms).' },
  ],
  smoke: { ok: true, kind: 'success', latencyMs: 12, model: 'default' },
  ranAt: new Date().toISOString(),
};

const broken: AgentHealthCheckResult = {
  agentId: 'gemini',
  agentName: 'Gemini',
  available: false,
  overall: 'fail',
  checks: [
    {
      id: 'detected',
      status: 'fail',
      label: 'Gemini (`gemini`) was not found on your PATH.',
      diagnostic: {
        reason: 'not-on-path',
        severity: 'error',
        message: 'Gemini (`gemini`) was not found on your PATH.',
        fixActions: [{ kind: 'rescan' }],
      },
    },
    { id: 'invocable', status: 'skip', label: 'Skipped — binary not found.' },
    { id: 'authenticated', status: 'skip', label: 'Skipped — agent not runnable.' },
    { id: 'smoke', status: 'skip', label: 'Skipped — agent not runnable.' },
  ],
  ranAt: new Date().toISOString(),
};

describe('AgentHealthCheckPanel', () => {
  it('leads with a concise verdict and reveals the checklist on demand when healthy', () => {
    render(<AgentHealthCheckPanel result={healthy} />);
    const group = screen.getByRole('group');
    expect(group.getAttribute('data-overall')).toBe('pass');
    // The live latency is the one signal worth a glance; the technical
    // checklist stays collapsed.
    expect(screen.getByText('Live reply in 12ms')).toBeTruthy();
    expect(screen.queryByText('Runs OK (v2026.05.07)')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: en['settings.healthcheck.details'] }),
    );
    expect(screen.getByText('Runs OK (v2026.05.07)')).toBeTruthy();
    expect(screen.getByText('Live reply OK (12ms).')).toBeTruthy();
  });

  it('renders a diagnostic row with its fix button for a failed step', () => {
    const onRescan = vi.fn();
    render(
      <AgentHealthCheckPanel result={broken} handlers={{ onRescan }} />,
    );
    // The failing `detected` step leads (not hidden behind the disclosure) and
    // delegates to AgentDiagnosticRow, which exposes the rescan affordance as an
    // icon button named by its aria-label.
    const rescan = screen.getByRole('button', { name: en['settings.rescan'] });
    fireEvent.click(rescan);
    expect(onRescan).toHaveBeenCalledTimes(1);
    // Skipped steps are tucked into the collapsed details, not shown as results.
    expect(screen.queryByText('Skipped — binary not found.')).toBeNull();
  });

  it('invokes onRerun from the re-run button', () => {
    const onRerun = vi.fn();
    render(<AgentHealthCheckPanel result={healthy} onRerun={onRerun} />);
    fireEvent.click(
      screen.getByRole('button', { name: en['settings.healthcheck.rerun'] }),
    );
    expect(onRerun).toHaveBeenCalledTimes(1);
  });
});
