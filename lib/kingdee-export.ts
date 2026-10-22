import { deflateRawSync } from 'node:zlib';
import { zipTextFiles } from './zip';
import { defaultKingdeeTemplate, sheetColumns, sheetValue, type SheetMode } from './kingdee-sheet';
import type { ExcelCellStyle, KingdeeBatch, KingdeeGoods } from './kingdee-types';
import { sourceLabels } from './kingdee-types';

const escape = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const column = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : column(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
function cell(address: string, value: string | null, style = 0, numeric = false) {
  if (value === null) return `<c r="${address}" s="${style}"/>`;
  if (numeric && /^-?\d+(\.\d+)?$/.test(value) && value.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15) return `<c r="${address}" s="${style}"><v>${value}</v></c>`;
  return `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
}
function styleXml(styles: ExcelCellStyle[]) {
  const formats = [...new Set(styles.map(style => style.format))];
  return `<styleSheet xmlns="${ns}"><numFmts count="${formats.length}">${formats.map((format, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escape(format)}"/>`).join('')}</numFmts><fonts count="${styles.length}">${styles.map(style => `<font><sz val="${style.size}"/><name val="${escape(style.font)}"/><color rgb="FF${style.color.slice(1)}"/>${style.bold ? '<b/>' : ''}${style.italic ? '<i/>' : ''}${style.strike ? '<strike/>' : ''}</font>`).join('')}</fonts><fills count="${styles.length + 2}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${styles.map(style => `<fill><patternFill patternType="solid"><fgColor rgb="FF${style.background.slice(1)}"/><bgColor indexed="64"/></patternFill></fill>`).join('')}</fills><borders count="1"><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${styles.length}">${styles.map((style, i) => `<xf numFmtId="${164 + formats.indexOf(style.format)}" fontId="${i}" fillId="${i + 2}" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="${['left', 'right', 'center'].includes(style.align) ? style.align : 'general'}" vertical="center"/></xf>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

// Application runtime export follows the same template and values as the browser grid.
export function kingdeeWorkbook(batch: KingdeeBatch, goods: KingdeeGoods[], mode: SheetMode = 'current') {
  const template = batch.template || defaultKingdeeTemplate, columns = sheetColumns(template, mode);
  const items = mode === 'original' ? goods.filter(row => row.legacy) : goods;
  const heading = `<row r="1" ht="${template.headerHeight * .75}" customHeight="1">${columns.map((c, i) => cell(column(i) + '1', c.label, c.headerStyle)).join('')}</row>`;
  const data = items.map((row, index) => `<row r="${index + 2}" ht="${template.rowHeight * .75}" customHeight="1">${columns.map((c, i) => {
    const styleIndex = mode === 'original' || i < 81 ? row.legacy?.styles[i] ?? c.bodyStyle : c.headerStyle;
    return cell(column(i) + (index + 2), sheetValue(row, i, mode), styleIndex, i >= 6);
  }).join('')}</row>`).join('');
  const detail = `<worksheet xmlns="${ns}"><dimension ref="A1:CN${items.length + 1}"/><sheetViews><sheetView workbookViewId="0"><pane xSplit="6" ySplit="1" topLeftCell="G2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${(c.width - 5) / 7}" customWidth="1"/>`).join('')}</cols><sheetData>${heading}${data}</sheetData><autoFilter ref="A1:CN${items.length + 1}"/></worksheet>`;
  const groupNames: Record<string, string> = { inner: '内仓', outer: '外仓', excluded: '明确排除', outside: '未纳入本次名单' };
  const warehouseRows = [['仓库名称', '本批归属', '来源结存数量', '来源行数'], ...batch.summary.warehouses.map(row => [row.name, groupNames[row.group], row.quantity, String(row.rows)])];
  const metadata = [['项目', '说明'], ['状态', mode === 'original' ? '原表92列缓存值对照，不执行原表公式，不改写历史' : '92列布局；G—CC为原表历史缓存，CD—CN为本批参考结果，未宣称历史年月和截止时点一致'], ['批次', batch.id], ['导入时间', batch.createdAt], ['规则版本', String(batch.rules.version)], ...batch.summary.notices.map(note => ['暂缓或范围说明', note]), ...batch.sources.flatMap(source => [[sourceLabels[source.kind], source.name], ['导出条件', source.conditions || '源文件未提供条件摘要'], ['源文件SHA256', source.sha256], ['业务行数', String(source.rows)], ['源数量合计', source.total || '不适用']])];
  for (const source of batch.sources) if (source.originBatchId) metadata.push(['复用来源版本', `${sourceLabels[source.kind]}：${source.originBatchId}（沿用原件，未重新采集）`]);
  for (const source of batch.sources) if (source.originCollectionId) metadata.push(['完整采集任务',`${sourceLabels[source.kind]}：${source.originCollectionId}（已剔除显示汇总行，客户规则按本批规则执行）`]);
  const plain = (rows: string[][]) => `<worksheet xmlns="${ns}"><cols><col min="1" max="1" width="32" customWidth="1"/><col min="2" max="4" width="70" customWidth="1"/></cols><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => cell(column(j) + (i + 1), value)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zipTextFiles({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${[1, 2, 3].map(i => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${[mode === 'current' ? '明细' : '原表对照', '仓库范围', '来源与说明'].map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3].map(i => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': styleXml(template.styles), 'xl/worksheets/sheet1.xml': detail, 'xl/worksheets/sheet2.xml': plain(warehouseRows), 'xl/worksheets/sheet3.xml': plain(metadata),
  }, data => deflateRawSync(data, { level: 6 }));
}
