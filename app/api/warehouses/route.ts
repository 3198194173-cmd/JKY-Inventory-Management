import { assertSameOrigin,currentOwner,errorResponse } from '@/lib/auth';
import { addWarehouse,loadWarehouses } from '@/lib/inventory-store';
import { addDiscoveredWarehouse } from '@/lib/warehouse-discovery';
export async function GET(request:Request){try{return Response.json(await loadWarehouses(await currentOwner(request)),{headers:{'Cache-Control':'no-store'}});}catch(e){return errorResponse(e);}}
export async function POST(request:Request){try{assertSameOrigin(request);const owner=await currentOwner(request),input=await request.json() as {code?:unknown;name?:unknown;source?:unknown;initialize?:unknown};
  if(input.source==='jackyun')return Response.json(await addDiscoveredWarehouse(owner,input.code,input.initialize===true));
  return Response.json(await addWarehouse(owner,input.code,input.name));}catch(e){return errorResponse(e);}}
