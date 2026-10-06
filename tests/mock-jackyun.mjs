// Test-only preload. Never used by Docker or production entrypoints.
globalThis.fetch = async (_url, options) => {
  const params = new URLSearchParams(options.body), input = JSON.parse(params.get('bizcontent'));
  const row = {quantityId:'1',skuId:'1',skuBarcode:'TEST-BARCODE',goodsNo:'TEST-GOODS',goodsName:'测试商品',unitName:'Pcs',ownerName:'测试货主',warehouseId:'999',warehouseCode:input.warehouseCode,warehouseName:'测试仓'};
  await new Promise(r=>setTimeout(r,50));
  if (params.get('method')==='erp.stockquantity.get') return Response.json({code:200,result:{data:{goodsStockQuantity:input.maxQuantityId==='0'?[row]:[]}}});
  if (params.get('method')==='erp-stock.stock.skulist') return Response.json({code:200,result:{data:Number(input.pageIndex)===0?[{...row,orderAbleQuantity:'17.25'}]:[]}});
  if (params.get('method')==='erp-busiorder.goodsdocin.search') {
    const timestamp=Date.parse(input.inOutDateStart.replace(' ','T')+'+08:00')+3600000;
    return Response.json({code:200,subCode:'0250000004',result:{data:input.archived===0 && input.pageIndex===0 ? [{recId:'inbound-test-1',docId:'inbound-doc-1',goodsdocNo:'TEST-INBOUND-4',goodsNo:'TEST-GOODS',warehouseCode:input.warehouseCode,skuBarcode:'TEST-BARCODE',quantity:'4',unitName:'Pcs',inOutDate:timestamp,gmtCreate:timestamp,inouttypeName:'调拨入库'}] : [],noPrivilegeItem:null}});
  }
  throw new Error('Unexpected outbound request in test');
};
