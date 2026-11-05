import { describe, expect, it } from 'vitest';
import { looksLikeBijoy } from '../src/bijoy';

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
});
