import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3DocumentStorage } from '../src/modules/documents/storage';
import { magicBytesMatch, parseOwnUploadKey, uploadKey } from '../src/modules/documents/upload-policy';
import { SAMPLES } from './helpers/samples';

const user = '01a1a65e-c1d7-708a-b4ab-6b2e12294c58';
const other = '01a1a65e-0000-708a-b4ab-6b2e12294c58';
const caseId = '01a1a65e-1111-708a-b4ab-6b2e12294c58';
const art = '01a1a65e-2222-708a-b4ab-6b2e12294c58';


describe('upload keys', () => {
  it('builds the TRD key layout with an extension from the declared type', () => {
    expect(uploadKey(user, caseId, art, 'application/pdf')).toBe(`tenants/${user}/cases/${caseId}/${art}/original.pdf`);
    expect(uploadKey(user, caseId, art, 'image/jpeg')).toMatch(/original\.jpg$/);
  });

  it('accepts only its own shape, for this user and this case', () => {
    const key = uploadKey(user, caseId, art, 'image/png');
    expect(parseOwnUploadKey(key, user, caseId)).toEqual({ artifactId: art, contentType: 'image/png' });
    expect(parseOwnUploadKey(key, other, caseId)).toBeNull(); // someone else's upload
    expect(parseOwnUploadKey(key, user, other)).toBeNull(); // another case
    expect(parseOwnUploadKey(`tenants/${user}/cases/${caseId}/../${art}/original.pdf`, user, caseId)).toBeNull();
    expect(parseOwnUploadKey(`raw/bdlaws/11/x.html.gz`, user, caseId)).toBeNull();
    expect(parseOwnUploadKey(`${key}.exe`, user, caseId)).toBeNull();
    expect(parseOwnUploadKey(key.replace('.png', '.exe'), user, caseId)).toBeNull();
  });
});

describe('magic bytes', () => {
  it('recognises each allowed format', async () => {
    expect(await magicBytesMatch(SAMPLES.pdf, 'application/pdf')).toBe(true);
    expect(await magicBytesMatch(SAMPLES.png, 'image/png')).toBe(true);
    expect(await magicBytesMatch(SAMPLES.jpg, 'image/jpeg')).toBe(true);
    expect(await magicBytesMatch(SAMPLES.docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });

  it('rejects files whose content is not the declared type', async () => {
    expect(await magicBytesMatch(SAMPLES.exe, 'application/pdf')).toBe(false);
    expect(await magicBytesMatch(SAMPLES.png, 'image/jpeg')).toBe(false);
    expect(await magicBytesMatch(new TextEncoder().encode('<html>not a pdf</html>'), 'application/pdf')).toBe(false);
    expect(await magicBytesMatch(new Uint8Array(), 'application/pdf')).toBe(false);
  });
});

describe('presigned upload URL', () => {
  const s3 = new S3Client({ region: 'ap-south-1', endpoint: 'http://localhost:9000', forcePathStyle: true, credentials: { accessKeyId: 'a', secretAccessKey: 'b' } });

  it('signs Content-Type and Content-Length so S3 rejects another type or size', async () => {
    const storage = new S3DocumentStorage(s3, 'bucket', undefined);
    const p = await storage.presignPut('tenants/u/cases/c/a/original.pdf', 'application/pdf', 1234, 600);
    const url = new URL(p.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')!.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(p.headers).toEqual({ 'content-type': 'application/pdf', 'content-length': '1234' });
  });

  it('requires and signs the SSE header when the bucket demands encryption', async () => {
    const storage = new S3DocumentStorage(s3, 'bucket', 'aws:kms');
    const p = await storage.presignPut('k', 'image/png', 10, 600);
    const url = new URL(p.url);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('x-amz-server-side-encryption');
    expect(url.searchParams.has('x-amz-server-side-encryption')).toBe(false); // a header, not a query param
    expect(p.headers['x-amz-server-side-encryption']).toBe('aws:kms');
  });
});
