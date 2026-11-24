import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapImportTable, parseCsv, readImportFile, readXlsx } from '../src/lib/spreadsheet';

// Vitest runs from the client folder.
const fixture = resolve(process.cwd(), 'test/fixtures/teams.xlsx');

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, line breaks in quotes, CRLF and a BOM', () => {
    const csv =
      '﻿Team ID,Team Name,Project Name\r\n"A-1","Eagles, ""Juniors""","Water\nFilter"\r\nA-2,Falcons,Bus\r\n';
    expect(parseCsv(csv)).toEqual([
      ['Team ID', 'Team Name', 'Project Name'],
      ['A-1', 'Eagles, "Juniors"', 'Water\nFilter'],
      ['A-2', 'Falcons', 'Bus'],
    ]);
  });

  it('detects semicolon-separated files (Excel in many regions)', () => {
    expect(parseCsv('Team ID;Team Name;Project Name\nA-1;Eagles;Bus')).toEqual([
      ['Team ID', 'Team Name', 'Project Name'],
      ['A-1', 'Eagles', 'Bus'],
    ]);
  });
});

describe('XLSX reading', () => {
  it('reads the first sheet, with Arabic text, numbers, empty cells and quotes', async () => {
    const buffer = readFileSync(fixture);
    const table = await readXlsx(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
    expect(table[0]).toEqual(['Team ID', 'Team Name', 'Project Name', 'Governorate', 'Notes']);
    expect(table[1]).toEqual(['101', 'الصقور', 'Smart Irrigation', 'القاهرة', 'ignored']);
    expect(table[2]?.slice(0, 3)).toEqual(['AHL-002', 'Falcons', 'Solar Bus']);
    expect(table[4]?.slice(0, 4)).toEqual([
      'AHL-003',
      'Eagles, "Juniors"',
      'Water\nFilter',
      'Giza',
    ]);
    expect(JSON.stringify(table)).not.toContain('should');
  });

  it('turns a file into import rows with their line numbers', async () => {
    const buffer = readFileSync(fixture);
    const file = new File([buffer], 'teams.xlsx');
    const parsed = await readImportFile(file);
    expect(parsed.fileErrors).toEqual([]);
    // Older files may still have a Governorate column; it is ignored like any extra column.
    expect(parsed.ignoredColumns).toEqual(['Governorate', 'Notes']);
    expect(parsed.rows.map((r) => [r.rowNumber, r.teamCode, r.name])).toEqual([
      [2, '101', 'الصقور'],
      [3, 'AHL-002', 'Falcons'],
      [5, 'AHL-003', 'Eagles, "Juniors"'],
    ]);
  });

  it('rejects files that are not spreadsheets', async () => {
    expect((await readImportFile(new File(['hello'], 'teams.xlsx'))).fileErrors[0]).toMatch(
      /not a valid \.xlsx/,
    );
    expect((await readImportFile(new File(['x'], 'teams.xls'))).fileErrors[0]).toMatch(/Save As/);
    expect((await readImportFile(new File(['x'], 'teams.pdf'))).fileErrors[0]).toMatch(
      /\.xlsx or \.csv/,
    );
  });
});

describe('header mapping', () => {
  it('maps student names and links, preserving absent columns for legacy updates', () => {
    const parsed = mapImportTable([
      [
        'Team ID',
        'Team Name',
        'Project Name',
        'Student 1 Name',
        'Student 2 Name',
        'Student 3 Name',
        'Presentation Link',
        'Project Website Link',
      ],
      ['T-1', 'Team', 'Project', 'Student A', 'Student B', '', 'https://example.com/slides', ''],
      ['T-2', 'Other', 'Other', 'Student C', 'Student D', 'Student E', '', 'https://example.com'],
    ]);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.ignoredColumns).toEqual([]);
    expect(parsed.rows[0]).toMatchObject({
      studentNames: ['Student A', 'Student B'],
      presentationLink: 'https://example.com/slides',
      projectWebsiteLink: null,
    });
    expect(parsed.rows[1]).toMatchObject({
      studentNames: ['Student C', 'Student D', 'Student E'],
      presentationLink: null,
      projectWebsiteLink: 'https://example.com',
    });
    expect(
      mapImportTable([
        ['Team ID', 'Team Name', 'Project Name'],
        ['T-1', 'Team', 'Project'],
      ]).rows[0],
    ).not.toHaveProperty('studentNames');
  });
  it('accepts common header spellings and reports missing required columns', () => {
    expect(
      mapImportTable([
        ['team_code', 'NAME', 'Project'],
        ['A', 'B', 'C'],
      ]).rows[0],
    ).toMatchObject({ teamCode: 'A', name: 'B', projectName: 'C' });
    expect(
      mapImportTable([
        ['Team ID', 'Team Name'],
        ['A', 'B'],
      ]).fileErrors[0],
    ).toMatch(/Missing column: Project Name/);
    expect(mapImportTable([]).fileErrors[0]).toMatch(/empty/);
    expect(mapImportTable([['Team ID', 'Team Name', 'Project Name']]).fileErrors[0]).toMatch(
      /no teams/,
    );
  });

  it('refuses more rows than one import allows', () => {
    const table = [
      ['Team ID', 'Team Name', 'Project Name'],
      ...Array.from({ length: 2001 }, (_, i) => [`T${i}`, 'n', 'p']),
    ];
    expect(mapImportTable(table).fileErrors[0]).toMatch(/limit is 2000/);
  });

  it('reads the downloadable Excel template without errors other than "no teams"', async () => {
    const template = readFileSync(
      resolve(process.cwd(), 'public/templates/teams-import-template.xlsx'),
    );
    const parsed = await readImportFile(new File([template], 'teams-import-template.xlsx'));
    expect(parsed.fileErrors).toEqual(['The file has a header row but no teams.']);
    const csv = readFileSync(
      resolve(process.cwd(), 'public/templates/teams-import-template.csv'),
      'utf8',
    );
    expect(mapImportTable(parseCsv(csv)).fileErrors).toEqual([
      'The file has a header row but no teams.',
    ]);
  });
});
