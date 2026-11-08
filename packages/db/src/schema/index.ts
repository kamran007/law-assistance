/**
 * Full schema. Apps must NOT import tenant-owned tables from here directly —
 * use `scoped()` from '@lawassist/db' instead (ESLint enforces this, TRD §4.3).
 */
export * from './columns';
export * from './enums';
export * from './users';
export * from './statutes';
export * from './cases';
export * from './ops';
export * from './judgments';
