/**
 * Draft templates (App Flow §10, BE-32). Headings only: the lawyer or judge writes (or later
 * dictates) the content. The header is pre-filled with the case number and court.
 */
export type DraftRole = 'LAWYER' | 'JUDGE';
type Lang = 'BN' | 'EN';
interface Template {
  key: string;
  roles: DraftRole[];
  title: Record<Lang, string>;
  headings: Record<Lang, string[]>;
}

export const DRAFT_TEMPLATES: Template[] = [
  {
    key: 'BAIL_PETITION',
    roles: ['LAWYER'],
    title: { BN: 'জামিনের আবেদন', EN: 'Bail petition' },
    headings: {
      BN: ['আবেদনকারী', 'মামলার সংক্ষিপ্ত বিবরণ', 'জামিনের যুক্তি', 'প্রার্থনা'],
      EN: ['Petitioner', 'Brief facts of the case', 'Grounds for bail', 'Prayer'],
    },
  },
  {
    key: 'LEGAL_NOTICE',
    roles: ['LAWYER'],
    title: { BN: 'আইনি নোটিশ', EN: 'Legal notice' },
    headings: { BN: ['প্রাপক', 'বিষয়', 'ঘটনার বিবরণ', 'দাবি', 'সময়সীমা'], EN: ['To', 'Subject', 'Facts', 'Demand', 'Time limit'] },
  },
  {
    key: 'ARGUMENT_NOTES',
    roles: ['LAWYER'],
    title: { BN: 'যুক্তিতর্কের নোট', EN: 'Argument notes' },
    headings: { BN: ['বিচার্য বিষয়', 'আইনি যুক্তি', 'নজির', 'জবাব'], EN: ['Issues', 'Legal arguments', 'Precedents', 'Rebuttal'] },
  },
  {
    key: 'WITNESS_SUMMARY',
    roles: ['LAWYER'],
    title: { BN: 'সাক্ষীর সারাংশ', EN: 'Witness summary' },
    headings: { BN: ['সাক্ষী', 'জবানবন্দির মূল কথা', 'জেরায় যা এসেছে', 'অসঙ্গতি'], EN: ['Witness', 'Examination-in-chief', 'Cross-examination', 'Inconsistencies'] },
  },
  {
    key: 'PLAINT',
    roles: ['LAWYER'],
    title: { BN: 'আরজি', EN: 'Plaint' },
    headings: { BN: ['পক্ষগণ', 'নালিশের কারণ', 'এখতিয়ার', 'প্রার্থিত প্রতিকার'], EN: ['Parties', 'Cause of action', 'Jurisdiction', 'Relief sought'] },
  },
  {
    key: 'BENCH_NOTES',
    roles: ['JUDGE'],
    title: { BN: 'বেঞ্চ নোট', EN: 'Bench notes' },
    headings: { BN: ['শুনানির তারিখ', 'উপস্থিতি', 'পক্ষদের বক্তব্য', 'পর্যবেক্ষণ'], EN: ['Hearing date', 'Appearance', 'Submissions', 'Observations'] },
  },
  {
    key: 'ORDER_SHEET',
    roles: ['JUDGE'],
    title: { BN: 'আদেশনামা (খসড়া)', EN: 'Draft order sheet' },
    headings: { BN: ['তারিখ', 'আদেশ', 'পরবর্তী তারিখ'], EN: ['Date', 'Order', 'Next date'] },
  },
  {
    key: 'ISSUE_FRAMING',
    roles: ['JUDGE'],
    title: { BN: 'বিচার্য বিষয় গঠন', EN: 'Issue-framing list' },
    headings: { BN: ['অভিযোগের উপাদান', 'বিচার্য বিষয়সমূহ', 'প্রমাণের দায়'], EN: ['Ingredients of the charge', 'Issues', 'Burden of proof'] },
  },
  {
    key: 'JUDGMENT_SUMMARY',
    roles: ['JUDGE'],
    title: { BN: 'রায়ের সারাংশ', EN: 'Judgment summary' },
    headings: { BN: ['ঘটনা', 'বিচার্য বিষয়', 'সাক্ষ্য বিশ্লেষণ', 'সিদ্ধান্ত'], EN: ['Facts', 'Issues', 'Evaluation of evidence', 'Decision'] },
  },
  {
    key: 'BLANK',
    roles: ['LAWYER', 'JUDGE'],
    title: { BN: 'ফাঁকা খসড়া', EN: 'Blank draft' },
    headings: { BN: [], EN: [] },
  },
];

export const templatesFor = (role: DraftRole) => DRAFT_TEMPLATES.filter((t) => t.roles.includes(role));
export const findTemplate = (key: string, role: DraftRole) => templatesFor(role).find((t) => t.key === key) ?? null;

/** Minimal HTML escaping for values interpolated into a template (case number, court). */
export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderTemplate(t: Template, lang: Lang, c: { caseNumber: string | null; court: string | null; title: string | null }): string {
  const label = lang === 'BN' ? { caseNo: 'মামলা নং', court: 'আদালত / থানা', case: 'মামলা' } : { caseNo: 'Case no.', court: 'Court / Thana', case: 'Case' };
  const meta = [
    c.title ? `<p><strong>${label.case}:</strong> ${escapeHtml(c.title)}</p>` : '',
    c.caseNumber ? `<p><strong>${label.caseNo}:</strong> ${escapeHtml(c.caseNumber)}</p>` : '',
    c.court ? `<p><strong>${label.court}:</strong> ${escapeHtml(c.court)}</p>` : '',
  ].join('');
  const body = t.headings[lang].map((h) => `<h2>${escapeHtml(h)}</h2><p></p>`).join('');
  return `<h1>${escapeHtml(t.title[lang])}</h1>${meta}${body || '<p></p>'}`;
}
