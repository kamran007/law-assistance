import { describe, expect, it } from 'vitest';
import { sanitizeDraftHtml } from '../src/modules/drafts/sanitize';
import { escapeHtml, findTemplate, renderTemplate } from '../src/modules/drafts/templates';

describe('sanitizeDraftHtml', () => {
  it('keeps the editor structure and drops scripts, handlers, styles, iframes and links', () => {
    expect(sanitizeDraftHtml('<h2>Grounds</h2><ol start="2"><li><strong>One</strong></li></ol><blockquote><p>q</p></blockquote>')).toBe(
      '<h2>Grounds</h2><ol start="2"><li><strong>One</strong></li></ol><blockquote><p>q</p></blockquote>',
    );
    expect(sanitizeDraftHtml('<p style="color:red" onmouseover="x()">a<style>p{}</style><iframe src="//evil"></iframe></p>')).toBe('<p>a</p>');
    expect(sanitizeDraftHtml('<svg onload="alert(1)"><p>b</p></svg>')).toBe('<p>b</p>');
  });

  it('keeps Bangla text intact', () => {
    expect(sanitizeDraftHtml('<p>দণ্ডবিধির ৩২৩ ধারা</p>')).toBe('<p>দণ্ডবিধির ৩২৩ ধারা</p>');
  });
});

describe('templates', () => {
  it('render escapes case values and omits missing ones', () => {
    const evil = '"><script>';
    const html = renderTemplate(findTemplate('ORDER_SHEET', 'JUDGE')!, 'EN', { caseNumber: evil, court: null, title: null });
    expect(html).toBe(`<h1>Draft order sheet</h1><p><strong>Case no.:</strong> ${escapeHtml(evil)}</p><h2>Date</h2><p></p><h2>Order</h2><p></p><h2>Next date</h2><p></p>`);
    expect(html).not.toContain('<script>');
    expect(findTemplate('ORDER_SHEET', 'LAWYER')).toBeNull();
  });
});
