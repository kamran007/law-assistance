'use client';

import { useId, type InputHTMLAttributes } from 'react';

/** Text input with a visible label and an optional hint linked via aria-describedby. */
export function Field({ label, hint, className = '', ...input }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input id={id} aria-describedby={hintId} className={`w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 ${className}`} {...input} />
      {hint && (
        <p id={hintId} className="text-xs text-[var(--muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}
