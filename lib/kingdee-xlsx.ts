import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { crc32 } from './zip';
import type { ExcelCellStyle, KingdeeTemplate } from './kingdee-types';

export type XlsxRow = { row: number; cells: Record<string, string>; styles?: Record<string, number> };
const MAX_XML = 160 * 1024 * 1024;

function decode(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (name[0] !== '#') return named[name] ?? entity;
    const point = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (point > 0x10ffff || point === 0 || point < 0 || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Excel字符编码异常');
    return String.fromCodePoint(point);
  });
}

function attributes(text: string) {
  const result: Record<string, string> = {};
  for (const item of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[item[1]] = decode(item[2] ?? item[3]);
  return result;
}

function textRuns(xml: string) {
  // Phonetic runs are annotations, not part of the cell's displayed value.
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => decode(item[1])).join('');
}

function archive(bytes: Buffer) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) throw new Error('不是有效的xlsx文件，请重新导出');
  const count = bytes.readUInt16LE(end + 10), central = bytes.readUInt32LE(end + 16);
  if (count > 2000 || central >= end || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('不支持该Excel压缩格式');
  const entries = new Map<string, { method: number; size: number; packed: number; offset: number; crc: number }>();
  let cursor = central;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Excel目录损坏');
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extra + comment;
    if (next > end || bytes.readUInt16LE(cursor + 8) & 1) throw new Error('不支持加密或损坏的Excel');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (entries.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/')) throw new Error('Excel内部文件名异常');
    let size = bytes.readUInt32LE(cursor + 24), packed = bytes.readUInt32LE(cursor + 20), offset = bytes.readUInt32LE(cursor + 42);
    if ([size, packed, offset].includes(0xffffffff)) {
      let extraAt = cursor + 46 + nameLength, found = false;
      while (extraAt + 4 <= next - comment) {
        const type = bytes.readUInt16LE(extraAt), length = bytes.readUInt16LE(extraAt + 2), extraEnd = extraAt + 4 + length;
        if (extraEnd > next - comment) throw new Error('Excel扩展目录损坏');
        if (type === 1) {
          let valueAt = extraAt + 4;
          const read64 = () => { if (valueAt + 8 > extraEnd) throw new Error('Excel扩展长度异常'); const value = bytes.readBigUInt64LE(valueAt); valueAt += 8; if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Excel文件过大'); return Number(value); };
          if (size === 0xffffffff) size = read64();
          if (packed === 0xffffffff) packed = read64();
          if (offset === 0xffffffff) offset = read64();
          found = true; break;
        }
        extraAt = extraEnd;
      }
      if (!found) throw new Error('Excel缺少ZIP64长度信息');
    }
    entries.set(name, { method: bytes.readUInt16LE(cursor + 10), packed, size, offset, crc: bytes.readUInt32LE(cursor + 16) });
    cursor = next;
  }
  if ([...entries.keys()].some(name => /vbaProject\.bin$/i.test(name))) throw new Error('请上传不含宏的xlsx文件');
  let inflated = 0;
  return (name: string, optional = false) => {
    const entry = entries.get(name);
    if (!entry) { if (optional) return ''; throw new Error('Excel缺少必要工作表或目录'); }
    if (entry.size > MAX_XML || inflated + entry.size > 220 * 1024 * 1024 || ![0, 8].includes(entry.method)) throw new Error(`Excel解压后过大或格式不支持：${name}，${entry.size}字节，压缩方式${entry.method}`);
    const at = entry.offset;
    if (at + 30 > central || bytes.readUInt32LE(at) !== 0x04034b50) throw new Error('Excel数据损坏');
    const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28);
    if (start + entry.packed > central) throw new Error('Excel数据长度异常');
    const compressed = bytes.subarray(start, start + entry.packed);
    const content = entry.method === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_XML }) : compressed;
    if (content.length !== entry.size || crc32(content) !== entry.crc) throw new Error('Excel文件内容校验不一致');
    inflated += content.length;
    const xml = content.toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Excel包含不支持的外部定义');
    return xml;
  };
}

// Read values only. Formulas and external links are never evaluated.
export function readKingdeeWorkbook(bytes: Buffer, options: { sheet?: string; columns?: string[]; formatting?: boolean } = {}): { rows: XlsxRow[]; template?: KingdeeTemplate } {
  const entry = archive(bytes);
  const workbook = entry('xl/workbook.xml');
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)].map(item => attributes(item[1]));
  const selected = options.sheet ? sheets.find(sheet => sheet.name === options.sheet) : sheets[0];
  if (!selected) throw new Error('找不到指定工作表：' + (options.sheet || '首张表'));
  const rel = [...entry('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)].map(item => attributes(item[1])).find(item => item.Id === selected['r:id']);
  if (!rel || rel.TargetMode === 'External') throw new Error('工作表关联无效');
  const target = rel.Target.startsWith('/') ? rel.Target.slice(1) : posix.normalize('xl/' + rel.Target);
  if (!target.startsWith('xl/worksheets/') || !target.endsWith('.xml')) throw new Error('工作表路径无效');
  const strings = [...entry('xl/sharedStrings.xml', true).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(item => textRuns(item[1]));
  const rows: XlsxRow[] = [];
  const columns = options.columns ? new Set(options.columns) : null;
  const sheetXml = entry(target);
  for (const item of sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const index = Number(attributes(item[1]).r);
    if (!Number.isSafeInteger(index) || index < 1 || rows.length > 150000) throw new Error('Excel行号或行数异常');
    const cells: Record<string, string> = {};
    const styles: Record<string, number> | undefined = options.formatting ? {} : undefined;
    for (const cell of item[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attributes(cell[1]), col = /^([A-Z]+)\d+$/.exec(attrs.r || '')?.[1];
      if (!col || (columns && !columns.has(col))) continue;
      if (styles) styles[col] = Number(attrs.s || 0);
      const body = cell[2] || '', raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (attrs.t === 's' && raw !== undefined) {
        const position = Number(raw);
        if (!Number.isInteger(position) || strings[position] === undefined) throw new Error('Excel共享字符串索引异常');
        cells[col] = strings[position];
      } else if (attrs.t === 'inlineStr') cells[col] = textRuns(body);
      else if (raw !== undefined) { if (attrs.t === 'e') throw new Error('Excel源数据包含错误单元格'); cells[col] = decode(raw); }
    }
    rows.push({ row: index, cells, ...(styles ? { styles } : {}) });
  }
  const template = options.formatting ? readLayout(entry('xl/styles.xml', true), entry('xl/theme/theme1.xml', true), sheetXml, rows) : undefined;
  return { rows, template };
}

export function readKingdeeXlsx(bytes: Buffer, options: { sheet?: string; columns?: string[] } = {}): XlsxRow[] {
  return readKingdeeWorkbook(bytes, options).rows;
}

export function excelColumn(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : excelColumn(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);
}

function readLayout(xml: string, theme: string, sheet: string, rows: XlsxRow[]): KingdeeTemplate | undefined {
  const header = rows.find(row => row.row === 1);
  if (!header || !header.cells.CN || header.cells.E !== '物料编码') return;
  const section = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml)?.[1] || '';
  const palette = [...(theme.match(/<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/)?.[1] || '').matchAll(/<a:(?:srgbClr|sysClr)\b([^>]*)\/>/g)].map(match => { const a = attributes(match[1]); return a.lastClr || a.val; });
  function color(fragment: string, tag = 'color', fallback = '#000000') {
    const a = attributes(new RegExp(`<${tag}\\b([^>]*)\\/>`).exec(fragment)?.[1] || '');
    let hex = a.rgb?.slice(-6) || (a.theme ? palette[Number(a.theme)] : undefined) || ({ '8': '000000', '9': 'FFFFFF', '10': 'FF0000', '11': '00FF00', '12': '0000FF', '13': 'FFFF00', '14': 'FF00FF', '15': '00FFFF' } as Record<string, string>)[a.indexed];
    if (!hex || !/^[\da-f]{6}$/i.test(hex)) return fallback;
    if (a.tint) { const tint = Number(a.tint); hex = hex.match(/../g)!.map(part => { const n = parseInt(part, 16); return Math.round(tint < 0 ? n * (1 + tint) : n + (255 - n) * tint).toString(16).padStart(2, '0'); }).join(''); }
    return '#' + hex.toUpperCase();
  }
  const fonts = [...section('fonts').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>/g)].map(match => match[1]);
  const fills = [...section('fills').matchAll(/<fill\b[^>]*>([\s\S]*?)<\/fill>/g)].map(match => match[1]);
  const formats: Record<string, string> = { '0': 'General', '1': '0', '2': '0.00', '3': '#,##0', '4': '#,##0.00', '49': '@' };
  for (const match of section('numFmts').matchAll(/<numFmt\b([^>]*)\/>/g)) { const a = attributes(match[1]); formats[a.numFmtId] = a.formatCode; }
  const styles: ExcelCellStyle[] = [...section('cellXfs').matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map(match => {
    const a = attributes(match[1]), font = fonts[Number(a.fontId)] || '', fill = fills[Number(a.fillId)] || '';
    const alignment = attributes(/<alignment\b([^>]*)\/>/.exec(match[2] || '')?.[1] || '');
    const attr = (tag: string) => attributes(new RegExp(`<${tag}\\b([^>]*)\\/>`).exec(font)?.[1] || '').val;
    return { background: /patternType="solid"/.test(fill) ? color(fill, 'fgColor', '#FFFFFF') : '#FFFFFF', color: color(font), font: attr('name') || '宋体', size: Number(attr('sz') || 10), bold: /<b(?:\s[^>]*)?\/>/.test(font), italic: /<i(?:\s[^>]*)?\/>/.test(font), strike: /<strike(?:\s[^>]*)?\/>/.test(font), align: alignment.horizontal || 'general', format: formats[a.numFmtId] || 'General' };
  });
  const defs = [...sheet.matchAll(/<col\b([^>]*)\/>/g)].map(match => attributes(match[1]));
  const body = rows.find(row => row.row > 1 && row.cells.E);
  const columns = Array.from({ length: 92 }, (_, index) => {
    const key = excelColumn(index), def = defs.find(item => Number(item.min) <= index + 1 && Number(item.max) >= index + 1);
    return { key, label: header.cells[key] || '', width: Math.floor(Number(def?.width || 11) * 7 + 5), headerStyle: header.styles?.[key] || 0, bodyStyle: body?.styles?.[key] || Number(def?.style || 0) };
  });
  const pane = attributes(/<pane\b([^>]*)\/>/.exec(sheet)?.[1] || '');
  const headerAttrs = attributes(/<row\b([^>]*\br="1"[^>]*)>/.exec(sheet)?.[1] || '');
  return { columns, styles, frozenColumns: Math.min(6, Number(pane.xSplit || 6)), frozenRows: 1, rowHeight: 18, headerHeight: Math.max(23, Number(headerAttrs.ht || 17) * 4 / 3) };
}
