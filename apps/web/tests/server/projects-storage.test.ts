import { describe, expect, it } from 'vitest';

import type { ChatMessage, OpenTabsState } from '../../src/types';
import { createBlobProjectsStorage } from '../../src/server/projects-storage/blob';
import { createMemoryProjectsStorage } from '../../src/server/projects-storage/memory';

function textResponse(text: string) {
  return new Response(text, { headers: { 'content-type': 'application/json' } });
}

describe('projects storage adapters', () => {
  it('memory storage preserves full tab state and cascades project deletion', async () => {
    const storage = createMemoryProjectsStorage();
    const { project, conversationId } = await storage.createProject({ name: 'Durable Test' });
    const tabs: OpenTabsState = {
      tabs: ['index.html'],
      active: 'index.html',
      browserTabs: [{ id: 'browser-1', label: 'Preview', url: 'https://example.com' }],
      hasSavedState: true,
      updatedAt: 123,
    };

    await storage.putTabs(project.id, tabs);
    await storage.putTextFile(project.id, { name: 'nested/index.html', content: '<h1>ok</h1>' });
    await storage.upsertMessage(project.id, conversationId, { id: 'm1', role: 'assistant', content: 'hello', startedAt: 2 } as ChatMessage);

    await expect(storage.getTabs(project.id)).resolves.toEqual(tabs);
    await expect(storage.listFiles(project.id)).resolves.toHaveLength(1);
    await expect(storage.listMessages(project.id, conversationId)).resolves.toHaveLength(1);

    await storage.deleteProject(project.id);

    await expect(storage.getProject(project.id)).resolves.toBeNull();
    await expect(storage.listConversations(project.id)).resolves.toEqual([]);
    await expect(storage.listFiles(project.id)).resolves.toEqual([]);
    await expect(storage.getRawFile(project.id, 'nested/index.html')).resolves.toBeNull();
  });

  it('blob storage persists project state through a fresh adapter instance', async () => {
    const blobs = new Map<string, string>();
    const fakeClient = {
      async put(pathname: string, body: string) {
        blobs.set(pathname, body);
        return { url: `https://blob.test/${encodeURIComponent(pathname)}`, pathname };
      },
      async del(pathnames: string | string[]) {
        for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) blobs.delete(pathname);
      },
      async list({ prefix }: { prefix?: string } = {}) {
        return {
          blobs: Array.from(blobs.keys())
            .filter((pathname) => !prefix || pathname.startsWith(prefix))
            .map((pathname) => ({ pathname, url: `https://blob.test/${encodeURIComponent(pathname)}` })),
        };
      },
      async fetchByPathname(pathname: string) {
        const body = blobs.get(pathname);
        return body === undefined ? null : textResponse(body);
      },
    };

    const storage = createBlobProjectsStorage(fakeClient);
    const { project, conversationId } = await storage.createProject({ id: 'project-1', name: 'Persistent Project' });
    await storage.putTextFile(project.id, { name: 'index.html', content: '<main>persisted</main>' });
    await storage.upsertMessage(project.id, conversationId, { id: 'm1', role: 'user', content: 'make it durable', startedAt: 1 } as ChatMessage);

    const freshStorage = createBlobProjectsStorage(fakeClient);
    await expect(freshStorage.listProjects()).resolves.toMatchObject([{ id: 'project-1', name: 'Persistent Project' }]);
    await expect(freshStorage.listMessages(project.id, conversationId)).resolves.toMatchObject([{ id: 'm1', content: 'make it durable' }]);

    const raw = await freshStorage.getRawFile(project.id, 'index.html');
    await expect(raw?.response.text()).resolves.toBe('<main>persisted</main>');
    expect(raw?.mime).toBe('text/html; charset=utf-8');
  });
});
