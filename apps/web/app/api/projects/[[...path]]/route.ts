import type { NextRequest } from 'next/server';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';

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

function filesPrefix(projectId: string) {
  return `open-design/projects/${encodeURIComponent(projectId)}/files/`;
}

function normalizeRegisteredFiles(value: unknown) {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { files?: unknown }).files)) return [];
  return (value as { files: unknown[] }).files
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => item !== null);
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
  if (parts.length === 0) return json(await storage.createProject(await body(req) ?? {}));

  const [projectId, section] = parts;
  if (!projectId || !(await storage.getProject(projectId))) return notFound();
  if (section === 'upload-token') {
    const uploadBody = (await req.json().catch(() => null)) as HandleUploadBody | null;
    if (!uploadBody) return badRequest('upload token request is invalid');
    const prefix = filesPrefix(projectId);
    const result = await handleUpload({
      request: req,
      body: uploadBody,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(prefix)) throw new Error('upload pathname is outside this project');
        const relativePath = pathname.slice(prefix.length);
        if (!sanitizeName(decodeURIComponent(relativePath))) throw new Error('upload pathname is invalid');
        return {
          maximumSizeInBytes: 250 * 1024 * 1024,
          validUntil: Date.now() + 10 * 60 * 1000,
          addRandomSuffix: false,
          allowOverwrite: true,
        };
      },
    });
    return json(result);
  }
  const data = await body(req) ?? {};
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
  if (section === 'uploaded') {
    const prefix = filesPrefix(projectId);
    const files = await Promise.all(normalizeRegisteredFiles(data).map(async (item) => {
      const path = sanitizeName(item.path);
      const blobPathname = sanitizeName(item.blobPathname);
      if (!path || !blobPathname || !blobPathname.startsWith(prefix)) return null;
      return storage.putBlobFile(projectId, {
        name: typeof item.name === 'string' && item.name.trim() ? item.name : path.split('/').pop() ?? path,
        path,
        size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : undefined,
        mime: typeof item.mime === 'string' ? item.mime : undefined,
        blobPathname,
      });
    }));
    return json({ files: files.filter(Boolean) });
  }
  if (section === 'upload') return badRequest('uploads must use direct blob upload in Vercel storage mode');
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
