import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('new project modal layout styles', () => {
  it('keeps the form body as the remaining-height scroll region', () => {
    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    const newProjectBodyRule = css.match(/\.newproj-body\s*\{[^}]*\}/)?.[0];

    expect(newProjectBodyRule).toBeDefined();
    expect(newProjectBodyRule).toContain('flex: 1 1 auto;');
    expect(newProjectBodyRule).toContain('min-height: 0;');
    expect(newProjectBodyRule).toContain('overflow-y: auto;');
  });
});
