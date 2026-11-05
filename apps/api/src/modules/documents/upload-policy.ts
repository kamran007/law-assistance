import { fileTypeFromBuffer } from 'file-type';

/**
 * What may be uploaded for scanning (TRD §8.1, §12.6): PDF, JPEG, PNG or DOCX, at most 25 MB.
 * The extension in the storage key comes from the declared type, never from a client file name.
 */
export const UPLOAD_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
} as const;

export type UploadContentType = keyof typeof UPLOAD_TYPES;
export const UPLOAD_CONTENT_TYPES = Object.keys(UPLOAD_TYPES) as [UploadContentType, ...UploadContentType[]];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
/** Enough bytes for file-type to recognise every allowed format, DOCX included. */
export const MAGIC_BYTES_TO_READ = 4100;

/** Artifact types that come from a scan or an upload; drafts are created elsewhere (BE-32). */
export const SCANNABLE_TYPES = ['FIR_SCAN', 'CHARGE_SHEET', 'SEIZURE_LIST', 'COURT_ORDER'] as const;

/** `tenants/{user_id}/cases/{case_id}/{artifact_id}/original.{ext}` (TRD §8.1). */
export function uploadKey(userId: string, caseId: string, artifactId: string, contentType: UploadContentType): string {
  return `tenants/${userId}/cases/${caseId}/${artifactId}/original.${UPLOAD_TYPES[contentType]}`;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- built from a constant
const KEY_PATTERN = new RegExp(`^tenants/(${UUID})/cases/(${UUID})/(${UUID})/original\\.(pdf|jpg|png|docx)$`);

/**
 * Parses a key the client sends back at registration. Returns null unless it is exactly the shape
 * we hand out AND belongs to this user and case, so a client can never register another user's
 * object (or any other key in the bucket) as its own document.
 */
export function parseOwnUploadKey(key: string, userId: string, caseId: string): { artifactId: string; contentType: UploadContentType } | null {
  const m = KEY_PATTERN.exec(key);
  if (!m || m[1] !== userId || m[2] !== caseId) return null;
  const ext = m[4]!;
  const contentType = (Object.entries(UPLOAD_TYPES) as [UploadContentType, string][]).find(([, e]) => e === ext)![0];
  return { artifactId: m[3]!, contentType };
}

/** True if the file's first bytes are really the declared format (a renamed .exe is not a PDF). */
export async function magicBytesMatch(head: Uint8Array, declared: UploadContentType): Promise<boolean> {
  const detected = await fileTypeFromBuffer(head);
  return detected?.mime === declared;
}
