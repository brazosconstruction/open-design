import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectSkillPluginCandidates,
  dismissSkillPluginCandidate,
  listSkillPluginCandidates,
  persistSkillPluginCandidates,
} from '../src/plugins/candidates.js';
import { migratePlugins } from '../src/plugins/persistence.js';

let db: Database.Database;
let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'od-plugin-candidates-'));
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, title TEXT);
  `);
  migratePlugins(db);
  db.prepare(`INSERT INTO projects (id, name) VALUES ('project-a', 'Project A'), ('project-b', 'Project B')`).run();
});

afterEach(async () => {
  db.close();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('skill plugin candidate detection', () => {
  it('detects explicit SKILL.md attachments with draft-generation data', async () => {
    await writeFile(
      path.join(tmpRoot, 'SKILL.md'),
      `---\nname: launch-brief\ndescription: Reusable launch brief workflow.\n---\n# Launch Brief\n\nUse this skill when preparing launch copy.\n`,
      'utf8',
    );

    const candidates = await detectSkillPluginCandidates({
      projectRoot: tmpRoot,
      attachments: ['SKILL.md'],
      message: 'Use the uploaded skill.',
    });

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate).toMatchObject({
      sourceKind: 'project-file',
      sourceRef: 'SKILL.md',
      provenance: 'uploaded-skill-md',
      title: 'launch-brief',
      description: 'Reusable launch brief workflow.',
      draftInput: {
        artifactKind: 'skill-md',
        suggestedFiles: ['SKILL.md', 'open-design.json'],
      },
    });
    expect(candidate.confidence).toBeGreaterThan(0.9);
    expect(candidate.draftInput.contentExcerpt).toContain('Use this skill');
  });

  it('detects clearly reusable markdown skill docs and plugin-like repo links', async () => {
    await mkdir(path.join(tmpRoot, 'docs'), { recursive: true });
    await writeFile(
      path.join(tmpRoot, 'docs', 'research-agent.md'),
      `# Research Agent\n\nReusable skill workflow.\n\n## Trigger\nUse when turning source notes into an evidence-backed brief.\n\n## Tools\nUse search and citation tools.\n`,
      'utf8',
    );

    const candidates = await detectSkillPluginCandidates({
      projectRoot: tmpRoot,
      message: 'Please use docs/research-agent.md and https://github.com/nexu-io/open-design/blob/main/plugins/foo/open-design.json',
    });

    expect(candidates.map((candidate) => candidate.provenance).sort()).toEqual([
      'markdown-skill-doc',
      'plugin-like-link',
    ]);
    expect(candidates.find((candidate) => candidate.sourceRef === 'docs/research-agent.md')?.title)
      .toBe('Research Agent');
    expect(candidates.find((candidate) => candidate.sourceKind === 'repo-link')?.draftInput.artifactKind)
      .toBe('repo-plugin');
  });

  it('does not treat generic prompt heading blocks as candidates', async () => {
    const candidates = await detectSkillPluginCandidates({
      projectRoot: tmpRoot,
      message: `# Instructions\n\n## Workflow\nDo the thing.\n\n## Steps\n1. Read.\n2. Write.\n\n## Constraints\nBe concise.\n\n## Examples\nExample output.`,
    });

    expect(candidates).toEqual([]);
  });
});

describe('skill plugin candidate persistence', () => {
  it('persists candidates, hides dismissed candidates, and scopes dismissal to the project', async () => {
    const [candidate] = await detectSkillPluginCandidates({
      projectRoot: tmpRoot,
      message: 'https://github.com/nexu-io/open-design/blob/main/skills/foo/SKILL.md',
    });
    expect(candidate).toBeTruthy();
    const detectedCandidate = candidate!;

    const [projectA] = persistSkillPluginCandidates(db, {
      projectId: 'project-a',
      runId: 'run-1',
      candidates: [detectedCandidate],
      now: 100,
    });
    const [projectB] = persistSkillPluginCandidates(db, {
      projectId: 'project-b',
      runId: 'run-2',
      candidates: [detectedCandidate],
      now: 100,
    });
    expect(projectA).toBeTruthy();
    expect(projectB).toBeTruthy();
    const persistedProjectA = projectA!;
    const persistedProjectB = projectB!;

    expect(persistedProjectA.projectId).toBe('project-a');
    expect(persistedProjectB.projectId).toBe('project-b');
    expect(listSkillPluginCandidates(db, 'project-a')).toHaveLength(1);

    const dismissed = dismissSkillPluginCandidate(db, {
      projectId: 'project-a',
      candidateId: persistedProjectA.id,
      now: 200,
    });

    expect(dismissed?.status).toBe('dismissed');
    expect(listSkillPluginCandidates(db, 'project-a')).toEqual([]);
    expect(listSkillPluginCandidates(db, 'project-a', { includeDismissed: true })).toHaveLength(1);
    expect(listSkillPluginCandidates(db, 'project-b')).toHaveLength(1);

    persistSkillPluginCandidates(db, {
      projectId: 'project-a',
      runId: 'run-3',
      candidates: [detectedCandidate],
      now: 300,
    });

    expect(listSkillPluginCandidates(db, 'project-a')).toEqual([]);
  });

  it('keeps an edited source dismissed without creating duplicate rows', async () => {
    const skillPath = path.join(tmpRoot, 'SKILL.md');
    await writeFile(
      skillPath,
      `---\nname: original-skill\ndescription: Original reusable workflow.\n---\n# Original Skill\n\nUse this skill when drafting copy.\n`,
      'utf8',
    );

    const [firstCandidate] = await detectSkillPluginCandidates({
      projectRoot: tmpRoot,
      attachments: ['SKILL.md'],
    });
    expect(firstCandidate).toBeTruthy();

    const [persisted] = persistSkillPluginCandidates(db, {
      projectId: 'project-a',
      runId: 'run-1',
      candidates: [firstCandidate!],
      now: 100,
    });
    expect(persisted).toBeTruthy();

    dismissSkillPluginCandidate(db, {
      projectId: 'project-a',
      candidateId: persisted!.id,
      now: 200,
    });

    await writeFile(
      skillPath,
      `---\nname: edited-skill\ndescription: Edited reusable workflow.\n---\n# Edited Skill\n\nUse this skill when revising launch copy.\n`,
      'utf8',
    );

    const [editedCandidate] = await detectSkillPluginCandidates({
      projectRoot: tmpRoot,
      attachments: ['SKILL.md'],
    });
    expect(editedCandidate).toBeTruthy();
    expect(editedCandidate!.fingerprint).toBe(firstCandidate!.fingerprint);

    const activeRows = persistSkillPluginCandidates(db, {
      projectId: 'project-a',
      runId: 'run-2',
      candidates: [editedCandidate!],
      now: 300,
    });

    expect(activeRows).toEqual([]);
    expect(listSkillPluginCandidates(db, 'project-a')).toEqual([]);
    expect(listSkillPluginCandidates(db, 'project-a', { includeDismissed: true })).toMatchObject([
      {
        id: persisted!.id,
        status: 'dismissed',
        title: 'edited-skill',
        description: 'Edited reusable workflow.',
        fingerprint: firstCandidate!.fingerprint,
      },
    ]);
  });
});
