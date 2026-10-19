import { currentOwner, errorResponse } from '@/lib/auth';
import { availableWarehouses } from '@/lib/warehouse-discovery';
import { assertOwnerActive } from '@/lib/accounts';

export async function GET(request: Request) {
  try {
    const owner = await currentOwner(request);
    assertOwnerActive(owner);
    const warehouses = await availableWarehouses(new URL(request.url).searchParams.get('refresh') === '1');
    assertOwnerActive(owner);
    return Response.json({ warehouses }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
