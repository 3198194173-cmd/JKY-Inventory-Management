import { sqlite } from '@/lib/sqlite.mjs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { sqlite().prepare('SELECT 1').get(); return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}}); }
  catch { return Response.json({ok:false},{status:503}); }
}
