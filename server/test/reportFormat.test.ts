import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ReportWorkbook } from '@judging/shared';
import { encodeCsv, encodeXlsx, spreadsheetText, snapshotChunks } from '../src/reports/format.js';

const workbook = (): ReportWorkbook => ({
  kind: 'results',
  generatedAt: '2026-11-23T10:00:00.000Z',
  filters: { version: 2 },
  sheets: [
    {
      name: 'Competition Results',
      columns: ['Team', 'Score', 'Notes'],
      rows: [['=HYPERLINK("malicious")', 107, 'Arabic العربية & <xml>\r\nNew line']],
    },
  ],
});
export function unzipXlsx(buffer: Buffer) {
  const files = new Map<string, string>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const length = buffer.readUInt32LE(offset + 18),
      nameLength = buffer.readUInt16LE(offset + 26),
      extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extra;
    files.set(name, inflateRawSync(buffer.subarray(start, start + length)).toString());
    offset = start + length;
  }
  return files;
}
describe('safe spreadsheet export', () => {
  it('preserves Unicode exactly across long correction snapshot boundaries', () => {
    const original = 'a'.repeat(29999) + '😀' + 'b'.repeat(30000) + 'العربية';
    const chunks = snapshotChunks(original);
    expect(chunks.join('')).toBe(original);
    expect(chunks.every((c) => c.length <= 30000 && Buffer.from(c).toString() === c)).toBe(true);
  });
  it('writes real OOXML numeric cells, literal strings, Arabic, multiline notes and metadata', () => {
    const files = unzipXlsx(encodeXlsx(workbook()));
    expect([...files.keys()]).toContain('[Content_Types].xml');
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="B2"><v>107</v></c>');
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain('=HYPERLINK');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('العربية &amp; &lt;xml&gt;&#13;');
    expect(files.get('xl/worksheets/sheet2.xml')).toContain('2026-11-23T10:00:00.000Z');
    expect(files.get('xl/workbook.xml')).toContain('Export Metadata');
  });
  it('quotes CSV, preserves numbers and neutralizes formula prefixes including whitespace', () => {
    for (const text of [
      '=1+1',
      ' +SUM(A1)',
      '-cmd',
      '@SUM(A1)',
      '\t=cmd',
      '\nformula',
      '\u0000=1+1',
      '\u001b @SUM(A1)',
    ])
      expect(spreadsheetText(text)).toBe("'" + text);
    const csv = encodeCsv(workbook()).toString();
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('""malicious""');
    expect(csv).toContain('"107"');
    expect(csv).toContain('Generated at (UTC)');
    expect(csv).toContain('""version"":2');
  });
  it('exports the requested normalized CSV sheet and rejects unknown sheets', () => {
    const report = workbook();
    report.sheets.push({ name: 'Criteria', columns: ['Stars'], rows: [[5]] });
    expect(encodeCsv(report, 'Criteria').toString()).toContain('Stars');
    expect(() => encodeCsv(report, 'Unknown')).toThrow('Choose a sheet');
  });
  it('refuses oversized cells and exports rather than truncating them', () => {
    const report = workbook();
    report.sheets[0]!.rows = [['x'.repeat(32768)]];
    expect(() => encodeXlsx(report)).toThrow('safe size limit');
    report.sheets[0]!.rows = [['x'.repeat(33 * 1024 * 1024)]];
    expect(() => encodeCsv(report)).toThrow('safe size limit');
  });
});
