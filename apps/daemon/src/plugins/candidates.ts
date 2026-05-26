import type Database from 'better-sqlite3';
import type {
  SkillPluginCandidate as ContractSkillPluginCandidate,
  SkillPluginCandidateDraftInput as ContractSkillPluginCandidateDraftInput,
  SkillPluginCandidateProvenance as ContractSkillPluginCandidateProvenance,
  SkillPluginCandidateSourceKind as ContractSkillPluginCandidateSourceKind,
} from '@open-design/contracts';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

type SqliteDb = Database.Database;
type DbRow = Record<string, unknown>;

export type SkillPluginCandidateSourceKind = ContractSkillPluginCandidateSourceKind;
export type SkillPluginCandidateProvenance = ContractSkillPluginCandidateProvenance;
export type SkillPluginCandidateDraftInput = ContractSkillPluginCandidateDraftInput;

export interface SkillPluginCandidateInput {
  sourceKind: SkillPluginCandidateSourceKind;
  sourceRef: string;
  provenance: SkillPluginCandidateProvenance;
  confidence: number;
  title?: string;
  description?: string;
  fingerprint: string;
  draftInput: SkillPluginCandidateDraftInput;
}

export type SkillPluginCandidateRow = ContractSkillPluginCandidate;

export interface DetectSkillPluginCandidatesInput {
  projectRoot?: string | null;
  attachments?: unknown;
  message?: unknown;
  currentPrompt?: unknown;
  systemPrompt?: unknown;
}

const MAX_MARKDOWN_READ_BYTES = 128 * 1024;
const DESCRIPTION_RE = /^\s*description\s*:\s*["']?(.+?)["']?\s*$/im;
const TITLE_RE = /^\s*#\s+(.+?)\s*$/m;
const GITHUB_URL_RE = /https?:\/\/github\.com\/[^\s<>)"']+/gi;
const GITHUB_SHORTHAND_RE = /github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s<>)"']+)?/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeMarkdownText(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function normalizeSourceRefForIdentity(sourceRef: string): string {
  return sourceRef.replace(/\\/g, '/').trim();
}

function candidateFingerprint(sourceKind: SkillPluginCandidateSourceKind, sourceRef: string): string {
  return createHash('sha256')
    .update(sourceKind)
    .update('\0')
    .update(normalizeSourceRefForIdentity(sourceRef))
    .digest('hex');
}

function deriveTitle(markdown: string, fallback: string): string {
  const frontmatterName = markdown.match(/^\s*name\s*:\s*["']?(.+?)["']?\s*$/im)?.[1];
  const title = markdown.match(/^\s*title\s*:\s*["']?(.+?)["']?\s*$/im)?.[1];
  const heading = markdown.match(TITLE_RE)?.[1];
  return compact(frontmatterName ?? title ?? heading ?? fallback).slice(0, 120);
}

function deriveDescription(markdown: string): string | undefined {
  const fm = markdown.match(DESCRIPTION_RE)?.[1];
  if (fm) return compact(fm).slice(0, 240);
  const afterHeading = markdown
    .replace(/^---[\s\S]*?---\s*/m, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  return afterHeading ? compact(afterHeading).slice(0, 240) : undefined;
}

function looksLikeReusableSkillDoc(markdown: string, fileName: string): boolean {
  const name = path.basename(fileName).toLowerCase();
  if (name === 'skill.md') return true;
  if (!name.endsWith('.md')) return false;
  const text = markdown.toLowerCase();
  const hasSkillIdentity =
    /\bskill\b/.test(text) &&
    (/\btrigger\b/.test(text) ||
      /\buse when\b/.test(text) ||
      /\bworkflow\b/.test(text) ||
      /\btools?\b/.test(text) ||
      /\binputs?\b/.test(text));
  const hasReusableFrontmatter =
    /^\s*---[\s\S]*?\bname\s*:/m.test(markdown) &&
    /\bdescription\s*:/i.test(markdown);
  return hasSkillIdentity || hasReusableFrontmatter;
}

function markdownCandidate(
  sourceKind: SkillPluginCandidateSourceKind,
  sourceRef: string,
  markdown: string,
): SkillPluginCandidateInput | null {
  const normalized = normalizeMarkdownText(markdown).slice(0, MAX_MARKDOWN_READ_BYTES);
  const fileName = path.basename(sourceRef);
  const explicitSkillMd = fileName.toLowerCase() === 'skill.md';
  if (!explicitSkillMd && !looksLikeReusableSkillDoc(normalized, fileName)) return null;

  const title = deriveTitle(normalized, explicitSkillMd ? 'SKILL.md' : fileName.replace(/\.md$/i, ''));
  const description = deriveDescription(normalized);
  return {
    sourceKind,
    sourceRef,
    provenance: explicitSkillMd ? 'uploaded-skill-md' : 'markdown-skill-doc',
    confidence: explicitSkillMd ? 0.96 : 0.72,
    title,
    ...(description ? { description } : {}),
    fingerprint: candidateFingerprint(sourceKind, sourceRef),
    draftInput: {
      artifactKind: explicitSkillMd ? 'skill-md' : 'markdown-skill-doc',
      source: sourceRef,
      title,
      ...(description ? { description } : {}),
      contentExcerpt: normalized.slice(0, 4000),
      suggestedFiles: ['SKILL.md', 'open-design.json'],
    },
  };
}

function normalizeGithubRef(raw: string): string | null {
  const trimmed = raw.replace(/[.,;:!?]+$/g, '');
  if (trimmed.startsWith('github:')) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `https://github.com/${parts.join('/')}`;
  } catch {
    return null;
  }
}

function isPluginLikeRepoRef(ref: string): boolean {
  const lower = ref.toLowerCase();
  return (
    lower.includes('skill.md') ||
    lower.includes('open-design.json') ||
    lower.includes('.claude-plugin') ||
    lower.includes('plugin.json') ||
    lower.endsWith('/plugins') ||
    lower.includes('/plugins/')
  );
}

function repoCandidate(ref: string): SkillPluginCandidateInput | null {
  if (!isPluginLikeRepoRef(ref)) return null;
  const refPath = ref.replace(/^github:/, '').split(/[/?#]/)[0] ?? '';
  const parts = refPath.split('/').filter(Boolean);
  const repoTitle = parts.length >= 2 ? parts.slice(0, 2).join('/') : 'GitHub plugin source';
  return {
    sourceKind: 'repo-link',
    sourceRef: ref,
    provenance: 'plugin-like-link',
    confidence: ref.toLowerCase().includes('skill.md') || ref.toLowerCase().includes('open-design.json') ? 0.84 : 0.68,
    title: repoTitle,
    description: 'Repository link contains plugin-like Open Design files.',
    fingerprint: candidateFingerprint('repo-link', ref),
    draftInput: {
      artifactKind: 'repo-plugin',
      source: ref,
      title: repoTitle,
      description: 'Repository link contains plugin-like Open Design files.',
      suggestedFiles: ['open-design.json', 'SKILL.md'],
    },
  };
}

function promptText(input: DetectSkillPluginCandidatesInput): string {
  return [input.message, input.currentPrompt, input.systemPrompt]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function projectRelativePath(root: string, candidate: string): string | null {
  try {
    const abs = path.resolve(root, candidate);
    const rel = path.relative(path.resolve(root), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  } catch {
    return null;
  }
}

async function readMarkdownUnderProject(root: string, rel: string): Promise<string | null> {
  try {
    const abs = path.resolve(root, rel);
    const safeRel = path.relative(path.resolve(root), abs);
    if (!safeRel || safeRel.startsWith('..') || path.isAbsolute(safeRel)) return null;
    const stat = await fs.stat(abs);
    if (!stat.isFile() || stat.size > MAX_MARKDOWN_READ_BYTES) return null;
    return await fs.readFile(abs, 'utf8');
  } catch {
    return null;
  }
}

export async function detectSkillPluginCandidates(
  input: DetectSkillPluginCandidatesInput,
): Promise<SkillPluginCandidateInput[]> {
  const found = new Map<string, SkillPluginCandidateInput>();
  const root = typeof input.projectRoot === 'string' && input.projectRoot ? input.projectRoot : null;

  if (root && Array.isArray(input.attachments)) {
    for (const attachment of input.attachments) {
      if (typeof attachment !== 'string') continue;
      const rel = projectRelativePath(root, attachment);
      if (!rel || !rel.toLowerCase().endsWith('.md')) continue;
      const body = await readMarkdownUnderProject(root, rel);
      if (!body) continue;
      const candidate = markdownCandidate('project-file', rel, body);
      if (candidate) found.set(candidate.fingerprint, candidate);
    }
  }

  const text = promptText(input);
  for (const match of [...text.matchAll(GITHUB_URL_RE), ...text.matchAll(GITHUB_SHORTHAND_RE)]) {
    const ref = normalizeGithubRef(match[0]);
    if (!ref) continue;
    const candidate = repoCandidate(ref);
    if (candidate) found.set(candidate.fingerprint, candidate);
  }

  if (root) {
    const referencedMd = text.match(/(?:^|[\s"`'(<])([A-Za-z0-9_.\/-]+\.md)(?=$|[\s"`')>,.])/g) ?? [];
    for (const raw of referencedMd) {
      const rel = projectRelativePath(root, raw.trim().replace(/^["'`(<]+|[)"'`>,.]+$/g, ''));
      if (!rel) continue;
      const body = await readMarkdownUnderProject(root, rel);
      if (!body) continue;
      const candidate = markdownCandidate('referenced-file', rel, body);
      if (candidate) found.set(candidate.fingerprint, candidate);
    }
  }

  return Array.from(found.values()).sort((a, b) => b.confidence - a.confidence);
}

function parseCandidateRow(row: DbRow): SkillPluginCandidateRow {
  const draftInput = typeof row.draftInputJson === 'string'
    ? JSON.parse(row.draftInputJson) as SkillPluginCandidateDraftInput
    : {
        artifactKind: 'skill-md' as const,
        source: String(row.sourceRef ?? ''),
        suggestedFiles: [],
      };
  const parsed: SkillPluginCandidateRow = {
    id: String(row.id),
    projectId: String(row.projectId),
    runId: typeof row.runId === 'string' ? row.runId : null,
    sourceKind: row.sourceKind as SkillPluginCandidateSourceKind,
    sourceRef: String(row.sourceRef),
    provenance: row.provenance as SkillPluginCandidateProvenance,
    confidence: Number(row.confidence),
    fingerprint: String(row.fingerprint),
    draftInput,
    status: row.status === 'dismissed' ? 'dismissed' : 'active',
    dismissedAt: typeof row.dismissedAt === 'number' ? row.dismissedAt : null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
  if (typeof row.title === 'string') parsed.title = row.title;
  if (typeof row.description === 'string') parsed.description = row.description;
  return parsed;
}

export function persistSkillPluginCandidates(
  db: SqliteDb,
  args: { projectId: string; runId?: string | null; candidates: SkillPluginCandidateInput[]; now?: number },
): SkillPluginCandidateRow[] {
  const now = args.now ?? Date.now();
  const rows: SkillPluginCandidateRow[] = [];
  const insert = db.prepare(`
    INSERT INTO skill_plugin_candidates (
      id, project_id, run_id, source_kind, source_ref, provenance, confidence,
      title, description, fingerprint, draft_input_json, status, dismissed_at,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
    ON CONFLICT(project_id, fingerprint) DO UPDATE SET
      run_id = CASE
        WHEN skill_plugin_candidates.status = 'dismissed' THEN skill_plugin_candidates.run_id
        ELSE excluded.run_id
      END,
      confidence = CASE
        WHEN skill_plugin_candidates.status = 'dismissed' THEN skill_plugin_candidates.confidence
        ELSE MAX(skill_plugin_candidates.confidence, excluded.confidence)
      END,
      source_ref = excluded.source_ref,
      provenance = excluded.provenance,
      title = excluded.title,
      description = excluded.description,
      draft_input_json = excluded.draft_input_json,
      updated_at = excluded.updated_at
  `);
  const select = db.prepare(`
    SELECT id, project_id AS projectId, run_id AS runId, source_kind AS sourceKind,
           source_ref AS sourceRef, provenance, confidence, title, description,
           fingerprint, draft_input_json AS draftInputJson, status,
           dismissed_at AS dismissedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM skill_plugin_candidates
     WHERE project_id = ? AND fingerprint = ?
  `);

  for (const candidate of args.candidates) {
    insert.run(
      `spc_${randomUUID()}`,
      args.projectId,
      args.runId ?? null,
      candidate.sourceKind,
      candidate.sourceRef,
      candidate.provenance,
      candidate.confidence,
      candidate.title ?? null,
      candidate.description ?? null,
      candidate.fingerprint,
      JSON.stringify(candidate.draftInput),
      now,
      now,
    );
    const row = select.get(args.projectId, candidate.fingerprint) as DbRow | undefined;
    if (row && row.status !== 'dismissed') rows.push(parseCandidateRow(row));
  }
  return rows;
}

export function listSkillPluginCandidates(
  db: SqliteDb,
  projectId: string,
  opts: { includeDismissed?: boolean } = {},
): SkillPluginCandidateRow[] {
  const rows = db.prepare(`
    SELECT id, project_id AS projectId, run_id AS runId, source_kind AS sourceKind,
           source_ref AS sourceRef, provenance, confidence, title, description,
           fingerprint, draft_input_json AS draftInputJson, status,
           dismissed_at AS dismissedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM skill_plugin_candidates
     WHERE project_id = ?
       ${opts.includeDismissed ? '' : `AND status != 'dismissed'`}
     ORDER BY confidence DESC, updated_at DESC
  `).all(projectId) as DbRow[];
  return rows.map(parseCandidateRow);
}

export function dismissSkillPluginCandidate(
  db: SqliteDb,
  args: { projectId: string; candidateId: string; now?: number },
): SkillPluginCandidateRow | null {
  const now = args.now ?? Date.now();
  db.prepare(`
    UPDATE skill_plugin_candidates
       SET status = 'dismissed', dismissed_at = ?, updated_at = ?
     WHERE project_id = ? AND id = ?
  `).run(now, now, args.projectId, args.candidateId);
  const row = db.prepare(`
    SELECT id, project_id AS projectId, run_id AS runId, source_kind AS sourceKind,
           source_ref AS sourceRef, provenance, confidence, title, description,
           fingerprint, draft_input_json AS draftInputJson, status,
           dismissed_at AS dismissedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM skill_plugin_candidates
     WHERE project_id = ? AND id = ?
  `).get(args.projectId, args.candidateId) as DbRow | undefined;
  return row ? parseCandidateRow(row) : null;
}

export function hasCandidateShape(value: unknown): value is SkillPluginCandidateInput {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.sourceRef === 'string' &&
    typeof value.fingerprint === 'string' &&
    typeof value.confidence === 'number' &&
    isPlainObject(value.draftInput)
  );
}
