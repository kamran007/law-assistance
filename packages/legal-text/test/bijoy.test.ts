import { describe, expect, it } from 'vitest';
import { englishWordShare, looksLikeBijoy } from '../src/bijoy';

/** "আমার সোনার বাংলা, আমি তোমায় ভালোবাসি" typed in SutonnyMJ, as text extraction returns it. */
const BIJOY_SONG = 'Avgvi †mvbvi evsjv, Avwg †Zvgvq fv‡jvevwm';
/** "বাংলাদেশ দণ্ডবিধি ধারা ৪২০" in Bijoy. */
const BIJOY_LAW = 'evsjv‡`k `Ûwewa aviv 420 Abyhvqx cÖZviYv';

describe('looksLikeBijoy', () => {
  it('flags Bijoy text by its Latin-1 marks when there is no Bengali script', () => {
    expect(looksLikeBijoy({ text: BIJOY_SONG })).toBe(true);
    expect(looksLikeBijoy({ text: BIJOY_LAW })).toBe(true);
  });

  it('flags documents whose fonts are Bijoy fonts, including PDF subset prefixes', () => {
    expect(looksLikeBijoy({ text: 'abc', fontNames: ['ABCDEF+SutonnyMJ'] })).toBe(true);
    expect(looksLikeBijoy({ text: 'abc', fontNames: ['AdorshoLipiMJ-Bold'] })).toBe(true);
    expect(looksLikeBijoy({ text: 'abc', fontNames: ['TimesNewRomanPSMT', 'NikoshBAN'] })).toBe(false);
  });

  it('does not flag Unicode Bangla, English, or short noise', () => {
    expect(looksLikeBijoy({ text: 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি' })).toBe(false);
    expect(looksLikeBijoy({ text: 'Whoever cheats and thereby dishonestly induces the person deceived © 2026' })).toBe(false);
    expect(looksLikeBijoy({ text: '†' })).toBe(false);
    // Mixed: a Unicode document that quotes one Bijoy word is still Unicode.
    expect(looksLikeBijoy({ text: `ধারা ৪২০ ${BIJOY_SONG}` })).toBe(false);
  });

  it('an English document that embeds a Bijoy font (a Bangla quote, a letterhead) is not Bijoy', () => {
    // A SCOB judgment header: English, but the PDF carries SutonnyMJ for one quoted line.
    const judgment =
      'Heard on 29.04.2015, 30.04.2015 and Judgment on 18.05.2015. This Rule was issued calling upon the respondents to show cause as to why the order passed by the respondent No. 1 should not be declared to have been made without lawful authority and is of no legal effect. The petitioner is a company incorporated under the laws of Bangladesh.';
    expect(looksLikeBijoy({ text: judgment, fontNames: ['ABCDEF+SutonnyMJ', 'TimesNewRomanPSMT'] })).toBe(false);
    expect(englishWordShare(judgment)).toBeGreaterThan(0.2);
    // Bijoy text with the same font is still Bijoy; its "words" are not English function words.
    const bijoyPage = Array.from({ length: 8 }, () => `${BIJOY_SONG} ${BIJOY_LAW}`).join(' ');
    expect(englishWordShare(bijoyPage)).toBeLessThan(0.05);
    expect(looksLikeBijoy({ text: bijoyPage, fontNames: ['SutonnyMJ'] })).toBe(true);
  });
});
