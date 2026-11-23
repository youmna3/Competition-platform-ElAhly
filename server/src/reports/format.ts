import { deflateRawSync } from 'node:zlib';
import type { ReportCell, ReportSheet, ReportWorkbook } from '@judging/shared';
import { RuleError } from '../errors.js';

// OOXML inline-string cells never contain formulas, links, macros or external relationships.
// Specification: https://learn.microsoft.com/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document
const xml = (s: string) =>
  s
    // XML 1.0 forbids these code points; this is intentional output sanitization.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;')
    .replace(/"/g, '&quot;');
export const spreadsheetText = (s: string) =>
  /^[\p{White_Space}\p{Cc}\uFEFF]*[=+\-@]/u.test(s) || /^[\p{Cc}]/u.test(s) ? `'${s}` : s;
/** Stay below Excel's cell limit without splitting a Unicode surrogate pair. */
export function snapshotChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 30000, text.length);
    const last = text.charCodeAt(end - 1),
      next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
const column = (n: number): string =>
  n > 26
    ? column(Math.floor((n - 1) / 26)) + String.fromCharCode(65 + ((n - 1) % 26))
    : String.fromCharCode(64 + n);
const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const tooLarge = () =>
  new RuleError(
    413,
    'REPORT_TOO_LARGE',
    'This export exceeds the safe size limit. Narrow the report filters; no rows were silently omitted.',
  );

function worksheet(sheet: ReportSheet) {
  if (sheet.rows.length > 100_000 || sheet.columns.length > 100) throw tooLarge();
  const rows = [sheet.columns, ...sheet.rows];
  return (
    declaration +
    `<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>` +
    rows
      .map(
        (row, i) =>
          `<row r="${i + 1}">` +
          row
            .map((v, j) => {
              const ref = `${column(j + 1)}${i + 1}`;
              if (v == null) return `<c r="${ref}"/>`;
              if (typeof v === 'number') {
                if (!Number.isFinite(v)) throw new Error('Non-finite report score');
                return `<c r="${ref}"><v>${v}</v></c>`;
              }
              const value = String(v);
              if (value.length > 32767) throw tooLarge();
              // Literal _xHHHH_ sequences must survive Excel's escape decoding.
              return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value.replace(/_x[0-9a-f]{4}_/gi, (m) => '_x005F_' + m.slice(1)))}</t></is></c>`;
            })
            .join('') +
          '</row>',
      )
      .join('') +
    `</sheetData><autoFilter ref="A1:${column(sheet.columns.length)}${rows.length}"/></worksheet>`
  );
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function zip(entries: { name: string; data: Buffer }[]) {
  const chunks: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = entry.data,
      compressed = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(8, 8);
    h.writeUInt16LE(33, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(compressed.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    chunks.push(h, name, compressed);
    central.push(c, name);
    offset += h.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
function assertSize(sheets: ReportSheet[]) {
  let bytes = 0,
    cells = 0;
  for (const sheet of sheets)
    for (const row of sheet.rows) {
      cells += row.length;
      for (const v of row) bytes += typeof v === 'string' ? Buffer.byteLength(v) : 8;
    }
  if (bytes > 32 * 1024 * 1024 || cells > 1_000_000) throw tooLarge();
}
export function encodeXlsx(report: ReportWorkbook): Buffer {
  const sheets = [
    ...report.sheets,
    {
      name: 'Export Metadata',
      columns: ['Property', 'Value'],
      rows: [
        ['Generated at (UTC)', report.generatedAt],
        ['Report', report.kind],
        ['Filters', JSON.stringify(report.filters)],
        [
          'Scoring',
          'Server values; combined = base + bonus. Blank official rank means unranked/provisional.',
        ],
      ],
    } satisfies ReportSheet,
  ];
  assertSize(sheets);
  const entries: { name: string; data: Buffer }[] = [];
  const add = (name: string, s: string) => entries.push({ name, data: Buffer.from(s) });
  add(
    '[Content_Types].xml',
    declaration +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
  );
  add(
    '_rels/.rels',
    declaration +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  add(
    'xl/workbook.xml',
    declaration +
      `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  );
  add(
    'xl/_rels/workbook.xml.rels',
    declaration +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  );
  sheets.forEach((s, i) => add(`xl/worksheets/sheet${i + 1}.xml`, worksheet(s)));
  return zip(entries);
}
export function encodeCsv(report: ReportWorkbook, sheetName?: string): Buffer {
  assertSize(report.sheets);
  const sheet = sheetName ? report.sheets.find((s) => s.name === sheetName) : report.sheets[0];
  if (!sheet) throw new RuleError(400, 'INVALID_SHEET', 'Choose a sheet from this report.');
  const cell = (v: ReportCell) =>
    `"${(typeof v === 'string' ? spreadsheetText(v) : v == null ? '' : String(v)).replace(/"/g, '""')}"`;
  return Buffer.from(
    '\uFEFF' +
      [
        ['Generated at (UTC)', 'Applied filters', ...sheet.columns],
        ...sheet.rows.map((row) => [report.generatedAt, JSON.stringify(report.filters), ...row]),
      ]
        .map((row) => row.map(cell).join(','))
        .join('\r\n') +
      '\r\n',
  );
}
