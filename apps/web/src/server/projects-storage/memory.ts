import type { ChatMessage, Conversation, OpenTabsState, Project, ProjectFile } from '../../types';
import type { CreateProjectInput, ProjectState, ProjectsStorage, PutBlobFileInput, PutTextFileInput, RawFileResponse, StoredFile } from './types';

function now() { return Date.now(); }

export function fileKind(name: string): ProjectFile['kind'] {
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name)) return 'image';
  if (/\.(md|txt)$/i.test(name)) return 'text';
  if (/\.(ts|tsx|js|jsx|css|json)$/i.test(name)) return 'code';
  return 'binary';
}

export function mimeFor(name: string): string {
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

export function sanitizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/^\/+/, '').replace(/\.\./g, '').trim();
  return name || null;
}

export function createStoredFile(input: PutTextFileInput): StoredFile | null {
  const name = sanitizeName(input.name);
  if (!name) return null;
  const timestamp = now();
  return {
    name,
    path: name,
    type: 'file',
    size: new TextEncoder().encode(input.content).byteLength,
    mtime: timestamp,
    kind: fileKind(name),
    mime: mimeFor(name),
    artifactManifest: input.artifactManifest,
    content: input.content,
  };
}

export function createStoredBlobFile(input: PutBlobFileInput): StoredFile | null {
  const name = sanitizeName(input.name);
  const path = sanitizeName(input.path ?? input.name);
  const blobPathname = sanitizeName(input.blobPathname);
  if (!name || !path || !blobPathname) return null;
  const timestamp = now();
  return {
    name,
    path,
    type: 'file',
    size: typeof input.size === 'number' && Number.isFinite(input.size) ? input.size : 0,
    mtime: timestamp,
    kind: fileKind(path),
    mime: typeof input.mime === 'string' && input.mime.trim() ? input.mime.trim() : mimeFor(path),
    blobPathname,
  };
}

function createInitialState(input: CreateProjectInput): { state: ProjectState; conversationId: string } {
  const id = typeof input.id === 'string' && input.id.trim() ? input.id : crypto.randomUUID();
  const timestamp = now();
  const project: Project = {
    id,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Untitled project',
    skillId: typeof input.skillId === 'string' ? input.skillId : null,
    designSystemId: typeof input.designSystemId === 'string' ? input.designSystemId : null,
    pendingPrompt: typeof input.pendingPrompt === 'string' ? input.pendingPrompt : undefined,
    metadata: input.metadata,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const conversationId = crypto.randomUUID();
  return {
    conversationId,
    state: {
      project,
      conversations: [{ id: conversationId, projectId: id, title: null, createdAt: timestamp, updatedAt: timestamp }],
      messages: {},
      tabs: { tabs: [], active: null },
      files: {},
    },
  };
}

export function createMemoryProjectsStorage(): ProjectsStorage {
  const states = new Map<string, ProjectState>();

  function state(projectId: string) {
    return states.get(projectId) ?? null;
  }

  return {
    kind: 'memory',
    durable: false,
    async listProjects() {
      return Array.from(states.values()).map((entry) => entry.project).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async getProject(projectId) {
      return state(projectId)?.project ?? null;
    },
    async createProject(input) {
      const created = createInitialState(input);
      states.set(created.state.project.id, created.state);
      return { project: created.state.project, conversationId: created.conversationId };
    },
    async patchProject(projectId, patch) {
      const entry = state(projectId);
      if (!entry) return null;
      const updated = { ...entry.project, ...patch, updatedAt: now() } as Project;
      if (patch.pendingPrompt === null) delete updated.pendingPrompt;
      if (patch.metadata === null) delete updated.metadata;
      entry.project = updated;
      return updated;
    },
    async deleteProject(projectId) {
      return states.delete(projectId);
    },
    async listConversations(projectId) {
      return state(projectId)?.conversations ?? [];
    },
    async createConversation(projectId, title = null) {
      const entry = state(projectId);
      if (!entry) return null;
      const timestamp = now();
      const conversation: Conversation = { id: crypto.randomUUID(), projectId, title: typeof title === 'string' ? title : null, createdAt: timestamp, updatedAt: timestamp };
      entry.conversations.push(conversation);
      return conversation;
    },
    async patchConversation(projectId, conversationId, patch) {
      const conversation = state(projectId)?.conversations.find((item) => item.id === conversationId);
      if (!conversation) return null;
      conversation.title = typeof patch.title === 'string' ? patch.title : null;
      conversation.updatedAt = now();
      return conversation;
    },
    async deleteConversation(projectId, conversationId) {
      const entry = state(projectId);
      if (!entry) return false;
      const before = entry.conversations.length;
      entry.conversations = entry.conversations.filter((item) => item.id !== conversationId);
      delete entry.messages[conversationId];
      return entry.conversations.length !== before;
    },
    async listMessages(projectId, conversationId) {
      return state(projectId)?.messages[conversationId] ?? [];
    },
    async upsertMessage(projectId, conversationId, message) {
      const entry = state(projectId);
      if (!entry) return;
      const list = entry.messages[conversationId] ?? [];
      entry.messages[conversationId] = list.filter((item) => item.id !== message.id).concat(message).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    },
    async getTabs(projectId) {
      return state(projectId)?.tabs ?? { tabs: [], active: null };
    },
    async putTabs(projectId, tabs) {
      const entry = state(projectId);
      if (!entry) return tabs;
      entry.tabs = tabs;
      return tabs;
    },
    async listFiles(projectId) {
      return Object.values(state(projectId)?.files ?? {}).map(({ content: _content, blobPathname: _blobPathname, ...file }) => file);
    },
    async putTextFile(projectId, input) {
      const entry = state(projectId);
      const file = createStoredFile(input);
      if (!entry || !file) return null;
      entry.files[file.path ?? file.name] = file;
      const { content: _content, blobPathname: _blobPathname, ...meta } = file;
      return meta;
    },
    async putBlobFile(projectId, input) {
      const entry = state(projectId);
      const file = createStoredBlobFile(input);
      if (!entry || !file) return null;
      entry.files[file.path ?? file.name] = file;
      const { content: _content, blobPathname: _blobPathname, ...meta } = file;
      return meta;
    },
    async getRawFile(projectId, path) {
      const file = state(projectId)?.files[path];
      if (!file || typeof file.content !== 'string') return null;
      return { response: new Response(file.content, { headers: { 'Content-Type': file.mime } }), mime: file.mime } satisfies RawFileResponse;
    },
    async deleteRawFile(projectId, path) {
      const entry = state(projectId);
      if (!entry || !entry.files[path]) return false;
      delete entry.files[path];
      return true;
    },
  };
}
