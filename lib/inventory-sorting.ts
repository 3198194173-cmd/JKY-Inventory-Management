import { compareQuantity, multiplyQuantity } from './decimal';
import type { InventoryMetrics } from './inventory-metrics';

export const metricSortLabels:Record<string,string>={average_desc:'销售均值从大到小',average_asc:'销售均值从小到大',turnover_desc:'库存周转从大到小',turnover_asc:'库存周转从小到大'};
type SortRow={goodsNo:string;quantity:string;metrics?:InventoryMetrics};
export function compareInventoryMetric(a:SortRow,b:SortRow,field:'average'|'turnover',ascending:boolean){
  const valid=(r:SortRow)=>r.metrics?.total7!=null&&(field==='average'?r.metrics.average7!=null:r.metrics.turnoverDays!=null);
  const av=valid(a),bv=valid(b);if(av!==bv)return av?-1:1;
  if(av&&bv){
    // Compare the unrounded ratios. All averages share denominator 7; turnover
    // denominators are strictly positive whenever turnover is defined.
    const comparison=field==='average'?compareQuantity(a.metrics!.total7!,b.metrics!.total7!):compareQuantity(multiplyQuantity(a.quantity,b.metrics!.total7!),multiplyQuantity(b.quantity,a.metrics!.total7!));
    if(comparison)return ascending?comparison:-comparison;
  }
  return a.goodsNo<b.goodsNo?-1:a.goodsNo>b.goodsNo?1:0;
}
