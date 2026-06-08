import { del as vercelDel, get as vercelGet, list as vercelList, put as vercelPut } from '@vercel/blob';

import type { ChatMessage, Conversation, OpenTabsState, ProjectFile } from '../../types';
import { createStoredBlobFile, createStoredFile } from './memory';
import type { CreateProjectInput, ProjectState, ProjectsStorage, PutBlobFileInput, PutTextFileInput, RawFileResponse, StoredFile } from './types';

type BlobListResult = { blobs: Array<{ pathname: string; url?: string; downloadUrl?: string }> };

export interface BlobProjectsClient {
  put(pathname: string, body: string, options?: Record<string, unknown>): Promise<{ pathname?: string; url?: string }>;
  del(pathnames: string | string[]): Promise<unknown>;
  list(options?: { prefix?: string }): Promise<BlobListResult>;
  fetchByPathname(pathname: string): Promise<Response | null>;
}

const PREFIX = 'open-design/projects';

function statePath(projectId: string) {
  return `${PREFIX}/${encodeURIComponent(projectId)}/state.json`;
}

function filesPrefix(projectId: string) {
  return `${PREFIX}/${encodeURIComponent(projectId)}/files/`;
}

function fileBlobPath(projectId: string, name: string) {
  return `${filesPrefix(projectId)}${encodeURIComponent(name)}`;
}

function cloneWithoutContent(file: StoredFile): StoredFile {
  const { content: _content, ...rest } = file;
  return rest;
}

function now() { return Date.now(); }

function createInitialState(input: CreateProjectInput): { state: ProjectState; conversationId: string } {
  const id = typeof input.id === 'string' && input.id.trim() ? input.id : crypto.randomUUID();
  const timestamp = now();
  const project = {
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

function normalizeState(value: ProjectState): ProjectState {
  return {
    project: value.project,
    conversations: Array.isArray(value.conversations) ? value.conversations : [],
    messages: value.messages && typeof value.messages === 'object' ? value.messages : {},
    tabs: value.tabs && typeof value.tabs === 'object' ? value.tabs : { tabs: [], active: null },
    files: value.files && typeof value.files === 'object' ? value.files : {},
  };
}

async function readJsonResponse<T>(response: Response | null): Promise<T | null> {
  if (!response || !response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

export function createDefaultBlobProjectsClient(): BlobProjectsClient {
  async function findBlob(pathname: string) {
    const result = await vercelList({ prefix: pathname, limit: 1 });
    return result.blobs.find((blob) => blob.pathname === pathname) ?? null;
  }

  return {
    async put(pathname, body) {
      return vercelPut(pathname, body, { access: 'private', addRandomSuffix: false, allowOverwrite: true });
    },
    async del(pathnames) {
      return vercelDel(pathnames);
    },
    async list(options) {
      return vercelList(options);
    },
    async fetchByPathname(pathname) {
      const result = await vercelGet(pathname, { access: 'private', useCache: false });
      if (!result || result.statusCode !== 200) return null;
      return new Response(result.stream, { headers: result.headers });
    },
  };
}

export function createBlobProjectsStorage(client: BlobProjectsClient = createDefaultBlobProjectsClient()): ProjectsStorage {
  async function load(projectId: string): Promise<ProjectState | null> {
    const state = await readJsonResponse<ProjectState>(await client.fetchByPathname(statePath(projectId)));
    return state ? normalizeState(state) : null;
  }

  async function save(state: ProjectState) {
    const serialized: ProjectState = {
      ...state,
      files: Object.fromEntries(Object.entries(state.files).map(([path, file]) => [path, cloneWithoutContent(file)])),
    };
    await client.put(statePath(state.project.id), JSON.stringify(serialized), { contentType: 'application/json' });
  }

  async function listStatePathnames() {
    const result = await client.list({ prefix: `${PREFIX}/` });
    return result.blobs.map((blob) => blob.pathname).filter((pathname) => pathname.endsWith('/state.json'));
  }

  return {
    kind: 'vercel-blob',
    durable: true,
    async listProjects() {
      const paths = await listStatePathnames();
      const states = await Promise.all(paths.map(async (path) => readJsonResponse<ProjectState>(await client.fetchByPathname(path))));
      return states.filter((state): state is ProjectState => Boolean(state?.project)).map((state) => state.project).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async getProject(projectId) {
      return (await load(projectId))?.project ?? null;
    },
    async createProject(input) {
      const created = createInitialState(input);
      await save(created.state);
      return { project: created.state.project, conversationId: created.conversationId };
    },
    async patchProject(projectId, patch) {
      const state = await load(projectId);
      if (!state) return null;
      const updated = { ...state.project, ...patch, updatedAt: now() };
      if (patch.pendingPrompt === null) delete updated.pendingPrompt;
      if (patch.metadata === null) delete updated.metadata;
      state.project = updated;
      await save(state);
      return updated;
    },
    async deleteProject(projectId) {
      const state = await load(projectId);
      if (!state) return false;
      const files = await client.list({ prefix: filesPrefix(projectId) });
      const pathnames = files.blobs.map((blob) => blob.pathname).concat(statePath(projectId));
      if (pathnames.length > 0) await client.del(pathnames);
      return true;
    },
    async listConversations(projectId) {
      return (await load(projectId))?.conversations ?? [];
    },
    async createConversation(projectId, title = null) {
      const state = await load(projectId);
      if (!state) return null;
      const timestamp = now();
      const conversation: Conversation = { id: crypto.randomUUID(), projectId, title: typeof title === 'string' ? title : null, createdAt: timestamp, updatedAt: timestamp };
      state.conversations.push(conversation);
      await save(state);
      return conversation;
    },
    async patchConversation(projectId, conversationId, patch) {
      const state = await load(projectId);
      const conversation = state?.conversations.find((item) => item.id === conversationId);
      if (!state || !conversation) return null;
      conversation.title = typeof patch.title === 'string' ? patch.title : null;
      conversation.updatedAt = now();
      await save(state);
      return conversation;
    },
    async deleteConversation(projectId, conversationId) {
      const state = await load(projectId);
      if (!state) return false;
      const before = state.conversations.length;
      state.conversations = state.conversations.filter((item) => item.id !== conversationId);
      delete state.messages[conversationId];
      await save(state);
      return state.conversations.length !== before;
    },
    async listMessages(projectId, conversationId) {
      return (await load(projectId))?.messages[conversationId] ?? [];
    },
    async upsertMessage(projectId, conversationId, message) {
      const state = await load(projectId);
      if (!state) return;
      const list = state.messages[conversationId] ?? [];
      state.messages[conversationId] = list.filter((item) => item.id !== message.id).concat(message).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      await save(state);
    },
    async getTabs(projectId) {
      return (await load(projectId))?.tabs ?? { tabs: [], active: null };
    },
    async putTabs(projectId, tabs) {
      const state = await load(projectId);
      if (!state) return tabs;
      state.tabs = tabs;
      await save(state);
      return tabs;
    },
    async listFiles(projectId) {
      const files = (await load(projectId))?.files ?? {};
      return Object.values(files).map(({ content: _content, blobPathname: _blobPathname, ...file }) => file);
    },
    async putTextFile(projectId, input: PutTextFileInput) {
      const state = await load(projectId);
      const file = createStoredFile(input);
      if (!state || !file) return null;
      const pathname = fileBlobPath(projectId, file.path ?? file.name);
      await client.put(pathname, input.content, { contentType: file.mime });
      const stored = { ...file, content: undefined, blobPathname: pathname };
      state.files[file.path ?? file.name] = stored;
      await save(state);
      const { content: _content, blobPathname: _blobPathname, ...meta } = stored;
      return meta;
    },
    async putBlobFile(projectId, input: PutBlobFileInput) {
      const state = await load(projectId);
      const file = createStoredBlobFile(input);
      if (!state || !file) return null;
      state.files[file.path ?? file.name] = file;
      await save(state);
      const { content: _content, blobPathname: _blobPathname, ...meta } = file;
      return meta;
    },
    async getRawFile(projectId, path): Promise<RawFileResponse | null> {
      const file = (await load(projectId))?.files[path];
      if (!file) return null;
      const response = await client.fetchByPathname(file.blobPathname ?? fileBlobPath(projectId, path));
      if (!response || !response.ok) return null;
      return { response, mime: file.mime };
    },
    async deleteRawFile(projectId, path) {
      const state = await load(projectId);
      const file = state?.files[path];
      if (!state || !file) return false;
      await client.del(file.blobPathname ?? fileBlobPath(projectId, path));
      delete state.files[path];
      await save(state);
      return true;
    },
  };
}
