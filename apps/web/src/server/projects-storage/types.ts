import type { ChatMessage, Conversation, OpenTabsState, Project, ProjectFile, ProjectMetadata } from '../../types';

export type StoredFile = ProjectFile & { content?: string; blobPathname?: string };

export interface CreateProjectInput {
  id?: string;
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string;
  metadata?: ProjectMetadata;
}

export interface PutTextFileInput {
  name: string;
  content: string;
  artifactManifest?: ProjectFile['artifactManifest'];
}

export interface PutBlobFileInput {
  name: string;
  path?: string;
  size?: number;
  mime?: string;
  blobPathname: string;
}

export interface RawFileResponse {
  response: Response;
  mime: string;
}

export interface ProjectsStorage {
  readonly kind: string;
  readonly durable: boolean;
  listProjects(): Promise<Project[]>;
  getProject(projectId: string): Promise<Project | null>;
  createProject(input: CreateProjectInput): Promise<{ project: Project; conversationId: string }>;
  patchProject(projectId: string, patch: Record<string, unknown>): Promise<Project | null>;
  deleteProject(projectId: string): Promise<boolean>;
  listConversations(projectId: string): Promise<Conversation[]>;
  createConversation(projectId: string, title?: string | null): Promise<Conversation | null>;
  patchConversation(projectId: string, conversationId: string, patch: Record<string, unknown>): Promise<Conversation | null>;
  deleteConversation(projectId: string, conversationId: string): Promise<boolean>;
  listMessages(projectId: string, conversationId: string): Promise<ChatMessage[]>;
  upsertMessage(projectId: string, conversationId: string, message: ChatMessage): Promise<void>;
  getTabs(projectId: string): Promise<OpenTabsState>;
  putTabs(projectId: string, state: OpenTabsState): Promise<OpenTabsState>;
  listFiles(projectId: string): Promise<ProjectFile[]>;
  putTextFile(projectId: string, input: PutTextFileInput): Promise<ProjectFile | null>;
  putBlobFile(projectId: string, input: PutBlobFileInput): Promise<ProjectFile | null>;
  getRawFile(projectId: string, path: string): Promise<RawFileResponse | null>;
  deleteRawFile(projectId: string, path: string): Promise<boolean>;
}

export interface ProjectState {
  project: Project;
  conversations: Conversation[];
  messages: Record<string, ChatMessage[]>;
  tabs: OpenTabsState;
  files: Record<string, StoredFile>;
}
