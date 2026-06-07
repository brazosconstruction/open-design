export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return ctx.params.then(() => Response.json({ error: { code: 'NOT_FOUND', message: 'template not found' } }, { status: 404 }));
}

export function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return ctx.params.then(() => Response.json({ ok: true }));
}
