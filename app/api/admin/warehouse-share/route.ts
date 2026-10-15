import { assertSameOrigin, errorResponse, requireAdmin } from '@/lib/auth';
import { shareWarehouses, warehouseShareOptions } from '@/lib/warehouse-sharing';
import { AccessError } from '@/lib/accounts';
export async function GET(){
  try{return Response.json(warehouseShareOptions(await requireAdmin()),{headers:{'Cache-Control':'no-store'}});}catch(e){return errorResponse(e);}
}
export async function POST(request:Request){
  try{assertSameOrigin(request);const actor=await requireAdmin(),body=await request.json();if(!body||typeof body!=='object'||Array.isArray(body))throw new AccessError('请求格式无效',400);return Response.json(await shareWarehouses(actor,body),{headers:{'Cache-Control':'no-store'}});}catch(e){return errorResponse(e);}
}
