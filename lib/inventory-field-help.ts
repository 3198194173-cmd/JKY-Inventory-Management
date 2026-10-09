// Shared by the inventory table, alert preview and published card template.
export const INVENTORY_FIELD_HELP = {
  product: '来源：吉客云分仓库存查询；同一货品编码的规格汇总为一行。卡片中点击“复制”一次复制商品编码和名称（分两行）。',
  quantity: '来源：erp-stock.stock.skulist 的可订购量 orderAbleQuantity，按货品汇总；库存为采集快照。',
  average: '最近7个完整日期的净销量总和÷7；净销量=期初库存+区间实际入库−期末库存，含负销量。缺日或入库未核验时不计算；周转和补货使用未舍入均值。',
  turnover: '当前库存÷近7天未舍入销售均值，单位：天；不包含在途。负库存保留负周转，均值≤0或数据不足时不计算。',
  transit: '来源：erp.stockin.get / erp.stockin.get.v2；仅本仓库调拨入库（inType=102），汇总入库等待及部分入库单剩余数量（申请−已入库）。完成/关闭单不计；每小时检测，已核验无在途为0，未核验显示待核验。卡片固定为发送时数据。',
  replenishment: '当（库存+在途）÷未舍入销售均值<30天：建议补货=（库存+在途）÷销售均值×30，最低0，四舍五入为整数；达到30天或计算结果为0显示无需补货；均值无效或在途未核验显示—。',
  trend: '近7个完整日期的净销量趋势；净销量=期初库存+区间实际入库−期末库存（含退货），缺失数据不补零。点击查看详情。',
} as const;
