/**
 * Acts commonly cited in FIRs, charge sheets and court orders, with the names and abbreviations
 * people actually write (TRD §8.4). `bdlawsActId` links to `statutes.bdlaws_act_id`. Patterns are
 * matched case-insensitively against NFC text; longer matches win over overlapping shorter ones
 * ("Cr.P.C." is never also read as "P.C.").
 */
export interface ActEntry {
  key: string;
  bdlawsActId: number;
  name: string;
  /** Regex sources. Bangla names usually carry a suffix (দণ্ডবিধির, আইনের), so they are prefixes. */
  patterns: string[];
}

export const ACT_DICTIONARY: readonly ActEntry[] = [
  {
    key: 'PENAL_CODE',
    bdlawsActId: 11,
    name: 'The Penal Code, 1860',
    patterns: [
      'দণ্ডবিধি',
      'দন্ডবিধি',
      'দণ্ড বিধি',
      'দন্ড বিধি',
      'দঃ\\s?বিঃ',
      'দ:\\s?বি:',
      'পেনাল\\s?কোড',
      '(?:bangladesh\\s+)?penal\\s+code',
      '\\bP\\.\\s?C\\.?(?![A-Za-z])',
      '\\bPC\\b',
    ],
  },
  {
    key: 'CRPC',
    bdlawsActId: 75,
    name: 'The Code of Criminal Procedure, 1898',
    patterns: ['ফৌজদারি\\s?কার্যবিধি', 'ফৌজদারী\\s?কার্যবিধি', 'ফৌঃ\\s?কাঃ\\s?বিঃ', 'code\\s+of\\s+criminal\\s+procedure', '\\bCr\\.?\\s?P\\.?\\s?C\\b\\.?'],
  },
  {
    key: 'NARI_SHISHU',
    bdlawsActId: 835,
    name: 'নারী ও শিশু নির্যাতন দমন আইন, ২০০০',
    patterns: ['নারী\\s?ও\\s?শিশু(?:\\s?নির্যাতন(?:\\s?দমন)?)?', 'নাঃ\\s?ও\\s?শিঃ', 'nari[-\\s]?o[-\\s]?shishu', 'women\\s+and\\s+children\\s+repression'],
  },
  {
    key: 'NARCOTICS_2018',
    bdlawsActId: 1276,
    name: 'মাদকদ্রব্য নিয়ন্ত্রণ আইন, ২০১৮',
    patterns: ['মাদকদ্রব্য\\s?নিয়ন্ত্রণ', 'মাদক\\s?দ্রব্য\\s?নিয়ন্ত্রণ', 'narcotics\\s+control\\s+act'],
  },
  {
    key: 'NI_ACT',
    bdlawsActId: 46,
    name: 'The Negotiable Instruments Act, 1881',
    patterns: ['negotiable\\s+instruments?', '\\bN\\.\\s?I\\.?\\s?Act\\b', '\\bNI\\s+Act\\b', 'হস্তান্তরযোগ্য\\s?দলিল', 'এন\\.?\\s?আই\\.?\\s?(?:এ্যাক্ট|অ্যাক্ট|এক্ট)'],
  },
  { key: 'EVIDENCE', bdlawsActId: 24, name: 'The Evidence Act, 1872', patterns: ['সাক্ষ্য\\s?আইন', 'evidence\\s+act'] },
  { key: 'CPC', bdlawsActId: 86, name: 'The Code of Civil Procedure, 1908', patterns: ['দেওয়ানি\\s?কার্যবিধি', 'দেওয়ানী\\s?কার্যবিধি', 'code\\s+of\\s+civil\\s+procedure', '\\bC\\.\\s?P\\.\\s?C\\.?(?![A-Za-z])', '\\bCPC\\b'] },
  { key: 'ARMS_ACT', bdlawsActId: 38, name: 'The Arms Act, 1878', patterns: ['অস্ত্র\\s?আইন', 'arms\\s+act'] },
  { key: 'SPECIAL_POWERS', bdlawsActId: 462, name: 'The Special Powers Act, 1974', patterns: ['বিশেষ\\s?ক্ষমতা\\s?আইন', 'special\\s+powers\\s+act'] },
  { key: 'EXPLOSIVES', bdlawsActId: 87, name: 'The Explosive Substances Act, 1908', patterns: ['বিস্ফোরক\\s?(?:দ্রব্য\\s?)?আইন', 'explosive\\s+substances\\s+act'] },
  { key: 'DIGITAL_SECURITY_2018', bdlawsActId: 1261, name: 'ডিজিটাল নিরাপত্তা আইন, ২০১৮', patterns: ['ডিজিটাল\\s?নিরাপত্তা', 'digital\\s+security\\s+act'] },
  { key: 'CYBER_SECURITY_2023', bdlawsActId: 1457, name: 'সাইবার নিরাপত্তা আইন, ২০২৩', patterns: ['সাইবার\\s?নিরাপত্তা', 'cyber\\s+security\\s+act'] },
  { key: 'CYBER_SUROKSHA_2025', bdlawsActId: 1538, name: 'সাইবার সুরক্ষা অধ্যাদেশ, ২০২৫', patterns: ['সাইবার\\s?সুরক্ষা', 'cyber\\s+(?:protection|suroksha)\\s+ordinance'] },
  { key: 'DOWRY_2018', bdlawsActId: 1256, name: 'যৌতুক নিরোধ আইন, ২০১৮', patterns: ['যৌতুক\\s?নিরোধ', 'dowry\\s+prohibition'] },
  { key: 'MONEY_LAUNDERING_2012', bdlawsActId: 1088, name: 'মানিলন্ডারিং প্রতিরোধ আইন, ২০১২', patterns: ['মানি\\s?লন্ডারিং', 'money\\s+laundering'] },
  { key: 'HUMAN_TRAFFICKING_2012', bdlawsActId: 1086, name: 'মানব পাচার প্রতিরোধ ও দমন আইন, ২০১২', patterns: ['মানব\\s?পাচার', 'human\\s+trafficking'] },
];

export const DEFAULT_FIR_ACT = ACT_DICTIONARY[0]!; // Penal Code (TRD §8.4: FIRs default to it, flagged)
