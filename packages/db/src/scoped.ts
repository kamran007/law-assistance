import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import { artifactRevisions, caseArtifacts, caseFiles, conversations, deviceTokens, messages, newId, type DEVICE_PLATFORMS } from './schema/index';

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];
export const MAX_DEVICES_PER_USER = 10;
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

    /** A new draft from a template (App Flow §10, BE-32). Null if the case isn't this user's. */
    async createDraft(input: { artifactId: string; caseFileId: string; templateKey: string; html: string }): Promise<CaseArtifact | null> {
      if (!(await caseFilesRepo.findById(input.caseFileId))) return null;
      await db.insert(caseArtifacts).values({
        artifactId: input.artifactId,
        caseFileId: input.caseFileId,
        ownerUserId: userId,
        artifactType: 'VOICE_DICTATION_DRAFT',
        templateKey: input.templateKey,
        editableDocumentHtml: input.html,
      });
      return artifactsRepo.findById(input.artifactId);
    },

    /**
     * Saves draft HTML (TRD §5.4, BE-33): last write wins, but nothing is lost. If the client edited
     * an older version, the server's current text is first copied into `artifact_revisions` and
     * its id returned (`X-Conflict-Preserved`). One transaction, row locked.
     */
    async saveDraft(
      artifactId: string,
      expectedVersion: number,
      html: string,
      device: string | null,
    ): Promise<{ status: 'ok'; row: CaseArtifact; preservedRevisionId: string | null } | { status: 'not_found' } | { status: 'not_a_draft' }> {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(caseArtifacts)
          .where(and(eq(caseArtifacts.artifactId, artifactId), eq(caseArtifacts.ownerUserId, userId), isNull(caseArtifacts.deletedAt)))
          .for('update');
        if (!current) return { status: 'not_found' as const };
        if (current.artifactType !== 'VOICE_DICTATION_DRAFT') return { status: 'not_a_draft' as const };
        let preservedRevisionId: string | null = null;
        if (current.version !== expectedVersion) {
          preservedRevisionId = newId();
          await tx.insert(artifactRevisions).values({
            revisionId: preservedRevisionId,
            artifactId,
            ownerUserId: userId,
            version: current.version,
            editableDocumentHtml: current.editableDocumentHtml,
            createdByDevice: device,
          });
        }
        await tx
          .update(caseArtifacts)
          .set({ editableDocumentHtml: html, version: current.version + 1 })
          .where(and(eq(caseArtifacts.artifactId, artifactId), eq(caseArtifacts.ownerUserId, userId)));
        const [row] = await tx.select().from(caseArtifacts).where(eq(caseArtifacts.artifactId, artifactId));
        return { status: 'ok' as const, row: row!, preservedRevisionId };
      });
    },

    /** Preserved earlier versions of a draft, newest first (owner only). */
    async draftRevisions(artifactId: string): Promise<(typeof artifactRevisions.$inferSelect)[] | null> {
      if (!(await artifactsRepo.findById(artifactId))) return null;
      return db
        .select()
        .from(artifactRevisions)
        .where(and(eq(artifactRevisions.artifactId, artifactId), eq(artifactRevisions.ownerUserId, userId)))
        .orderBy(desc(artifactRevisions.createdAt));
    },

    /**
     * Scan pipeline progress and results (TRD §8.2). Only for a live artifact of this user; returns
     * false if it was deleted meanwhile, so the pipeline can stop.
     */
    async setProcessing(
      artifactId: string,
      patch: Partial<
        Pick<CaseArtifact, 'processingStatus' | 'processingError' | 'rawExtractedText' | 'ocrConfidence' | 'pageCount' | 'fileSha256' | 'structuredAnalysis' | 'roleAnalysis'>
      >,
    ): Promise<boolean> {
      const [res] = await db
        .update(caseArtifacts)
        .set(patch)
        .where(and(eq(caseArtifacts.artifactId, artifactId), eq(caseArtifacts.ownerUserId, userId), isNull(caseArtifacts.deletedAt)));
      return res.affectedRows === 1;
    },

    /**
     * Saves user corrections to a finished analysis (TRD §8.5). Optimistic concurrency like case
     * edits (TRD §5.4), and only while no pipeline stage is running (status READY): a correction
     * must never race the worker writing the same JSON.
     */
    async updateAnalysis(artifactId: string, expectedVersion: number, structuredAnalysis: unknown): Promise<UpdateResult<CaseArtifact> | { status: 'busy'; current: CaseArtifact }> {
      const current = await artifactsRepo.findById(artifactId);
      if (!current) return { status: 'not_found' };
      if (current.processingStatus !== 'READY') return { status: 'busy', current };
      const [res] = await db
        .update(caseArtifacts)
        .set({ structuredAnalysis, version: sql`${caseArtifacts.version} + 1` })
        .where(
          and(
            eq(caseArtifacts.artifactId, artifactId),
            eq(caseArtifacts.ownerUserId, userId),
            isNull(caseArtifacts.deletedAt),
            eq(caseArtifacts.version, expectedVersion),
            eq(caseArtifacts.processingStatus, 'READY'),
          ),
        );
      const after = await artifactsRepo.findById(artifactId);
      if (!after) return { status: 'not_found' };
      if (res.affectedRows === 1) return { status: 'ok', row: after };
      return after.processingStatus === 'READY' ? { status: 'version_conflict', current: after } : { status: 'busy', current: after };
    },

    /**
     * Moves a READY document back to SCHEDULE_LOOKUP for `/reanalyze` (stages 4–6). Conditional on
     * READY, so two clicks cannot start two runs. Returns the row after the change, or null if it
     * was not READY (or not this user's).
     */
    async startReanalysis(artifactId: string): Promise<CaseArtifact | null> {
      const [res] = await db
        .update(caseArtifacts)
        .set({ processingStatus: 'SCHEDULE_LOOKUP', processingError: null })
        .where(
          and(
            eq(caseArtifacts.artifactId, artifactId),
            eq(caseArtifacts.ownerUserId, userId),
            isNull(caseArtifacts.deletedAt),
            eq(caseArtifacts.processingStatus, 'READY'),
          ),
        );
      return res.affectedRows === 1 ? artifactsRepo.findById(artifactId) : null;
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

  const devicesRepo = {
    /**
     * Registers (or refreshes) this user's FCM token. A token already registered by another user is
     * moved to this one: the caller holds the token, so the device is theirs now and the previous
     * account must stop getting its notifications. Keeps at most MAX_DEVICES_PER_USER, newest first.
     */
    async register(token: string, platform: DevicePlatform): Promise<void> {
      await db
        .insert(deviceTokens)
        .values({ deviceTokenId: newId(), userId, token, platform })
        .onDuplicateKeyUpdate({ set: { userId, platform, lastSeenAt: sql`CURRENT_TIMESTAMP(3)` } });
      const stale = await db
        .select({ id: deviceTokens.deviceTokenId })
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId))
        .orderBy(desc(deviceTokens.lastSeenAt), desc(deviceTokens.deviceTokenId))
        .offset(MAX_DEVICES_PER_USER)
        .limit(1000);
      if (stale.length) await db.delete(deviceTokens).where(and(eq(deviceTokens.userId, userId), inArray(deviceTokens.deviceTokenId, stale.map((s) => s.id))));
    },

    async list(): Promise<{ token: string; platform: DevicePlatform }[]> {
      return db
        .select({ token: deviceTokens.token, platform: deviceTokens.platform })
        .from(deviceTokens)
        .where(eq(deviceTokens.userId, userId))
        .orderBy(desc(deviceTokens.lastSeenAt));
    },

    /** Removes one of this user's tokens (sign-out, or FCM reported it invalid). */
    async remove(token: string): Promise<boolean> {
      const [res] = await db.delete(deviceTokens).where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, token)));
      return res.affectedRows > 0;
    },
  };

  return {
    userId,
    devices: devicesRepo,
    caseFiles: caseFilesRepo,
    conversations: conversationsRepo,
    messages: messagesRepo,
    artifacts: artifactsRepo,
  };
}

export type ScopedRepos = ReturnType<typeof scoped>;
