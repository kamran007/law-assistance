'use client';

import { RequireAuth } from '@/components/auth/require-auth';
import { ScanResult } from './scan-result';

export function ScanResultPage({ caseId, artId }: { caseId: string; artId: string }) {
  return <RequireAuth>{() => <ScanResult caseId={caseId} artId={artId} />}</RequireAuth>;
}
