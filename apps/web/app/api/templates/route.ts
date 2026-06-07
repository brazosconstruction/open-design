export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ templates: [] });
}

export async function POST() {
  return Response.json({ error: { code: 'UNAVAILABLE', message: 'Templates are not available in Vercel memory mode yet' } }, { status: 400 });
}
