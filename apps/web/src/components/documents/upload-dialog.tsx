'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { caseKeys } from '@/lib/cases';
import { ACCEPT, MAX_UPLOAD_MB, SCANNABLE_TYPES, uploadDocument, uploadErrorKey, validateFile, type ScannableType } from '@/lib/upload';

/**
 * Upload modal (App Flow §9.2): pick or drop a PDF / DOCX / JPG / PNG, choose the document type,
 * upload with progress. Invalid files are refused inline before anything is sent.
 */
export function UploadDialog({ caseId, initialFile, onClose }: { caseId: string; initialFile?: File | null; onClose: () => void }) {
  const t = useTranslations('cases.upload');
  const tt = useTranslations('cases.documents.types');
  const qc = useQueryClient();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [type, setType] = useState<ScannableType>('FIR_SCAN');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(initialFile ? validateFile(initialFile) : null);
  const [dragging, setDragging] = useState(false);
  const uploading = progress !== null;

  // Focus the dialog, close on Escape (unless an upload is running), cancel an upload on unmount.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !abortRef.current && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      abortRef.current?.abort();
    };
  }, [onClose]);

  const choose = (f: File | undefined | null) => {
    if (!f) return;
    setFile(f);
    setError(validateFile(f));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!uploading) choose(e.dataTransfer.files[0]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || error) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(0);
    try {
      const created = await uploadDocument({ caseId, file, artifactType: type, onProgress: setProgress, signal: controller.signal });
      qc.setQueryData(caseKeys.artifacts(caseId), (list: unknown[] | undefined) => [...(list ?? []), created]);
      void qc.invalidateQueries({ queryKey: caseKeys.artifacts(caseId) });
      abortRef.current = null;
      onClose();
    } catch (err) {
      abortRef.current = null;
      setProgress(null);
      const key = uploadErrorKey(err);
      if (key !== 'ABORTED') setError(key);
    }
  };

  const errorText = error && (error === 'TOO_LARGE' || error === 'UPLOAD_TOO_LARGE' ? t('errors.TOO_LARGE', { mb: MAX_UPLOAD_MB }) : t.has(`errors.${error}`) ? t(`errors.${error}`) : t('errors.generic'));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={() => !uploading && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg space-y-5 rounded-2xl bg-[var(--card)] p-6 shadow-xl outline-none"
      >
        <h2 id={titleId} className="text-xl font-semibold">
          {t('title')}
        </h2>
        <form onSubmit={submit} className="space-y-5" noValidate>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-xl border-2 border-dashed p-6 text-center ${dragging ? 'border-brand-600 bg-brand-50 dark:bg-brand-900' : 'border-[var(--border)]'}`}
          >
            <p className="text-sm">{file ? <span className="font-medium">{file.name}</span> : t('dropHere')}</p>
            <p className="mt-1 text-xs text-[var(--muted)]">{t('accepted', { mb: MAX_UPLOAD_MB })}</p>
            <button type="button" disabled={uploading} onClick={() => inputRef.current?.click()} className="mt-3 rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm">
              {file ? t('chooseOther') : t('choose')}
            </button>
            <input ref={inputRef} type="file" accept={ACCEPT} className="sr-only" aria-label={t('choose')} onChange={(e) => choose(e.target.files?.[0])} />
          </div>
          <fieldset disabled={uploading} className="space-y-2">
            <legend className="text-sm font-medium">{t('typeLabel')}</legend>
            <div className="grid grid-cols-2 gap-2">
              {SCANNABLE_TYPES.map((v) => (
                <label key={v} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-600 ${type === v ? 'border-brand-600 bg-brand-50 dark:bg-brand-900' : 'border-[var(--border)]'}`}>
                  <input type="radio" name="artifact_type" value={v} checked={type === v} onChange={() => setType(v)} className="sr-only" />
                  {tt(v)}
                </label>
              ))}
            </div>
          </fieldset>
          {uploading && (
            <div className="space-y-1">
              <div role="progressbar" aria-label={t('uploading')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} className="h-2 overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full bg-brand-600 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <p className="text-xs text-[var(--muted)]">{t('uploadingPercent', { percent: Math.round(progress * 100) })}</p>
            </div>
          )}
          {errorText && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
              {errorText}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => (uploading ? abortRef.current?.abort() : onClose())} className="rounded-lg border border-[var(--border)] px-4 py-2">
              {t('cancel')}
            </button>
            <button type="submit" disabled={!file || !!error || uploading} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white disabled:opacity-50">
              {t('upload')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
