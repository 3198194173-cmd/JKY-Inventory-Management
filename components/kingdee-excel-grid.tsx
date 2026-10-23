'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown } from 'lucide-react';
import { currentStart, sheetCellNote, sheetColumns, sheetStyle, sheetValue, type SheetMode } from '@/lib/kingdee-sheet';
import type { KingdeeGoods, KingdeeTemplate } from '@/lib/kingdee-types';

export function KingdeeExcelGrid({ rows, template, mode, onMode, onSource, onColumn, activeColumn, busy }: {
  rows: KingdeeGoods[]; template: KingdeeTemplate; mode: SheetMode; onMode: (mode: SheetMode) => void;
  onSource: (row: KingdeeGoods) => void; onColumn: (column: string) => void; activeColumn: string; busy: boolean;
}) {
  const [selected, setSelected] = useState({ row: 0, column: 4 }), [zoom, setZoom] = useState(100);
  const viewport = useRef<HTMLDivElement>(null);
  const columns = sheetColumns(template, mode), scale = zoom / 100, gutter = 48;
  const offsets = columns.map((_, index) => gutter + columns.slice(0, index).reduce((sum, item) => sum + item.width * scale, 0));
  const currentRow = rows[selected.row], currentValue = currentRow ? sheetValue(currentRow, selected.column, mode, template) : null;
  const address = currentRow ? columns[Math.min(selected.column,columns.length-1)].key + (currentRow.sheetRow || selected.row + 2) : 'A1';
  function jump(index: number) { if (viewport.current) viewport.current.scrollLeft = Math.max(0, offsets[index] - offsets[Math.min(6, index)]); }
  useEffect(() => { if (viewport.current) viewport.current.scrollLeft = Math.max(0, (sheetColumns(template,mode).slice(6, mode==='original'?81:currentStart(template)).reduce((sum, item) => sum + item.width, 0)) * scale); }, [template, scale, mode]);
  function position(index: number): CSSProperties {
    return index < template.frozenColumns ? { position: 'sticky', left: offsets[index], zIndex: 3 } : {};
  }
  return <div className="kd-excel">
    <div className="kd-formula-bar"><span className="kd-cell-address">{address}</span><span className="kd-fx">ƒx</span><output title={currentValue || ''}>{currentValue ?? ''}</output><button onClick={() => jump(6)}>历史月份</button><button onClick={() => jump(mode==='original'?81:currentStart(template))}>本批销量与结存</button></div>
    {currentRow&&<div className="kd-cell-note" role="status">{sheetCellNote(currentRow,selected.column,mode,template)||'按物料编码关联本批来源；点击编码或双击单元格查看来源文件和源行。'}</div>}
    <div className="kd-sheet-viewport" ref={viewport} tabIndex={0} aria-label={`Excel明细网格，横向滚动查看全部${columns.length}列`} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !rows.length) return;
      event.preventDefault();
      const next = { row: Math.max(0, Math.min(rows.length - 1, selected.row + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))), column: Math.max(0, Math.min(columns.length-1, selected.column + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))) };
      setSelected(next);
      viewport.current?.querySelector(`[data-address="${next.row}-${next.column}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }}>
      <table className="kd-sheet" style={{ width: gutter + columns.reduce((sum, column) => sum + column.width * scale, 0), fontSize: 13.333 * scale }} aria-label={mode === 'current' ? '明细，本批数据' : '原表明细对照'}>
        <colgroup><col style={{ width: gutter }}/>{columns.map(column => <col key={column.key} style={{ width: column.width * scale }}/>)}</colgroup>
        <thead><tr className="kd-column-letters"><th className="kd-corner" aria-label="行号"/>{columns.map((column, index) => <th key={column.key} style={{ ...position(index), zIndex: index < 6 ? 8 : 5 }} className={index === selected.column ? 'kd-active-letter' : ''}>{column.key}</th>)}</tr>
          <tr className="kd-sheet-head"><th className="kd-row-number">1</th>{columns.map((column, index) => {
            const style = template.styles[column.headerStyle];
            return <th key={column.key} style={{ ...position(index), zIndex: index < 6 ? 7 : 4, background: style.background, color: style.color, height: template.headerHeight * scale }} title={column.label}>
              <span>{column.label}</span><button disabled={busy} aria-label={'筛选' + column.key + '列：' + column.label} className={activeColumn === column.key ? 'kd-filter-active' : ''} onClick={() => onColumn(column.key)}><ChevronDown size={11}/></button>
            </th>;
          })}</tr></thead>
        <tbody>{rows.map((row, rowIndex) => <tr key={row.code} style={{ height: template.rowHeight * scale }}><th className={'kd-row-number' + (selected.row === rowIndex ? ' kd-active-row' : '')}>{row.sheetRow || rowIndex + 2}</th>{columns.map((column, index) => {
          const style = sheetStyle(row, index, template, mode), cell = sheetValue(row, index, mode, template), active = selected.row === rowIndex && selected.column === index;
          return <td key={column.key} data-address={rowIndex + '-' + index} aria-selected={active} className={active ? 'kd-selected-cell' : ''} style={{ ...position(index), background: style.background, color: style.color, fontFamily: style.font + ', SimSun, serif', fontWeight: style.bold ? 700 : 400, fontStyle: style.italic ? 'italic' : 'normal', textDecoration: style.strike ? 'line-through' : 'none', textAlign: ['left', 'right', 'center'].includes(style.align) ? style.align as 'left' : index >= 6 ? 'right' : 'left' }} title={[cell===null?'空白':cell,sheetCellNote(row,index,mode,template)].filter(Boolean).join('；')} onClick={() => setSelected({ row: rowIndex, column: index })} onDoubleClick={() => onSource(row)}>
            {index === 4 ? <button className="kd-code-cell" onClick={() => onSource(row)}>{cell || row.code}</button> : cell ?? ''}
          </td>;
        })}</tr>)}</tbody>
      </table>
      {!rows.length && <p className="kd-no-rows">没有符合条件的数据</p>}
    </div>
    <div className="kd-sheet-tabs"><div role="tablist" aria-label="明细工作表"><button disabled={busy} role="tab" aria-selected={mode === 'current'} onClick={() => onMode('current')}>明细</button><button disabled={busy} role="tab" aria-selected={mode === 'original'} onClick={() => onMode('original')}>原表对照</button></div><span>{mode === 'current' ? '继承原明细 · 新期间向右追加 · 新编码向下追加' : '原表92列缓存值 · 不推断年份、不覆盖历史'}</span><label>缩放<select aria-label="表格缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))}>{[75, 90, 100, 110, 125].map(percent => <option key={percent} value={percent}>{percent}%</option>)}</select></label></div>
  </div>;
}
