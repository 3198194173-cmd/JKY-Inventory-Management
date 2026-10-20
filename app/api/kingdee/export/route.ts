import { currentOwner, errorResponse } from '@/lib/auth';
import { kingdeeExportData } from '@/lib/kingdee-store';
import { kingdeeWorkbook } from '@/lib/kingdee-export';
export async function GET(request: Request) {
  try {
    const { batch, rows } = kingdeeExportData(await currentOwner(), new URL(request.url).searchParams.get('batch') || '');
    const bytes = kingdeeWorkbook(batch, rows, new URL(request.url).searchParams.get('sheet') === 'original' ? 'original' : 'current');
    return new Response(bytes.buffer as ArrayBuffer, { headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="kingdee-prototype-${batch.id}.xlsx"; filename*=UTF-8''${encodeURIComponent('金蝶存销明细_雏形.xlsx')}`,
      'Cache-Control': 'private, no-store',
    } });
  } catch (error) { return errorResponse(error); }
}
