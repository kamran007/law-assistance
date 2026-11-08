'use client';

import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useTranslations } from 'next-intl';
import { useCallback } from 'react';
import { Link } from '@/i18n/navigation';
import { saveDraft, useAutosave, useDraft, type Draft, type SaveState } from '@/lib/drafts';
import { isStatus } from '@/lib/cases';

/** Draft editor page (App Flow §10): loads the draft, then hands it to the editor. */
export function DraftEditorPage({ caseId, artId }: { caseId: string; artId: string }) {
  const t = useTranslations('drafts');
  const { data, isPending, isError, error } = useDraft(caseId, artId);
  if (isPending) return <p role="status" className="text-[var(--muted)]">{t('loading')}</p>;
  if (isError) {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="font-medium">{isStatus(error, 404) ? t('notFound') : t('loadFailed')}</p>
        <Link href={`/cases/${caseId}?tab=drafts`} className="text-brand-700 underline">
          {t('back')}
        </Link>
      </div>
    );
  }
  return <DraftEditor caseId={caseId} draft={data} />;
}

/**
 * Rich-text editor (TipTap) with autosave. Only the structure the server keeps is offered:
 * headings, paragraphs, lists, bold / italic / underline / strike, quotes. Dictation needs the
 * speech service (BE-31), so the mic is shown disabled.
 */
export function DraftEditor({ caseId, draft }: { caseId: string; draft: Draft }) {
  const t = useTranslations('drafts');
  const save = useCallback((html: string, version: number) => saveDraft(caseId, draft.artifact_id, html, version), [caseId, draft.artifact_id]);
  const autosave = useAutosave({ initialVersion: draft.version, save });
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false, heading: { levels: [1, 2, 3] } }), Placeholder.configure({ placeholder: t('placeholder') })],
    content: draft.html,
    immediatelyRender: false,
    editorProps: { attributes: { class: 'draft-content min-h-[50vh] rounded-b-xl px-5 py-4 outline-none', 'aria-label': t('editorLabel'), 'aria-multiline': 'true', role: 'textbox' } },
    onUpdate: ({ editor: e }) => autosave.change(e.getHTML()),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href={`/cases/${caseId}?tab=drafts`} className="text-sm text-brand-700 underline">
          {t('back')}
        </Link>
        <SaveIndicator state={autosave.state} onRetry={() => void autosave.flush()} />
      </div>
      {autosave.conflict && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <span>{t('conflictPreserved')}</span>
          <button type="button" onClick={autosave.dismissConflict} className="underline">
            {t('dismiss')}
          </button>
        </div>
      )}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)]">
        <Toolbar editor={editor} />
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const t = useTranslations('drafts.save');
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-[var(--muted)]">
      <span aria-hidden className={`size-2 rounded-full ${state === 'saved' ? 'bg-emerald-500' : state === 'error' ? 'bg-red-500' : 'bg-amber-400'}`} />
      {t(state)}
      {state === 'error' && (
        <button type="button" onClick={onRetry} className="text-brand-700 underline">
          {t('retry')}
        </button>
      )}
    </p>
  );
}

function Toolbar({ editor }: { editor: Editor | null }) {
  const t = useTranslations('drafts.toolbar');
  const btn = (label: string, active: boolean, run: () => void, text: string) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={!editor}
      onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
      onClick={run}
      className={`min-w-8 rounded px-2 py-1 text-sm ${active ? 'bg-brand-100 text-brand-900 dark:bg-brand-900 dark:text-brand-100' : 'hover:bg-[var(--background)]'}`}
    >
      {text}
    </button>
  );
  const chain = () => editor!.chain().focus();
  return (
    <div role="toolbar" aria-label={t('label')} className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
      {btn(t('h1'), !!editor?.isActive('heading', { level: 1 }), () => chain().toggleHeading({ level: 1 }).run(), 'H1')}
      {btn(t('h2'), !!editor?.isActive('heading', { level: 2 }), () => chain().toggleHeading({ level: 2 }).run(), 'H2')}
      {btn(t('bold'), !!editor?.isActive('bold'), () => chain().toggleBold().run(), 'B')}
      {btn(t('italic'), !!editor?.isActive('italic'), () => chain().toggleItalic().run(), 'I')}
      {btn(t('underline'), !!editor?.isActive('underline'), () => chain().toggleUnderline().run(), 'U')}
      {btn(t('bullets'), !!editor?.isActive('bulletList'), () => chain().toggleBulletList().run(), '•')}
      {btn(t('numbers'), !!editor?.isActive('orderedList'), () => chain().toggleOrderedList().run(), '1.')}
      {btn(t('quote'), !!editor?.isActive('blockquote'), () => chain().toggleBlockquote().run(), '❝')}
      {btn(t('undo'), false, () => chain().undo().run(), '↶')}
      {btn(t('redo'), false, () => chain().redo().run(), '↷')}
      <span className="ml-auto" />
      <button type="button" disabled title={t('micSoon')} aria-label={t('micSoon')} className="rounded px-2 py-1 text-sm opacity-50">
        🎤
      </button>
    </div>
  );
}
