import type {
  DesignSystemPackageAudit,
  DesignSystemPackageAuditIssue,
} from '../types';

function issueCountLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function auditIssueSummary(issue: DesignSystemPackageAuditIssue): string {
  return issue.path ? `${issue.code} (${issue.path})` : issue.code;
}

export function designSystemPackageAuditHasFindings(audit: DesignSystemPackageAudit): boolean {
  return audit.errors.length + audit.warnings.length > 0;
}

export function summarizeDesignSystemPackageAudit(audit: DesignSystemPackageAudit): string {
  if (!designSystemPackageAuditHasFindings(audit)) {
    return `Package audit passed (${issueCountLabel(audit.filesInspected, 'file')} inspected).`;
  }
  const countLabel = [
    audit.errors.length ? issueCountLabel(audit.errors.length, 'error') : '',
    audit.warnings.length ? issueCountLabel(audit.warnings.length, 'warning') : '',
  ].filter(Boolean).join(' and ');
  const findings = [...audit.errors, ...audit.warnings];
  const listed = findings.slice(0, 5).map(auditIssueSummary).join(', ');
  const extra = findings.length > 5 ? `, +${findings.length - 5} more` : '';
  return `Package audit found ${countLabel}: ${listed}${extra}.`;
}

export function buildDesignSystemPackageAuditRepairPrompt(
  audit: DesignSystemPackageAudit,
): string | null {
  if (!designSystemPackageAuditHasFindings(audit)) return null;
  const findings = [...audit.errors, ...audit.warnings]
    .slice(0, 16)
    .map((issue) => {
      const pathLabel = issue.path ? ` ${issue.path}` : '';
      return `- [${issue.severity}] ${issue.code}${pathLabel}: ${issue.message}`;
    });
  const hiddenCount = audit.errors.length + audit.warnings.length - findings.length;
  if (hiddenCount > 0) findings.push(`- ...and ${hiddenCount} more audit finding(s).`);
  return [
    'Fix the design-system package audit findings below.',
    '',
    'Update the package files directly, then rerun `"$OD_NODE_BIN" "$OD_BIN" tools connectors design-system-package-audit --path . --fail-on-warnings` until it passes.',
    '',
    'Audit findings:',
    ...findings,
  ].join('\n');
}
