import type { NextRequest } from 'next/server';

import { getProjectsStorage } from '../../../../src/server/projects-storage';
import { sanitizeName } from '../../../../src/server/projects-storage/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, init?: ResponseInit) { return Response.json(data, init); }
function notFound() { return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 }); }
function badRequest(message: string) { return json({ error: { code: 'BAD_REQUEST', message } }, { status: 400 }); }

async function body(req: NextRequest) {
  return (await req.json().catch(() => null)) as Record<string, unknown> | null;
}

function splitParams(params: { path?: string[] }) {
  return params.path ?? [];
}

function rawName(parts: Array<string | undefined>) {
  return decodeURIComponent(parts.filter(Boolean).join('/'));
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const storage = getProjectsStorage();
  const parts = splitParams(await ctx.params);
  if (parts.length === 0) return json({ projects: await storage.listProjects() });

  const [projectId, section, subId, leaf, messageIdOrName, ...rest] = parts;
  if (!projectId) return notFound();
  const project = await storage.getProject(projectId);
  if (!project) return notFound();

  if (!section) return json({ project });
  if (section === 'conversations') {
    if (!subId) return json({ conversations: await storage.listConversations(projectId) });
    if (leaf === 'messages') return json({ messages: await storage.listMessages(projectId, subId) });
  }
  if (section === 'tabs') return json(await storage.getTabs(projectId));
  if (section === 'files') return json({ files: await storage.listFiles(projectId) });
  if (section === 'raw') {
    const file = await storage.getRawFile(projectId, rawName([subId, leaf, messageIdOrName, ...rest]));
    if (!file) return notFound();
    return new Response(file.response.body, { headers: { 'Content-Type': file.mime } });
  }
  if (section === 'deployments') return json({ deployments: [] });
  return notFound();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const storage = getProjectsStorage();
  const parts = splitParams(await ctx.params);
  const data = await body(req) ?? {};
  if (parts.length === 0) return json(await storage.createProject(data));

  const [projectId, section] = parts;
  if (!projectId || !(await storage.getProject(projectId))) return notFound();
  if (section === 'conversations') {
    const conversation = await storage.createConversation(projectId, typeof data.title === 'string' ? data.title : null);
    return conversation ? json({ conversation }) : notFound();
  }
  if (section === 'files') {
    const name = sanitizeName(data.name);
    if (!name) return badRequest('name is required');
    const file = await storage.putTextFile(projectId, {
      name,
      content: typeof data.content === 'string' ? data.content : '',
      artifactManifest: data.artifactManifest as never,
    });
    return file ? json({ file }) : notFound();
  }
  if (section === 'upload') return badRequest('uploads are not available in Vercel storage mode yet');
  if (section === 'deploy') return badRequest('deploy is not available in Vercel storage mode yet');
  return notFound();
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const storage = getProjectsStorage();
  const parts = splitParams(await ctx.params);
  const data = await body(req) ?? {};
  const [projectId, section, conversationId] = parts;
  if (!projectId) return notFound();
  if (!section) {
    const project = await storage.patchProject(projectId, data);
    return project ? json({ project }) : notFound();
  }
  if (section === 'conversations' && conversationId) {
    const conversation = await storage.patchConversation(projectId, conversationId, data);
    return conversation ? json({ conversation }) : notFound();
  }
  return notFound();
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const storage = getProjectsStorage();
  const parts = splitParams(await ctx.params);
  const data = await body(req) ?? {};
  const [projectId, section, conversationId, leaf, messageId] = parts;
  if (!projectId || !(await storage.getProject(projectId))) return notFound();
  if (section === 'tabs') return json(await storage.putTabs(projectId, {
    tabs: Array.isArray(data.tabs) ? data.tabs.filter((value): value is string => typeof value === 'string') : [],
    active: typeof data.active === 'string' ? data.active : null,
    browserTabs: Array.isArray(data.browserTabs) ? data.browserTabs as never : undefined,
    hasSavedState: data.hasSavedState === true ? true : undefined,
    updatedAt: typeof data.updatedAt === 'number' && Number.isFinite(data.updatedAt) ? data.updatedAt : undefined,
  }));
  if (section === 'conversations' && conversationId && leaf === 'messages' && messageId) {
    await storage.upsertMessage(projectId, conversationId, data as never);
    return json({ ok: true });
  }
  return notFound();
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const storage = getProjectsStorage();
  const parts = splitParams(await ctx.params);
  const [projectId, section, conversationId, leaf, ...rest] = parts;
  if (!projectId) return notFound();
  if (!section) {
    await storage.deleteProject(projectId);
    return json({ ok: true });
  }
  if (section === 'conversations' && conversationId) {
    await storage.deleteConversation(projectId, conversationId);
    return json({ ok: true });
  }
  if (section === 'raw') {
    await storage.deleteRawFile(projectId, rawName([conversationId, leaf, ...rest]));
    return json({ ok: true });
  }
  return notFound();
}
