import { createBlobProjectsStorage } from './blob';
import { createMemoryProjectsStorage } from './memory';
import type { ProjectsStorage } from './types';

const g = globalThis as typeof globalThis & { __openDesignProjectsStorage?: ProjectsStorage };

export function getProjectsStorage(): ProjectsStorage {
  const mode = process.env.OPEN_DESIGN_STORAGE;
  if (mode === 'vercel-blob' || (mode === undefined && process.env.BLOB_READ_WRITE_TOKEN)) {
    return createBlobProjectsStorage();
  }
  return (g.__openDesignProjectsStorage ??= createMemoryProjectsStorage());
}

export function getProjectsStorageStatus() {
  const storage = getProjectsStorage();
  return { storage: storage.kind, durable: storage.durable };
}

export type { ProjectsStorage } from './types';
