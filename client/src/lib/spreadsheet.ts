/**
 * Reads the team import file in the browser: CSV (comma, semicolon or tab) or
 * Excel .xlsx (first sheet). No third-party libraries: .xlsx is a zip of XML
 * files, unpacked with the browser's DecompressionStream and DOMParser.
 * The server validates every row again; this only turns the file into rows.
 */
import { TEAM_LIMITS, type ImportRowInput } from '@judging/shared';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]?.[1] && counts[0][1] > 1 ? counts[0][0] : ',';
}

/** RFC 4180 CSV: quoted fields, "" escapes, line breaks inside quotes, BOM. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// XLSX (zip + XML)
// ---------------------------------------------------------------------------

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const stream = source.pipeThrough(
    new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Extracts the named files from a zip archive (stored or deflated entries). */
async function unzip(
  buffer: ArrayBuffer,
  wanted: (name: string) => boolean,
): Promise<Map<string, string>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file.');
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const out = new Map<string, string>();
  for (let e = 0; e < entries; e++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('This .xlsx file is damaged.');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + compressedSize);
    if (method === 0) out.set(name, decoder.decode(raw));
    else if (method === 8) out.set(name, decoder.decode(await inflateRaw(raw)));
    else throw new Error('This .xlsx file uses an unsupported compression method.');
  }
  return out;
}

function xml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length)
    throw new Error('This .xlsx file is damaged.');
  return doc;
}

const byTag = (node: Document | Element, tag: string) =>
  Array.from(node.getElementsByTagNameNS('*', tag));

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Reads the first worksheet of an .xlsx file as rows of text. */
export async function readXlsx(buffer: ArrayBuffer): Promise<string[][]> {
  const files = await unzip(
    buffer,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      n.startsWith('xl/worksheets/'),
  );
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const first = byTag(xml(workbook), 'sheet')[0];
    const rid =
      first?.getAttribute('r:id') ??
      first?.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id',
      );
    const target = byTag(xml(rels), 'Relationship')
      .find((r) => r.getAttribute('Id') === rid)
      ?.getAttribute('Target');
    if (target)
      sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const sheet = files.get(sheetPath);
  if (!sheet) throw new Error('The .xlsx file has no worksheet.');

  const shared = files.has('xl/sharedStrings.xml')
    ? byTag(xml(files.get('xl/sharedStrings.xml') as string), 'si').map((si) =>
        byTag(si, 't')
          .map((t) => t.textContent ?? '')
          .join(''),
      )
    : [];

  const rows: string[][] = [];
  for (const rowEl of byTag(xml(sheet), 'row')) {
    const values: string[] = [];
    let next = 0;
    for (const c of byTag(rowEl, 'c')) {
      const ref = c.getAttribute('r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = c.getAttribute('t');
      const v = byTag(c, 'v')[0]?.textContent ?? '';
      let value: string;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr')
        value = byTag(c, 't')
          .map((t) => t.textContent ?? '')
          .join('');
      else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else value = v;
      values[col] = value;
    }
    const rowNumber = Number(rowEl.getAttribute('r')) || rows.length + 1;
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(Array.from(values, (v) => v ?? ''));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------

type Field = 'teamCode' | 'name' | 'projectName';

const HEADER_ALIASES: Record<string, Field> = {
  teamid: 'teamCode',
  teamcode: 'teamCode',
  teamnumber: 'teamCode',
  id: 'teamCode',
  code: 'teamCode',
  teamname: 'name',
  team: 'name',
  name: 'name',
  projectname: 'projectName',
  project: 'projectName',
  projecttitle: 'projectName',
};

export const TEMPLATE_HEADERS = ['Team ID', 'Team Name', 'Project Name'] as const;

export interface ParsedImportFile {
  rows: ImportRowInput[];
  /** Problems with the whole file (missing columns, too many rows, ...). */
  fileErrors: string[];
  ignoredColumns: string[];
}

/** Turns a table (first row = headers) into import rows with their line numbers. */
export function mapImportTable(table: string[][]): ParsedImportFile {
  const headerIndex = table.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerIndex < 0) return { rows: [], fileErrors: ['The file is empty.'], ignoredColumns: [] };
  const headers = table[headerIndex] as string[];
  const columns = new Map<Field, number>();
  const ignored: string[] = [];
  const fileErrors: string[] = [];
  headers.forEach((h, i) => {
    const key = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    const field = HEADER_ALIASES[key];
    if (!h.trim()) return;
    if (!field) ignored.push(h.trim());
    else if (columns.has(field))
      fileErrors.push(`The column "${h.trim()}" appears more than once.`);
    else columns.set(field, i);
  });
  const missing = (['teamCode', 'name', 'projectName'] as Field[]).filter((f) => !columns.has(f));
  if (missing.length) {
    const label = { teamCode: 'Team ID', name: 'Team Name', projectName: 'Project Name' };
    fileErrors.push(
      `Missing column${missing.length > 1 ? 's' : ''}: ${missing.map((m) => label[m]).join(', ')}. Use the template's header row.`,
    );
  }

  const rows: ImportRowInput[] = [];
  const cell = (r: string[], f: Field) => {
    const i = columns.get(f);
    return i === undefined ? '' : String(r[i] ?? '').trim();
  };
  for (let i = headerIndex + 1; i < table.length; i++) {
    const r = table[i] as string[];
    if (!r.some((c) => String(c ?? '').trim() !== '')) continue; // skip blank lines
    rows.push({
      rowNumber: i + 1,
      teamCode: cell(r, 'teamCode'),
      name: cell(r, 'name'),
      projectName: cell(r, 'projectName'),
    });
  }
  if (!fileErrors.length && rows.length === 0)
    fileErrors.push('The file has a header row but no teams.');
  if (rows.length > TEAM_LIMITS.importRows) {
    fileErrors.push(
      `The file has ${rows.length} teams; the limit is ${TEAM_LIMITS.importRows} per import. Split it into smaller files.`,
    );
  }
  return { rows, fileErrors, ignoredColumns: ignored };
}

function readFile<T extends 'text' | 'buffer'>(
  file: File,
  as: T,
): Promise<T extends 'text' ? string : ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as T extends 'text' ? string : ArrayBuffer);
    reader.onerror = () => reject(new Error('The file could not be read.'));
    if (as === 'text') reader.readAsText(file, 'utf-8');
    else reader.readAsArrayBuffer(file);
  });
}

/** Reads a File chosen by the user (.csv or .xlsx). */
export async function readImportFile(file: File): Promise<ParsedImportFile> {
  if (file.size > 5 * 1024 * 1024)
    return { rows: [], fileErrors: ['The file is larger than 5 MB.'], ignoredColumns: [] };
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.xlsx'))
      return mapImportTable(await readXlsx(await readFile(file, 'buffer')));
    if (name.endsWith('.csv') || name.endsWith('.txt'))
      return mapImportTable(parseCsv(await readFile(file, 'text')));
    if (name.endsWith('.xls')) {
      return {
        rows: [],
        fileErrors: [
          'Old .xls files are not supported. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV.',
        ],
        ignoredColumns: [],
      };
    }
    return { rows: [], fileErrors: ['Choose a .xlsx or .csv file.'], ignoredColumns: [] };
  } catch (error) {
    return {
      rows: [],
      fileErrors: [error instanceof Error ? error.message : 'The file could not be read.'],
      ignoredColumns: [],
    };
  }
}
