import { useState } from 'react';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import type {
  AgentHealthCheckId,
  AgentHealthCheckItem,
  AgentHealthCheckResult,
  AgentHealthStatus,
} from '../types';
import { AgentDiagnosticRow } from './AgentDiagnosticRow';
import type { AgentFixHandlers } from './AgentDiagnosticRow';
import { Icon } from './Icon';
import styles from './AgentHealthCheckPanel.module.css';

interface Props {
  result: AgentHealthCheckResult;
  /** Wired per fix intent and forwarded to each diagnostic row's fix buttons. */
  handlers?: AgentFixHandlers;
  /** True while a (re-)run is in flight; disables the re-run button. */
  running?: boolean;
  onRerun?: () => void;
}

const OVERALL_KEY: Record<Exclude<AgentHealthStatus, 'skip'>, keyof Dict> = {
  pass: 'settings.healthcheck.overall.pass',
  warn: 'settings.healthcheck.overall.warn',
  fail: 'settings.healthcheck.overall.fail',
};

const CHECK_KEY: Record<AgentHealthCheckId, keyof Dict> = {
  detected: 'settings.healthcheck.check.detected',
  invocable: 'settings.healthcheck.check.invocable',
  authenticated: 'settings.healthcheck.check.authenticated',
  smoke: 'settings.healthcheck.check.smoke',
};

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function AgentHealthCheckPanel({ result, handlers = {}, running, onRerun }: Props) {
  const t = useT();
  const [showDetails, setShowDetails] = useState(false);

  // The panel serves two moments: when everything passes the user just wants
  // reassurance (verdict + the one useful signal: live latency), so the full
  // technical checklist hides behind a disclosure. When something is wrong the
  // failing/warning steps lead with their fix affordances and the steps that
  // passed / were skipped move into the disclosure.
  const problems = result.checks.filter(
    (c) => c.status === 'fail' || c.status === 'warn',
  );
  const detailChecks =
    problems.length > 0
      ? result.checks.filter((c) => c.status !== 'fail' && c.status !== 'warn')
      : result.checks;

  const latency =
    result.overall === 'pass' && result.smoke?.latencyMs != null
      ? formatLatency(result.smoke.latencyMs)
      : null;

  const renderStep = (check: AgentHealthCheckItem) => (
    <li key={check.id} className={styles.item} data-status={check.status}>
      <span className={styles.dot} data-status={check.status} aria-hidden="true" />
      <div className={styles.body}>
        <span className={styles.name}>{t(CHECK_KEY[check.id])}</span>
        {check.diagnostic ? (
          // Reuse the detection row so a failing step shows the same
          // Install / Docs / Rescan / Sign-in affordances as the
          // unavailable-agent grid — one source of truth for fixes.
          <AgentDiagnosticRow diagnostic={check.diagnostic} handlers={handlers} />
        ) : (
          // Daemon-authored specifics (path / version / latency) stay as a
          // muted technical detail; the localized name + status dot above
          // carry the meaning.
          <span className={styles.detail}>{check.label}</span>
        )}
      </div>
    </li>
  );

  return (
    <div className={styles.root} role="group" data-overall={result.overall}>
      <div className={styles.header}>
        <span className={styles.overall} data-status={result.overall}>
          <span className={styles.dot} data-status={result.overall} aria-hidden="true" />
          {t(OVERALL_KEY[result.overall])}
        </span>
        {onRerun ? (
          <button
            type="button"
            className={'ghost icon-btn ' + styles.rerun + (running ? ' loading' : '')}
            onClick={onRerun}
            disabled={running}
            title={t('settings.healthcheck.rerun')}
            aria-label={t('settings.healthcheck.rerun')}
          >
            <Icon
              name={running ? 'spinner' : 'reload'}
              size={13}
              className={running ? 'icon-spin' : undefined}
            />
          </button>
        ) : null}
      </div>

      {latency ? (
        <p className={styles.summary}>
          {t('settings.healthcheck.latency', { value: latency })}
        </p>
      ) : null}

      {problems.length > 0 ? (
        <ul className={styles.checks}>{problems.map(renderStep)}</ul>
      ) : null}

      {detailChecks.length > 0 ? (
        <div className={styles.details}>
          <button
            type="button"
            className={styles.detailsToggle}
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            <Icon
              name={showDetails ? 'chevron-down' : 'chevron-right'}
              size={12}
            />
            {t('settings.healthcheck.details')}
          </button>
          {showDetails ? (
            <ul className={styles.checks}>{detailChecks.map(renderStep)}</ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
