import { currentOwner,errorResponse } from "@/lib/auth";
import { allRows } from "@/lib/inventory-store";
import { inventoryWorkbook } from "@/lib/excel";

export async function GET(request:Request) {
  try {
    const {view,rows}=await allRows(await currentOwner(),new URL(request.url).searchParams.get("warehouseCode")||"CK031");
    const bytes=inventoryWorkbook(view,rows);
    return new Response(bytes.buffer as ArrayBuffer,{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="${view.warehouseCode}_${view.snapshot?.date}.xlsx"`,"Cache-Control":"private, no-store"}});
  } catch(error) { return errorResponse(error); }
}
