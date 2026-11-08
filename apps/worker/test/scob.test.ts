import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeMixedUtf8 } from '../src/scob/decode';
import { parseDivisionList, parseIndex, ratioParagraphs } from '../src/scob/list-parser';
import { parseJudgmentHeader } from '../src/scob/pdf-metadata';

/** JUD-01: SCOB index, both list templates and PDF headers, from pages saved on 2026-11-08. */
const F = new URL('./fixtures/scob/', import.meta.url);
const page = (f: string) => decodeMixedUtf8(readFileSync(new URL(f, F)));
const header = (f: string) => parseJudgmentHeader(readFileSync(new URL(`header_${f}.txt`, F), 'utf8'));

describe('decodeMixedUtf8', () => {
  it('keeps valid UTF-8 and reads stray Windows-1252 bytes as their characters', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('ধারা '), 0x93, 0x41, 0x94, 0x20, 0x96, 0x20, ...new TextEncoder().encode('é')]);
    expect(decodeMixedUtf8(bytes)).toBe(`ধারা ${String.fromCodePoint(0x201c)}A${String.fromCodePoint(0x201d)} ${String.fromCodePoint(0x2013)} é`);
    expect(decodeMixedUtf8(new TextEncoder().encode('plain'))).toBe('plain');
  });

  it('decodes the older list template without replacement characters', () => {
    const text = page('list_AD_5.html');
    expect(text).not.toContain(String.fromCodePoint(0xfffd));
    const curly = [0x2018, 0x2019, 0x201c, 0x201d].map((c) => String.fromCodePoint(c));
    expect(curly.some((q) => text.includes(q))).toBe(true);
  });
});

describe('parseIndex', () => {
  it('finds issues 1–20 with year, full-issue PDF and both division lists (two templates)', () => {
    const issues = parseIndex(page('index.html'));
    expect(issues.map((i) => i.issue)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(issues.every((i) => i.year && i.lists.AD && i.lists.HCD)).toBe(true);
    expect(issues[0]).toMatchObject({ issue: 1, year: 2015, issuePdfUrl: 'https://www.supremecourt.gov.bd/resources/bulletin/1_SCOB_2015.pdf' });
    expect(issues[13]!.lists.HCD).toBe('https://www.supremecourt.gov.bd/web/?page=bulletin/bulletin_list.php&menu=00&div_id=2&issue=14');
    expect(issues[19]!.lists.AD).toBe('https://www.supremecourt.gov.bd/web/?page=bulletin/bulletin_list_AD_20.php&menu=00&div_id=1&issue=20');
  });
});

describe('parseDivisionList', () => {
  it('newer template: parties, judge, citation, key words, summary, key ratio with paragraphs, PDF href from the row', () => {
    const rows = parseDivisionList(page('list_AD_20.html'), { issue: 20, division: 'AD' });
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.serial)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows[0]).toMatchObject({
      parties: 'Begum Khaleda Zia & others Vs. The State and another',
      authoringJudge: 'Syed Refaat Ahmed, CJ',
      citation: '20 SCOB [2025] AD',
      keyRatioParagraphs: ['93'],
      pdfUrl: 'https://www.supremecourt.gov.bd/resources/bulletin/20/1.%2020%20SCOB%20AD-1.pdf',
    });
    expect(rows[0]!.keyWords).toMatch(/^Section-109\/405\/409 of the Penal Code/);
    expect(rows[0]!.summary).toMatch(/^The case against/);
    expect(rows.every((r) => r.citation && r.authoringJudge && r.summary)).toBe(true);
  });

  it('HCD lists use yet another PDF naming ("01. 20 SCOB HCD.pdf")', () => {
    const rows = parseDivisionList(page('list_HD_20.html'), { issue: 20, division: 'HCD' });
    expect(rows).toHaveLength(17);
    expect(rows[0]!.pdfUrl).toBe('https://www.supremecourt.gov.bd/resources/bulletin/20/01.%2020%20SCOB%20HCD.pdf');
    expect(rows[0]).toMatchObject({ authoringJudge: 'Farah Mahbub, J', citation: '20 SCOB [2025] HCD', keyRatioParagraphs: ['312'] });
  });

  it('older template: parties + citation from the link, judge from the end of the parties when given, no summary', () => {
    const ad5 = parseDivisionList(page('list_AD_5.html'), { issue: 5, division: 'AD' });
    expect(ad5).toHaveLength(5);
    expect(ad5[0]).toMatchObject({ parties: 'State Vs. Dafader Marfoth Ali Shah & ors', citation: '5 SCOB[2015]AD 1', authoringJudge: null, summary: null, keyRatioParagraphs: [] });
    expect(ad5[0]!.pdfUrl).toBe('https://www.supremecourt.gov.bd/resources/bulletin/5_SCOB_AD_1.pdf');
    expect(ad5[0]!.keyWords.split('\n')).toContain('Evidence Act, 1872');

    const hd5 = parseDivisionList(page('list_HD_5.html'), { issue: 5, division: 'HCD' });
    expect(hd5).toHaveLength(15);
    expect(hd5[0]).toMatchObject({ parties: 'Md. Mijanur Rahman Vs. Bangladesh and ors', authoringJudge: 'Zinat Ara, J', citation: '5 SCOB [2015] HCD 1' });

    const hd14 = parseDivisionList(page('list_HD_14.html'), { issue: 14, division: 'HCD' });
    expect(hd14).toHaveLength(16);
    expect(hd14[0]).toMatchObject({ authoringJudge: 'SYED REFAAT AHMED, J', pdfUrl: 'https://www.supremecourt.gov.bd/resources/bulletin/14_SCOB_HD_1.pdf' });
  });

  it('issue 1 lists only case numbers: kept as caseNumber, parties and citation left for the PDF', () => {
    const rows = parseDivisionList(page('list_AD_1.html'), { issue: 1, division: 'AD' });
    expect(rows).toHaveLength(7);
    expect(rows[1]).toMatchObject({ parties: '', citation: null, caseNumber: 'CIVIL APPEAL NO.73 OF 2012' });
    expect(rows.every((r) => r.caseNumber && !r.citation)).toBe(true);
    // Rows that do name the parties have no caseNumber.
    expect(parseDivisionList(page('list_AD_5.html'), { issue: 5, division: 'AD' }).every((r) => r.caseNumber === null)).toBe(true);
  });

  it('ratioParagraphs reads the forms seen in lists', () => {
    expect(ratioParagraphs('… (Para93)')).toEqual(['93']);
    expect(ratioParagraphs('… (Para26 & 27) and (Para 13)')).toEqual(['26', '27', '13']);
    expect(ratioParagraphs('(Paras 10-12)')).toEqual(['10', '11', '12']);
    expect(ratioParagraphs('no paragraph here (Para)')).toEqual([]);
  });
});

describe('parseJudgmentHeader (pdftotext -layout, pages 1–4)', () => {
  it('reads decision date, hearing dates, case numbers and bench across issues, divisions and formats', () => {
    expect(header('ad20_1')).toMatchObject({
      decisionDate: '2025-01-15',
      hearingDates: ['2025-01-07', '2025-01-08', '2025-01-09', '2025-01-14'],
      bench: ['Mr. Justice Syed Refaat Ahmed, Chief Justice', 'Mr. Justice Md. Ashfaqul Islam', 'Mr. Justice Zubayer Rahman Chowdhury', 'Mr. Justice Md. Rezaul Haque', 'Mr. Justice S. M. Emdadul Hoque'],
    });
    expect(header('ad20_1').caseNumbers[0]).toBe('CRIMINAL APPEAL NO. 64 OF 2024');
    expect(header('ad20_1').citation).toBe('20 SCOB [2025] AD');
    expect(header('ad5_1').citation).toBe('5 SCOB [2015] AD');
    expect(header('hd14_1').citation).toBe('14 SCOB [2020] HCD');
    // Two-column header where plain text extraction separates labels from values.
    expect(header('ad20_3')).toMatchObject({ decisionDate: '2025-02-20', caseNumbers: expect.arrayContaining(['CIVIL APPEAL NO. 84, 85 & 86 OF 2024']) });
    // dd.mm.yyyy, values continued on the next lines.
    expect(header('ad5_1')).toMatchObject({ decisionDate: '2013-04-30' });
    expect(header('ad5_1').hearingDates).toHaveLength(12);
    expect(header('ad5_1').bench[0]).toBe('Mr. Justice Md. Muzammel Hossain');
    // "Judgment on: 25.8.2019" in the right column.
    expect(header('hd14_1')).toMatchObject({ decisionDate: '2019-08-25', caseNumbers: ['WRIT PETITION NO. 1774 OF 2017'] });
    expect(header('hd20_1')).toMatchObject({ decisionDate: '2024-12-17', caseNumbers: ['WRIT PETITION NO. 9935 OF 2024', 'WRIT PETITION NO. 12431 OF 2024'], bench: ['Mrs. Justice Farah Mahbub', 'Mr. Justice Debasish Roy Chowdhury'] });
    expect(header('hd5_2')).toMatchObject({ decisionDate: '2015-06-18', hearingDates: ['2015-06-16'], caseNumbers: ['WRIT PETITION NO. 9299 OF 2014'] });
  });

  it('gives null rather than guessing when there is no judgment date', () => {
    expect(parseJudgmentHeader('Present:\nMr. Justice A\n\nNo dates here')).toMatchObject({ decisionDate: null, hearingDates: [] });
    expect(parseJudgmentHeader('Date of Judgment : 31.02.2015')).toMatchObject({ decisionDate: null }); // impossible date
  });

  // Header layouts seen in the full SCOB load (issues 1–20), as `pdftotext -layout` prints them.
  const date = (text: string) => parseJudgmentHeader(text).decisionDate;
  const col = (left: string, right: string) => `${left.padEnd(60)}${right}`;

  it('written dates: ordinals, "day of", month first, spaced ordinals', () => {
    expect(date('Date of Judgment: 11th March, 2015.')).toBe('2015-03-11');
    expect(date(col('Md. Rahim', 'Judgment on the 14th May, 2015'))).toBe('2015-05-14');
    expect(date('Date of judgment       :The 18th day of September, 2013')).toBe('2013-09-18');
    expect(date(col('Ahmed Services Limited', 'Judgment on: The 14 th December, 2014'))).toBe('2014-12-14');
    expect(date('Judgment on: March 3, 2016')).toBe('2016-03-03');
  });

  it('label variants: hearing and judgment together, "dated", no space, "and/& judgment on"', () => {
    expect(date(col('Tejgaon Circle-1, Banani, Dhaka', 'Date of hearing and judgment :    18.06.2015.'))).toBe('2015-06-18');
    expect(date('Heard and judgment on 4th August, 2015.')).toBe('2015-08-04');
    expect(date(col('... Opposite Parties', 'Judgment dated: 11.08.2015'))).toBe('2015-08-11');
    expect(date(col('The State', 'Judgmenton:30.07.2015'))).toBe('2015-07-30');
    expect(date([col('Secretary, Ministry of Land', 'Heard on: 30.04.2015'), col('Secretariat, Dhaka & others.', 'and Judgment on: 05.05.2015.')].join('\n'))).toBe('2015-05-05');
    const h = parseJudgmentHeader([col('....Plaintiff -Opposite- parties.', 'Heard on: 25.02.2015 & Judgment on:'), col('', '26.02.2015.')].join('\n'));
    expect(h).toMatchObject({ decisionDate: '2015-02-26', hearingDates: ['2015-02-25'] });
  });

  it('values wrapped onto the next line in the same column, label and value in separate cells', () => {
    const wrapped = [col('', 'Date of judgment       :The 18th September,'), col(' = Versus =', '                    2013')].join('\n');
    expect(date(wrapped)).toBe('2013-09-18');
    // Judgment delivered over several days: the last one.
    expect(date([col('others.', 'Judgment on : 23.02.2015, 25.02.2015,'), col('   ... Respondents', '01.03.2015.')].join('\n'))).toBe('2015-03-01');
    expect(date(' Date of Judgment.                           :   The 4th November, 2015.')).toBe('2015-11-04');
  });

  it('numeric oddities: spaces, comma, a space for the separator, two-digit years', () => {
    expect(date('Judgment on: 03. 12. 2012.')).toBe('2012-12-03');
    expect(date('Judgment on : 13.02,2014')).toBe('2014-02-13');
    expect(date('Judgment on 30.01 2017 and 31.01 2017.')).toBe('2017-01-31');
    expect(date([col('The State', '09.04.2015, 12.04.2015 and Judgment on:'), col('   ...Respondent.', '13.04.15')].join('\n'))).toBe('2015-04-13');
  });

  it('never takes the lower court\'s date, a body sentence or a hearing-only header', () => {
    expect(date('(From the judgment and order dated 2.3.2010 passed by the High Court Division)')).toBeNull();
    expect(date('The High Court Division by its judgment dated 06.03.2013 discharged the Rule.')).toBeNull();
    expect(date(col('=Versus=', 'Date of hearing : 22-04-2015'))).toBeNull();
  });

  it('Bangla labels and digits', () => {
    expect(date(`শুনানি: ১০.০৩.২০১৫\nরা${'য' + String.fromCodePoint(0x09bc)} ঘোষণার তারিখ: ১৮.০৩.২০১৫`)).toBe('2015-03-18');
  });
});
