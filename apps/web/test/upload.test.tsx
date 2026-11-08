import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en, problem, renderIn, stubApi, type ApiStub } from './helpers';

/** WEB-07: client-side validation, presigned upload flow, upload dialog, live status on the card. */
const { contentTypeOf, validateFile, uploadDocument, MAX_UPLOAD_BYTES, UploadError } = await import('@/lib/upload');
const { UploadDialog } = await import('@/components/documents/upload-dialog');
const { DocumentCard } = await import('@/components/documents/document-card');
const { caseKeys } = await import('@/lib/cases');
type Artifact = import('@/lib/cases').Artifact;

const CASE = '0190a000-0000-7000-8000-0000000000c1';
const ART = '0190a000-0000-7000-8000-0000000000a1';
const KEY = `tenants/u1/cases/${CASE}/${ART}/original.pdf`;
const pdf = (size = 1000, name = 'fir.pdf', type = 'application/pdf') => new File([new Uint8Array(size)], name, { type });
const artifact = (status: string, over: object = {}): Artifact => ({
  artifact_id: ART,
  case_id: CASE,
  artifact_type: 'FIR_SCAN',
  processing_status: status as Artifact['processing_status'],
  processing_error: null,
  mime_type: 'application/pdf',
  page_count: 1,
  ocr_confidence: null,
  version: 1,
  created_at: '2026-11-08T09:00:00Z',
  updated_at: '2026-11-08T09:00:00Z',
  ...over,
});

let api: ApiStub;
beforeEach(() => {
  api = stubApi();
  api.routes[`POST /api/v1/cases/${CASE}/documents/upload-url`] = () =>
    Response.json({ artifact_id: ART, s3_key: KEY, upload_url: 'http://s3.test/put', method: 'PUT', headers: { 'content-type': 'application/pdf', 'content-length': '1000' }, expires_in: 600 });
  api.routes[`POST /api/v1/cases/${CASE}/documents/scan`] = () => Response.json(artifact('UPLOADED'), { status: 202 });
});
afterEach(() => vi.unstubAllGlobals());

describe('validation', () => {
  it('accepts PDF / DOCX / JPG / PNG up to 25 MB, using the extension when the browser gives no type', () => {
    expect(validateFile(pdf())).toBeNull();
    expect(contentTypeOf({ name: 'scan.JPG', type: '' })).toBe('image/jpeg');
    expect(contentTypeOf({ name: 'brief.docx', type: 'application/octet-stream' })).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(validateFile({ name: 'x.exe', type: 'application/x-msdownload', size: 10 })).toBe('UNSUPPORTED_TYPE');
    expect(validateFile({ name: 'evil.pdf', type: 'text/html', size: 10 })).toBe('UNSUPPORTED_TYPE'); // a declared type wins over the name
    expect(validateFile({ name: 'big.pdf', type: 'application/pdf', size: MAX_UPLOAD_BYTES + 1 })).toBe('TOO_LARGE');
    expect(validateFile({ name: 'e.pdf', type: 'application/pdf', size: 0 })).toBe('EMPTY_FILE');
  });
});

describe('uploadDocument', () => {
  it('presigned URL → PUT with the signed headers (not Content-Length) → register; reports progress', async () => {
    const put = vi.fn(async (_url: string, _f: Blob, _h: Record<string, string>, onProgress: (n: number) => void) => onProgress(0.5));
    const progress: number[] = [];
    const created = await uploadDocument({ caseId: CASE, file: pdf(), artifactType: 'CHARGE_SHEET', onProgress: (n) => progress.push(n), put });
    expect(created.artifact_id).toBe(ART);
    expect(put.mock.calls[0]!.slice(0, 1)).toEqual(['http://s3.test/put']);
    expect(api.calls.map((c) => [c.path, c.body])).toEqual([
      [`/api/v1/cases/${CASE}/documents/upload-url`, { content_type: 'application/pdf', size_bytes: 1000 }],
      [`/api/v1/cases/${CASE}/documents/scan`, { s3_key: KEY, artifact_type: 'CHARGE_SHEET' }],
    ]);
    expect(progress).toEqual([0.5, 1]);
  });

  it('refuses an invalid file without any request, and surfaces API problems', async () => {
    await expect(uploadDocument({ caseId: CASE, file: pdf(10, 'x.exe', 'application/x-msdownload'), artifactType: 'FIR_SCAN' })).rejects.toEqual(new UploadError('UNSUPPORTED_TYPE'));
    expect(api.calls).toEqual([]);
    api.routes[`POST /api/v1/cases/${CASE}/documents/scan`] = () => problem(422, 'UPLOAD_TYPE_MISMATCH');
    await expect(uploadDocument({ caseId: CASE, file: pdf(), artifactType: 'FIR_SCAN', put: async () => undefined })).rejects.toMatchObject({ code: 'UPLOAD_TYPE_MISMATCH' });
  });
});

describe('UploadDialog', () => {
  it('shows an inline error for an unsupported or oversized file and keeps Upload disabled', async () => {
    renderIn(<UploadDialog caseId={CASE} onClose={() => undefined} />);
    const input = screen.getByLabelText(en.cases.upload.choose) as HTMLInputElement;
    // userEvent.upload honours `accept`; fireEvent simulates a browser that lets any file through.
    fireEvent.change(input, { target: { files: [pdf(10, 'notes.txt', 'text/plain')] } });
    expect(screen.getByRole('alert').textContent).toBe(en.cases.upload.errors.UNSUPPORTED_TYPE);
    expect(screen.getByRole('button', { name: en.cases.upload.upload }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(input, { target: { files: [pdf(MAX_UPLOAD_BYTES + 1)] } });
    expect(screen.getByRole('alert').textContent).toBe(en.cases.upload.errors.TOO_LARGE.replace('{mb}', '25'));
  });

  it('uploads a dropped file as the chosen type, adds it to the list and closes', async () => {
    const xhrs: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    class FakeXhr {
      upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
      status = 200;
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      private url = '';
      private headers: Record<string, string> = {};
      open(_m: string, url: string) {
        this.url = url;
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      send(body: unknown) {
        xhrs.push({ url: this.url, headers: this.headers, body });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 500, total: 1000 });
        queueMicrotask(() => this.onload?.());
      }
      abort() {
        this.onabort?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(caseKeys.artifacts(CASE), []);
    api.routes[`GET /api/v1/cases/${CASE}/artifacts`] = () => Response.json({ items: [artifact('UPLOADED')] });
    render(
      <QueryClientProvider client={qc}>
        <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Dhaka">
          <UploadDialog caseId={CASE} onClose={onClose} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    fireEvent.drop(screen.getByText(en.cases.upload.dropHere), { dataTransfer: { files: [pdf()] } });
    expect(screen.getByText('fir.pdf')).toBeTruthy();
    await userEvent.click(screen.getByLabelText(en.cases.documents.types.SEIZURE_LIST));
    await userEvent.click(screen.getByRole('button', { name: en.cases.upload.upload }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(xhrs).toEqual([{ url: 'http://s3.test/put', headers: { 'content-type': 'application/pdf' }, body: expect.any(File) }]);
    expect(api.calls.find((c) => c.path.endsWith('/scan'))!.body).toEqual({ s3_key: KEY, artifact_type: 'SEIZURE_LIST' });
    expect((qc.getQueryData(caseKeys.artifacts(CASE)) as Artifact[]).map((a) => a.artifact_id)).toEqual([ART]);
  });
});

describe('DocumentCard live status', () => {
  const sse = (...statuses: string[]) => {
    const body = statuses.map((s, i) => `event: status\nid: ${i + 1}\ndata: ${JSON.stringify({ artifact_id: ART, status: s, error: s === 'FAILED' ? 'OCR_FAILED' : null, at: 't' })}\n\n`).join('');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const renderCard = (qc: QueryClient, a: Artifact, deps: object = {}) =>
    render(
      <QueryClientProvider client={qc}>
        <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Dhaka">
          <ul>
            <Card qc={qc} a={a} deps={deps} />
          </ul>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  // Re-reads the cached artifact so status updates re-render the card, as the Documents tab does.
  function Card({ qc, a, deps }: { qc: QueryClient; a: Artifact; deps: object }) {
    const list = (qc.getQueryData(caseKeys.artifacts(CASE)) as Artifact[] | undefined) ?? [a];
    return <DocumentCard caseId={CASE} artifact={list[0]!} onUploadAgain={() => undefined} streamDeps={deps} />;
  }

  it('follows the SSE stream step by step into the cached list until READY', async () => {
    const qc = new QueryClient();
    qc.setQueryData(caseKeys.artifacts(CASE), [artifact('UPLOADED')]);
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).accept).toBe('text/event-stream');
      return sse('OCR', 'EXTRACTING', 'ANALYZING', 'READY');
    });
    renderCard(qc, artifact('UPLOADED'), { fetch });
    await waitFor(() => expect((qc.getQueryData(caseKeys.artifacts(CASE)) as Artifact[])[0]!.processing_status).toBe('READY'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`http://localhost:3000/api/v1/cases/${CASE}/artifacts/${ART}/events`);
  });

  it('a finished document opens no stream; a failed one says so and offers to upload again', () => {
    const fetch = vi.fn();
    renderCard(new QueryClient(), artifact('FAILED'), { fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(en.cases.documents.failed);
    expect(screen.getByRole('button', { name: en.cases.documents.uploadAgain })).toBeTruthy();
  });

  it('falls back to polling the list when the stream is unavailable', async () => {
    const qc = new QueryClient();
    let reads = 0;
    qc.setQueryDefaults(caseKeys.artifacts(CASE), { queryFn: async () => [artifact(++reads >= 2 ? 'READY' : 'EXTRACTING')] });
    qc.setQueryData(caseKeys.artifacts(CASE), [artifact('OCR')]);
    renderCard(qc, artifact('OCR'), { fetch: async () => problem(503, 'UNAVAILABLE'), pollMs: 20 });
    await waitFor(() => expect((qc.getQueryData(caseKeys.artifacts(CASE)) as Artifact[])[0]!.processing_status).toBe('READY'), { timeout: 2000 });
    expect(reads).toBe(2); // polled until terminal, then stopped
  });
});
