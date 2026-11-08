# SCOB harvester (Module D)

Source: **Supreme Court Online Bulletin** (`https://www.supremecourt.gov.bd/web/?page=bulletin.php&menu=10&lang=`),
SRS §4.4, TRD §6A. Code: `source-config.ts` (URLs, patterns), `decode.ts`, `list-parser.ts`,
`pdf-metadata.ts`. Fixtures: `apps/worker/test/fixtures/scob/`.

## JUD-01 spike (2026-11-08)

Checked from this network: the site answers in about 1 s. **No `robots.txt`** (404). Requests were
spaced 3 s apart with the crawler's generic user agent. Fetched: the index, all 40 division lists
(20 issues × AD / HCD; 7 kept as fixtures) and 6 judgment PDFs (not committed; headers kept as text).
The production crawl still waits for **PRE-11** (site terms).

### Index
One link per issue and division, and a full-issue PDF `../resources/bulletin/{issue}_SCOB_{year}.pdf`,
for issues **1 (2015) to 20 (2025)**. Lists:
- issues **1–14**: generic template `?page=bulletin/bulletin_list.php&menu=00&div_id={1|2}&issue={n}`
- issues **15+**: per-issue page `?page=bulletin/bulletin_list_{AD|HD}_{n}.php&menu=00&div_id={1|2}&issue={n}`

`div_id` 1 = Appellate Division, 2 = High Court Division. Each list is one page, no pagination.

### Judgments per issue (all lists parsed, 2026-11-08): **456** (AD 132, HCD 324)

| Issue | Year | AD | HCD | | Issue | Year | AD | HCD |
| ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 2015 | 7 | 23 | | 11 | 2019 | 3 | 13 |
| 2 | 2015 | 6 | 19 | | 12 | 2019 | 4 | 20 |
| 3 | 2015 | 6 | 21 | | 13 | 2020 | 4 | 13 |
| 4 | 2015 | 6 | 16 | | 14 | 2020 | 5 | 16 |
| 5 | 2015 | 5 | 15 | | 15 | 2021 | 7 | 10 |
| 6 | 2016 | 6 | 13 | | 16 | 2022 | 14 | 16 |
| 7 | 2016 | 6 | 15 | | 17 | 2023 | 8 | 16 |
| 8 | 2016 | 6 | 16 | | 18 | 2023 | 7 | 16 |
| 9 | 2017 | 8 | 15 | | 19 | 2024 | 8 | 18 |
| 10 | 2018 | 4 | 20 | | 20 | 2025 | 8 | 17 |

### List templates
- **Newer (15+), 4 cells:** serial · parties (PDF link) + `(Judge, J)` + citation (`20 SCOB [2025] AD`) +
  `Key Words:` … · summary · key ratio with paragraph refs `(Para93)`, `(Para26 & 27)`.
- **Older (1–14), 6 cells:** serial · issue · year · parties + citation in the link (`5 SCOB[2015]AD 1`,
  with the page number) · key words (one per line) · short ratio. No summary; no paragraph refs; the
  judge is sometimes appended to the parties (`… and ors (Zinat Ara, J)`).
- **Issue 1** lists the **case number instead of parties and citation** (`CIVIL APPEAL NO.73 OF 2012`);
  a few rows in issues 10 and 11 likewise have no citation. Parties and citation then come from the PDF
  (`parseJudgmentHeader().citation`).

### Surprises (differences from SRS §4.4)
1. **PDF file names are not predictable:** `20/1. 20 SCOB AD-1.pdf`, `20/01. 20 SCOB HCD.pdf`,
   `5_SCOB_AD_1.pdf`, `5_SCOB_HCD_1.pdf`, `14_SCOB_HD_1.pdf`. The crawler takes each href from its row
   and never builds it.
2. **Mixed encoding:** pages declare UTF-8, but older rows contain raw Windows-1252 bytes (curly quotes,
   dashes). `decodeMixedUtf8` keeps valid UTF-8 and reads stray bytes as Windows-1252; all 40 lists
   then decode without U+FFFD.
3. Citations are not uniform (`5 SCOB[2015]AD 1`, `14 SCOB [2020] HCD`); they are stored as published
   and normalised only for matching.

### PDFs (6 samples: issues 5, 14, 20; both divisions)
All six have a **text layer** (English; Times New Roman / CID TrueType; producers doPDF, Ghostscript,
"Microsoft: Print To PDF"), 3 to 87 pages, 21 KB to 4.3 MB. No OCR was needed for these; the share of
scanned or Bangla judgments across all 456 is measured when JUD-04 runs over everything.

Page 1 carries the running head (citation, parties, judge), bench (`Present:`), case number(s) and
dates. **Use `pdftotext -layout` for the header** (pages 1–4): plain mode splits two-column headers so
"Date of Judgment" and its value are no longer adjacent (20 SCOB AD-3). Date formats seen:
`Date of Judgment : 15-01-2025`, `: 30.04.2013.`, `Judgment on: 25.8.2019` (right column), hearing
dates continued over several lines. Paragraphs are numbered `1.`, `2.` … at line start, which fits
paragraph-aware chunking (JUD-06).
