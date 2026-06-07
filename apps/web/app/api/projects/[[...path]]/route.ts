import type { NextRequest } from 'next/server';
import type { ChatMessage, Conversation, OpenTabsState, Project, ProjectFile, ProjectMetadata } from '../../../../src/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type StoredFile = ProjectFile & { content: string };
interface Store {
  projects: Map<string, Project>;
  conversations: Map<string, Conversation[]>;
  messages: Map<string, Map<string, ChatMessage[]>>;
  tabs: Map<string, OpenTabsState>;
  files: Map<string, Map<string, StoredFile>>;
}

const g = globalThis as typeof globalThis & { __openDesignVercelStore?: Store };
const store: Store = g.__openDesignVercelStore ??= {
  projects: new Map(),
  conversations: new Map(),
  messages: new Map(),
  tabs: new Map(),
  files: new Map(),
};

function now() { return Date.now(); }
function json(data: unknown, init?: ResponseInit) { return Response.json(data, init); }
function notFound() { return json({ error: { code: 'NOT_FOUND', message: 'not found' } }, { status: 404 }); }
function badRequest(message: string) { return json({ error: { code: 'BAD_REQUEST', message } }, { status: 400 }); }

function projectFiles(projectId: string) {
  let files = store.files.get(projectId);
  if (!files) {
    files = new Map();
    store.files.set(projectId, files);
  }
  return files;
}

function projectConversations(projectId: string) {
  let list = store.conversations.get(projectId);
  if (!list) {
    list = [];
    store.conversations.set(projectId, list);
  }
  return list;
}

function projectMessages(projectId: string) {
  let map = store.messages.get(projectId);
  if (!map) {
    map = new Map();
    store.messages.set(projectId, map);
  }
  return map;
}

function fileKind(name: string): ProjectFile['kind'] {
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name)) return 'image';
  if (/\.(md|txt)$/i.test(name)) return 'text';
  if (/\.(ts|tsx|js|jsx|css|json)$/i.test(name)) return 'code';
  return 'binary';
}

function mimeFor(name: string): string {
  if (/\.html?$/i.test(name)) return 'text/html; charset=utf-8';
  if (/\.svg$/i.test(name)) return 'image/svg+xml';
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.css$/i.test(name)) return 'text/css; charset=utf-8';
  if (/\.(md|txt|ts|tsx|js|jsx)$/i.test(name)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/^\/+/, '').replace(/\.\./g, '').trim();
  return name || null;
}

async function body(req: NextRequest) {
  return (await req.json().catch(() => null)) as Record<string, unknown> | null;
}

function splitParams(params: { path?: string[] }) {
  return params.path ?? [];
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const parts = splitParams(await ctx.params);
  if (parts.length === 0) {
    return json({ projects: Array.from(store.projects.values()).sort((a, b) => b.updatedAt - a.updatedAt) });
  }

  const [projectId, section, subId, leaf, messageIdOrName, ...rest] = parts;
  if (!projectId) return notFound();
  const project = store.projects.get(projectId);
  if (!project) return notFound();

  if (!section) return json({ project });
  if (section === 'conversations') {
    if (!subId) return json({ conversations: projectConversations(projectId) });
    if (leaf === 'messages') {
      return json({ messages: projectMessages(projectId).get(subId) ?? [] });
    }
  }
  if (section === 'tabs') return json(store.tabs.get(projectId) ?? { tabs: [], active: null });
  if (section === 'files') return json({ files: Array.from(projectFiles(projectId).values()).map(({ content: _content, ...meta }) => meta) });
  if (section === 'raw') {
    const name = decodeURIComponent([subId, leaf, messageIdOrName, ...rest].filter(Boolean).join('/'));
    const file = projectFiles(projectId).get(name);
    if (!file) return notFound();
    return new Response(file.content, { headers: { 'Content-Type': file.mime } });
  }
  if (section === 'deployments') return json({ deployments: [] });
  return notFound();
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const parts = splitParams(await ctx.params);
  const data = await body(req) ?? {};
  if (parts.length === 0) {
    const id = typeof data.id === 'string' ? data.id : crypto.randomUUID();
    const timestamp = now();
    const project: Project = {
      id,
      name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Untitled project',
      skillId: typeof data.skillId === 'string' ? data.skillId : null,
      designSystemId: typeof data.designSystemId === 'string' ? data.designSystemId : null,
      pendingPrompt: typeof data.pendingPrompt === 'string' ? data.pendingPrompt : undefined,
      metadata: data.metadata as ProjectMetadata | undefined,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    store.projects.set(id, project);
    const conversationId = crypto.randomUUID();
    projectConversations(id).push({ id: conversationId, projectId: id, title: null, createdAt: timestamp, updatedAt: timestamp });
    return json({ project, conversationId });
  }

  const [projectId, section] = parts;
  if (!projectId || !store.projects.has(projectId)) return notFound();
  if (section === 'conversations') {
    const timestamp = now();
    const conversation: Conversation = { id: crypto.randomUUID(), projectId, title: typeof data.title === 'string' ? data.title : null, createdAt: timestamp, updatedAt: timestamp };
    projectConversations(projectId).push(conversation);
    return json({ conversation });
  }
  if (section === 'files') {
    const name = sanitizeName(data.name);
    if (!name) return badRequest('name is required');
    const content = typeof data.content === 'string' ? data.content : '';
    const timestamp = now();
    const file: StoredFile = {
      name,
      path: name,
      type: 'file',
      size: new TextEncoder().encode(content).byteLength,
      mtime: timestamp,
      kind: fileKind(name),
      mime: mimeFor(name),
      artifactManifest: data.artifactManifest as ProjectFile['artifactManifest'],
      content,
    };
    projectFiles(projectId).set(name, file);
    const { content: _content, ...meta } = file;
    return json({ file: meta });
  }
  if (section === 'upload') return badRequest('uploads are not available in Vercel memory mode yet');
  if (section === 'deploy') return badRequest('deploy is not available in Vercel memory mode yet');
  return notFound();
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const parts = splitParams(await ctx.params);
  const data = await body(req) ?? {};
  const [projectId, section, conversationId] = parts;
  if (!projectId) return notFound();
  if (!section) {
    const project = store.projects.get(projectId);
    if (!project) return notFound();
    const updated: Project = { ...project, ...data, updatedAt: now() } as Project;
    if (data.pendingPrompt === null) delete updated.pendingPrompt;
    if (data.metadata === null) delete updated.metadata;
    store.projects.set(projectId, updated);
    return json({ project: updated });
  }
  if (section === 'conversations' && conversationId) {
    const list = projectConversations(projectId);
    const conversation = list.find((c) => c.id === conversationId);
    if (!conversation) return notFound();
    conversation.title = typeof data.title === 'string' ? data.title : null;
    conversation.updatedAt = now();
    return json({ conversation });
  }
  return notFound();
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const parts = splitParams(await ctx.params);
  const data = await body(req) ?? {};
  const [projectId, section, conversationId, leaf, messageId] = parts;
  if (!projectId || !store.projects.has(projectId)) return notFound();
  if (section === 'tabs') {
    const state = { tabs: Array.isArray(data.tabs) ? data.tabs.filter((v): v is string => typeof v === 'string') : [], active: typeof data.active === 'string' ? data.active : null };
    store.tabs.set(projectId, state);
    return json(state);
  }
  if (section === 'conversations' && conversationId && leaf === 'messages' && messageId) {
    const messagesByConversation = projectMessages(projectId);
    const list = messagesByConversation.get(conversationId) ?? [];
    const next = list.filter((m) => m.id !== messageId).concat(data as unknown as ChatMessage).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    messagesByConversation.set(conversationId, next);
    return json({ ok: true });
  }
  return notFound();
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const parts = splitParams(await ctx.params);
  const [projectId, section, conversationId, leaf, ...rest] = parts;
  if (!projectId) return notFound();
  if (!section) {
    store.projects.delete(projectId);
    store.conversations.delete(projectId);
    store.messages.delete(projectId);
    store.tabs.delete(projectId);
    store.files.delete(projectId);
    return json({ ok: true });
  }
  if (section === 'conversations' && conversationId) {
    store.conversations.set(projectId, projectConversations(projectId).filter((c) => c.id !== conversationId));
    projectMessages(projectId).delete(conversationId);
    return json({ ok: true });
  }
  if (section === 'raw') {
    const name = decodeURIComponent([conversationId, leaf, ...rest].filter(Boolean).join('/'));
    projectFiles(projectId).delete(name);
    return json({ ok: true });
  }
  return notFound();
}
