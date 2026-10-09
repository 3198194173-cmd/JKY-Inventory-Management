import { currentOwner,errorResponse } from '@/lib/auth';
import { loadTransitHistory } from '@/lib/transit-store';
export async function GET(request:Request){
  try{const p=new URL(request.url).searchParams;return Response.json(loadTransitHistory(await currentOwner(),p.get('warehouseCode')||'CK031',p.get('date')||'',p.get('goodsNo')||''),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return errorResponse(error);}
}
