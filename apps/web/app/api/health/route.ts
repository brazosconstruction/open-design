export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ ok: true, mode: 'vercel', daemon: false });
}
