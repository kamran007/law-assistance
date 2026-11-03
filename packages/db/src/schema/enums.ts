/** Enum value lists shared by the schema, API contracts and tests (TRD §4.2). */
export const USER_ROLES = ['CITIZEN', 'LAWYER', 'JUDGE', 'ADMIN'] as const;
export const VERIFICATION_STATUSES = ['NOT_REQUIRED', 'PENDING', 'VERIFIED', 'REJECTED'] as const;
export const LANGUAGES = ['BN', 'EN'] as const;

export const STATUTE_STATUSES = ['ACTIVE', 'REPEALED'] as const;
export const VALID_FROM_SOURCES = ['AMENDMENT_FOOTNOTE', 'ENACTMENT_DATE', 'DETECTED_ON_SYNC'] as const;

export const ARTIFACT_TYPES = [
  'FIR_SCAN',
  'CHARGE_SHEET',
  'SEIZURE_LIST',
  'COURT_ORDER',
  'VOICE_DICTATION_DRAFT',
  'COURT_ORDER_NOTE',
  'GD_DRAFT',
] as const;
export const PROCESSING_STATUSES = [
  'UPLOADED',
  'OCR',
  'EXTRACTING',
  'SCHEDULE_LOOKUP',
  'ANALYZING',
  'READY',
  'FAILED',
] as const;

export const MESSAGE_ROLES = ['USER', 'ASSISTANT'] as const;
export const INPUT_MODES = ['TEXT', 'VOICE'] as const;
export const MESSAGE_STATUSES = ['COMPLETE', 'INTERRUPTED', 'NO_PROVISION', 'ERROR'] as const;

export const OTP_CHANNELS = ['SMS', 'EMAIL'] as const;
export const CREDENTIAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export const SCRAPE_RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'QUARANTINED'] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
