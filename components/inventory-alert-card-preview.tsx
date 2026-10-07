"use client";
import { Fragment, useState } from "react";
import type { TurnoverCard } from "@/lib/dingtalk-card-data";
import { SalesTrend } from "@/components/sales-trend";

export function InventoryAlertCardPreview({ card }: { card: TurnoverCard }) {
  const [selected, setSelected] = useState<string | null>(null);
  return <div className="alert-native-preview">
    <header><strong>{card.title}</strong><p>{card.summary}</p></header>
    <div className="alert-native-table-wrap"><table>
      <thead><tr><th>商品编码</th><th>库存</th><th>均值</th><th>周转（天）</th><th>近7天销量</th></tr></thead>
      <tbody>{card.rows.map(row => <Fragment key={row.goodsNo}>
        <tr><td><button type="button" aria-expanded={selected === row.goodsNo} onClick={() => setSelected(selected === row.goodsNo ? null : row.goodsNo)}>{row.goodsNo}</button></td><td>{row.quantity}</td><td>{row.average}</td><td className="alert-native-turnover">{row.turnover}</td><td><SalesTrend compact samples={card.dates.map((date, i) => ({ date, value: row.sales[i] }))}/></td></tr>
        {selected === row.goodsNo && <tr><td colSpan={5}><section className="alert-native-detail"><strong>{row.goodsName}</strong><SalesTrend samples={card.dates.map((date, i) => ({ date, value: row.sales[i] }))}/><dl>{card.dates.map((date, i) => <div key={date}><dt>{date.slice(5)}</dt><dd>{row.sales[i] ?? "暂无数据"}{row.sales[i] == null ? "" : ` ${row.unitName}`}</dd></div>)}</dl></section></td></tr>}
      </Fragment>)}</tbody>
    </table></div>
    <footer>{card.footer}<span>点击商品编码展开每日销量；钉钉使用原生图表组件，布局以客户端为准。</span></footer>
  </div>;
}
