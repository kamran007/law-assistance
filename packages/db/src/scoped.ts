import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import { caseArtifacts, caseFiles, conversations, messages, newId } from './schema/index';
import type { MessageCitation } from './schema/index';

/**
 * Tenant-scoped data access (TRD §4.3).
 *
 * MySQL has no row-level security, so EVERY read/write of a tenant-owned table goes through here and
 * is filtered by `owner_user_id = userId` (taken from the verified JWT, never from request input).
 * Resources owned by someone else are indistinguishable from missing ones: callers get `null`/`not_found`
 * and must answer 404, never 403.
 */
export type UpdateResult<T> =
  | { status: 'ok'; row: T }
  | { status: 'not_found' }
  | { status: 'version_conflict'; current: T };

export type CaseFile = typeof caseFiles.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type CaseArtifact = typeof caseArtifacts.$inferSelect;

export interface CaseFileInput {
  title?: string | null;
  caseNumber?: string | null;
  courtOrThana?: string | null;
  allegedOffenseDate?: string | null;
}

export function scoped(db: Db, userId: string) {
  if (!userId) throw new Error('scoped() requires an authenticated userId');

  const ownCase = (id: string) =>
    and(eq(caseFiles.caseFileId, id), eq(caseFiles.ownerUserId, userId), isNull(caseFiles.deletedAt));
  const ownConversation = (id: string) =>
    and(
      eq(conversations.conversationId, id),
      eq(conversations.ownerUserId, userId),
      isNull(conversations.deletedAt),
    );

  const caseFilesRepo = {
    async findById(id: string): Promise<CaseFile | null> {
      const [row] = await db.select().from(caseFiles).where(ownCase(id)).limit(1);
      return row ?? null;
    },

    /** Incremental sync: includes soft-deleted rows (tombstones) when `updatedSince` is given. */
    async list(opts: { updatedSince?: Date; limit?: number } = {}): Promise<CaseFile[]> {
      const where = opts.updatedSince
        ? and(eq(caseFiles.ownerUserId, userId), gt(caseFiles.updatedAt, opts.updatedSince))
        : and(eq(caseFiles.ownerUserId, userId), isNull(caseFiles.deletedAt));
      return db
        .select()
        .from(caseFiles)
        .where(where)
        .orderBy(desc(caseFiles.updatedAt))
        .limit(opts.limit ?? 200);
    },

    /**
     * Creates a case file. For LAWYER/JUDGE owners, the case conversation is created in the same
     * transaction (App Flow §5.2). Citizens never get one.
     */
    async create(input: CaseFileInput, opts: { withConversation: boolean }): Promise<CaseFile> {
      const caseFileId = newId();
      await db.transaction(async (tx) => {
        await tx.insert(caseFiles).values({ caseFileId, ownerUserId: userId, ...input });
        if (opts.withConversation) {
          await tx.insert(conversations).values({
            conversationId: newId(),
            ownerUserId: userId,
            caseFileId,
            title: input.title ?? input.caseNumber ?? null,
          });
        }
      });
      return (await caseFilesRepo.findById(caseFileId))!;
    },

    /** Optimistic concurrency (TRD §5.4): applies only if `expectedVersion` matches. */
    async update(id: string, expectedVersion: number, patch: CaseFileInput): Promise<UpdateResult<CaseFile>> {
      const [res] = await db
        .update(caseFiles)
        .set({ ...patch, version: sql`${caseFiles.version} + 1` })
        .where(and(ownCase(id), eq(caseFiles.version, expectedVersion)));
      const current = await caseFilesRepo.findById(id);
      if (!current) return { status: 'not_found' };
      return res.affectedRows === 1 ? { status: 'ok', row: current } : { status: 'version_conflict', current };
    },

    async softDelete(id: string): Promise<boolean> {
      const now = new Date();
      return db.transaction(async (tx) => {
        const [res] = await tx.update(caseFiles).set({ deletedAt: now }).where(ownCase(id));
        if (res.affectedRows !== 1) return false;
        await tx
          .update(conversations)
          .set({ deletedAt: now })
          .where(and(eq(conversations.caseFileId, id), eq(conversations.ownerUserId, userId)));
        await tx
          .update(caseArtifacts)
          .set({ deletedAt: now })
          .where(and(eq(caseArtifacts.caseFileId, id), eq(caseArtifacts.ownerUserId, userId)));
        return true;
      });
    },
  };

  const conversationsRepo = {
    async findById(id: string): Promise<Conversation | null> {
      const [row] = await db.select().from(conversations).where(ownConversation(id)).limit(1);
      return row ?? null;
    },

    /** General (non-case) conversations — the Home conversation history (App Flow §4). */
    async listGeneral(opts: { limit?: number } = {}): Promise<Conversation[]> {
      return db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.ownerUserId, userId),
            isNull(conversations.caseFileId),
            isNull(conversations.deletedAt),
          ),
        )
        .orderBy(desc(conversations.updatedAt))
        .limit(opts.limit ?? 100);
    },

    async createGeneral(input: { title?: string | null; language?: 'BN' | 'EN' } = {}): Promise<Conversation> {
      const conversationId = newId();
      await db.insert(conversations).values({ conversationId, ownerUserId: userId, caseFileId: null, ...input });
      return (await conversationsRepo.findById(conversationId))!;
    },

    /** The single conversation of a case owned by this user, or null if the case isn't theirs / has none. */
    async findForCase(caseFileId: string): Promise<Conversation | null> {
      const [row] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.caseFileId, caseFileId),
            eq(conversations.ownerUserId, userId),
            isNull(conversations.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * The case's conversation, created if missing (TRD §5.1): a Lawyer/Judge approved after creating
     * cases as a Citizen has cases without one. Returns null if the case isn't this user's. The DB
     * trigger still rejects this for CITIZEN owners; callers check the role first.
     */
    async ensureForCase(caseFileId: string): Promise<Conversation | null> {
      const existing = await conversationsRepo.findForCase(caseFileId);
      if (existing) return existing;
      const owned = await caseFilesRepo.findById(caseFileId);
      if (!owned) return null;
      try {
        await db.insert(conversations).values({
          conversationId: newId(),
          ownerUserId: userId,
          caseFileId,
          title: owned.title ?? owned.caseNumber ?? null,
        });
      } catch (err) {
        // UNIQUE(case_file_id): a concurrent call created it first.
        if ((err as { cause?: { errno?: number } }).cause?.errno !== 1062) throw err;
      }
      return conversationsRepo.findForCase(caseFileId);
    },

    async rename(id: string, title: string): Promise<boolean> {
      const [res] = await db.update(conversations).set({ title }).where(ownConversation(id));
      return res.affectedRows === 1;
    },

    async softDelete(id: string): Promise<boolean> {
      const [res] = await db
        .update(conversations)
        .set({ deletedAt: new Date() })
        .where(and(ownConversation(id), isNull(conversations.caseFileId))); // case conversations die with their case
      return res.affectedRows === 1;
    },
  };

  const messagesRepo = {
    /** History for ONE conversation only — the context-isolation boundary (TRD §7.2). */
    async byConversation(
      conversationId: string,
      opts: { limit?: number; before?: Date } = {},
    ): Promise<Message[] | null> {
      if (!(await conversationsRepo.findById(conversationId))) return null;
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.ownerUserId, userId),
            opts.before ? lt(messages.createdAt, opts.before) : undefined,
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(opts.limit ?? 50);
      return rows.reverse();
    },

    async append(
      conversationId: string,
      input: {
        role: 'USER' | 'ASSISTANT';
        content: string;
        inputMode?: 'TEXT' | 'VOICE';
        attachedArtifactId?: string | null;
        citations?: MessageCitation[] | null;
        lawAsOfDate?: string | null;
        status?: Message['status'];
        modelId?: string | null;
        inputTokens?: number | null;
        outputTokens?: number | null;
        latencyMs?: number | null;
        flags?: string[] | null;
        retrievalTrace?: unknown;
      },
    ): Promise<Message | null> {
      if (!(await conversationsRepo.findById(conversationId))) return null;
      const messageId = newId();
      await db.insert(messages).values({ messageId, conversationId, ownerUserId: userId, ...input });
      await db
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.conversationId, conversationId));
      const [row] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.messageId, messageId), eq(messages.ownerUserId, userId)));
      return row ?? null;
    },
  };

  const artifactsRepo = {
    async findById(artifactId: string): Promise<CaseArtifact | null> {
      const [row] = await db
        .select()
        .from(caseArtifacts)
        .where(
          and(
            eq(caseArtifacts.artifactId, artifactId),
            eq(caseArtifacts.ownerUserId, userId),
            isNull(caseArtifacts.deletedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * Registers an uploaded document (TRD §8.1 step 3) with status UPLOADED. The id was handed out
     * with the upload URL, so a retried registration returns the existing row instead of failing.
     * Returns null if the case isn't this user's, or the id already belongs to someone else's row.
     */
    async createUpload(input: {
      artifactId: string;
      caseFileId: string;
      artifactType: CaseArtifact['artifactType'];
      fileStorageKey: string;
      mimeType: string;
      pageCount?: number | null;
    }): Promise<{ row: CaseArtifact; created: boolean } | null> {
      if (!(await caseFilesRepo.findById(input.caseFileId))) return null;
      try {
        await db.insert(caseArtifacts).values({ ...input, ownerUserId: userId, processingStatus: 'UPLOADED' });
        return { row: (await artifactsRepo.findById(input.artifactId))!, created: true };
      } catch (err) {
        if ((err as { cause?: { errno?: number } }).cause?.errno !== 1062) throw err;
        const existing = await artifactsRepo.findById(input.artifactId);
        return existing && existing.caseFileId === input.caseFileId ? { row: existing, created: false } : null;
      }
    },

    /**
     * Scan pipeline progress and results (TRD §8.2). Only for a live artifact of this user; returns
     * false if it was deleted meanwhile, so the pipeline can stop.
     */
    async setProcessing(
      artifactId: string,
      patch: Partial<
        Pick<CaseArtifact, 'processingStatus' | 'processingError' | 'rawExtractedText' | 'ocrConfidence' | 'pageCount' | 'fileSha256' | 'structuredAnalysis'>
      >,
    ): Promise<boolean> {
      const [res] = await db
        .update(caseArtifacts)
        .set(patch)
        .where(and(eq(caseArtifacts.artifactId, artifactId), eq(caseArtifacts.ownerUserId, userId), isNull(caseArtifacts.deletedAt)));
      return res.affectedRows === 1;
    },

    async softDelete(artifactId: string): Promise<boolean> {
      const [res] = await db
        .update(caseArtifacts)
        .set({ deletedAt: new Date() })
        .where(and(eq(caseArtifacts.artifactId, artifactId), eq(caseArtifacts.ownerUserId, userId), isNull(caseArtifacts.deletedAt)));
      return res.affectedRows === 1;
    },

    async listByCase(caseFileId: string): Promise<CaseArtifact[] | null> {
      if (!(await caseFilesRepo.findById(caseFileId))) return null;
      return db
        .select()
        .from(caseArtifacts)
        .where(
          and(
            eq(caseArtifacts.caseFileId, caseFileId),
            eq(caseArtifacts.ownerUserId, userId),
            isNull(caseArtifacts.deletedAt),
          ),
        )
        .orderBy(asc(caseArtifacts.createdAt));
    },
  };

  return {
    userId,
    caseFiles: caseFilesRepo,
    conversations: conversationsRepo,
    messages: messagesRepo,
    artifacts: artifactsRepo,
  };
}

export type ScopedRepos = ReturnType<typeof scoped>;
