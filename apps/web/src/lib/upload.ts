import { isProblem, type paths } from '@lawassist/contracts';
import { api, unwrap } from './api';

/** Mirrors the API's upload policy (TRD §8.1, §12.6); the API checks again, including magic bytes. */
export const UPLOAD_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};
const BY_EXTENSION: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
export const MAX_UPLOAD_MB = 25;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const ACCEPT = '.pdf,.jpg,.jpeg,.png,.docx,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const SCANNABLE_TYPES = ['FIR_SCAN', 'CHARGE_SHEET', 'SEIZURE_LIST', 'COURT_ORDER'] as const;
export type ScannableType = (typeof SCANNABLE_TYPES)[number];

type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
export type RegisteredArtifact = Json<paths['/api/v1/cases/{id}/documents/scan']['post']['responses'][202]>;

export type UploadErrorCode = 'UNSUPPORTED_TYPE' | 'TOO_LARGE' | 'EMPTY_FILE' | 'UPLOAD_FAILED' | 'ABORTED';
export class UploadError extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code);
    this.name = 'UploadError';
  }
}

/** The content type to declare: the browser's, or from the extension when the browser gives none. */
export function contentTypeOf(file: Pick<File, 'type' | 'name'>): string | null {
  if (file.type && UPLOAD_TYPES[file.type]) return file.type;
  if (file.type && file.type !== 'application/octet-stream') return null;
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return BY_EXTENSION[ext] ?? null;
}

/** Inline validation before anything is sent (App Flow §9.2). */
export function validateFile(file: Pick<File, 'type' | 'name' | 'size'>): UploadErrorCode | null {
  if (!contentTypeOf(file)) return 'UNSUPPORTED_TYPE';
  if (file.size === 0) return 'EMPTY_FILE';
  if (file.size > MAX_UPLOAD_BYTES) return 'TOO_LARGE';
  return null;
}

/** PUT to the presigned URL with progress (fetch has no upload progress, XMLHttpRequest does). */
export function putWithProgress(url: string, file: Blob, headers: Record<string, string>, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    // Content-Length is set by the browser (and may not be set by scripts); the rest are signed.
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'content-length') xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadError('UPLOAD_FAILED')));
    xhr.onerror = () => reject(new UploadError('UPLOAD_FAILED'));
    xhr.onabort = () => reject(new UploadError('ABORTED'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export interface UploadOptions {
  caseId: string;
  file: File;
  artifactType: ScannableType;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  put?: typeof putWithProgress;
}

/**
 * Upload flow (TRD §8.1): presigned URL from the API → the file goes straight to object storage
 * (never through the API) → the API registers it, checks size and magic bytes, and queues the scan.
 */
export async function uploadDocument({ caseId, file, artifactType, onProgress = () => undefined, signal, put = putWithProgress }: UploadOptions): Promise<RegisteredArtifact> {
  const invalid = validateFile(file);
  if (invalid) throw new UploadError(invalid);
  const contentType = contentTypeOf(file)!;
  const target = await unwrap(
    api.POST('/api/v1/cases/{id}/documents/upload-url', { params: { path: { id: caseId } }, body: { content_type: contentType as never, size_bytes: file.size } }),
  );
  await put(target.upload_url, file, target.headers, onProgress, signal);
  onProgress(1);
  return unwrap(api.POST('/api/v1/cases/{id}/documents/scan', { params: { path: { id: caseId } }, body: { s3_key: target.s3_key, artifact_type: artifactType } }));
}

/** Message key for an upload failure: our own codes, the API's problem codes, or generic. */
export function uploadErrorKey(err: unknown): string {
  if (err instanceof UploadError) return err.code;
  if (err instanceof TypeError) return 'NETWORK';
  if (isProblem(err)) return ['UPLOAD_TOO_LARGE', 'UPLOAD_TYPE_MISMATCH', 'UPLOAD_CONTENT_INVALID', 'UPLOAD_NOT_FOUND', 'RATE_LIMITED'].includes(err.code) ? err.code : 'generic';
  return 'generic';
}
