import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/client';
import { runMigrations } from '../src/migrate';
import { scoped } from '../src/scoped';
import { newId, statutes, statuteSections, users } from '../src/schema/index';

/**
 * Integration tests against real MySQL 8.4 (Testcontainers; requires Docker).
 * Covers: migrations, one-current-version constraint, citizen case-conversation trigger,
 * tenant isolation via scoped repos (TRD §4.3), optimistic concurrency, ngram FULLTEXT.
 */
const ER_DUP_ENTRY = 1062;
/** Raised by the triggers' SIGNAL SQLSTATE '45000'. */
const ER_SIGNAL_EXCEPTION = 1644;

/**
 * Drizzle 0.45 wraps driver errors in DrizzleQueryError ("Failed query: ..."); the MySQL error
 * (errno + message) is on `.cause`. Assert on the driver error, not the wrapper's message.
 */
async function expectDbError(op: Promise<unknown>, errno: number, message: RegExp): Promise<void> {
  const err: unknown = await op.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'expected the query to be rejected').toBeInstanceOf(Error);
  const chain: { errno?: unknown; message?: unknown }[] = [];
  for (let e: unknown = err; e && chain.length < 5; e = (e as { cause?: unknown }).cause) chain.push(e as never);
  const driver = chain.find((e) => typeof e.errno === 'number');
  expect(driver, 'no MySQL driver error in the cause chain').toBeDefined();
  expect(driver!.errno).toBe(errno);
  expect(String(driver!.message)).toMatch(message);
}

let container: StartedMySqlContainer;
let db: Db;
let close: () => Promise<void>;

const lawyerId = newId();
const citizenId = newId();
const otherLawyerId = newId();

beforeAll(async () => {
  container = await new MySqlContainer('mysql:8.4')
    .withCommand(['--ngram_token_size=2', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_0900_ai_ci'])
    .withRootPassword('root')
    .withDatabase('lawassist')
    .start();
  const url = `mysql://root:root@${container.getHost()}:${container.getPort()}/lawassist`;
  await runMigrations(url);
  ({ db, close } = createDb(url, { connectionLimit: 5 }));

  await db.insert(users).values([
    { userId: lawyerId, fullName: 'Adv. Rahman', contactIdentifier: '+8801700000001', role: 'LAWYER', requestedRole: 'LAWYER', verificationStatus: 'VERIFIED' },
    { userId: citizenId, fullName: 'Karim', contactIdentifier: '+8801700000002' },
    { userId: otherLawyerId, fullName: 'Adv. Sultana', contactIdentifier: '+8801700000003', role: 'LAWYER', requestedRole: 'LAWYER', verificationStatus: 'VERIFIED' },
  ]);
});

afterAll(async () => {
  await close?.();
  await container?.stop();
});

describe('statute versioning constraints', () => {
  it('allows only one current version per section', async () => {
    const statuteId = newId();
    await db.insert(statutes).values({ statuteId, bdlawsActId: 11, language: 'EN', titleEn: 'The Penal Code, 1860', sourceUrl: 'https://example/act-11' });
    const base = {
      statuteId,
      sectionNumber: '420',
      normalizedSectionKey: '420',
      marginalHeading: 'Cheating and dishonestly inducing delivery of property',
      contentBody: 'Whoever cheats ... shall be punished with imprisonment ... seven years',
      amendmentFootnotes: [],
      contentHash: 'a'.repeat(64),
      footnotesHash: 'b'.repeat(64),
      validFromSource: 'ENACTMENT_DATE' as const,
    };
    await db.insert(statuteSections).values({ ...base, sectionId: newId(), versionNumber: 1, isCurrent: true, validFrom: '1860-10-06' });
    await expectDbError(
      db.insert(statuteSections).values({ ...base, sectionId: newId(), versionNumber: 2, isCurrent: true, validFrom: '2023-01-01' }),
      ER_DUP_ENTRY,
      /Duplicate entry .* for key 'statute_sections\.uq_sections_current_key'/,
    );
    // A superseded (non-current) version is fine.
    await db.insert(statuteSections).values({ ...base, sectionId: newId(), versionNumber: 2, isCurrent: false, validFrom: '1860-10-06', validTo: '2000-01-01' });
  });

  it('finds Bangla text through the ngram FULLTEXT index', async () => {
    const statuteId = newId();
    await db.insert(statutes).values({ statuteId, bdlawsActId: 999, language: 'BN', titleBn: 'নারী ও শিশু নির্যাতন দমন আইন, ২০০০', sourceUrl: 'https://example/act-999' });
    await db.insert(statuteSections).values({
      sectionId: newId(), statuteId, sectionNumber: '৯', normalizedSectionKey: '9',
      marginalHeading: 'ধর্ষণ, ধর্ষণজনিত কারণে মৃত্যু, ইত্যাদির শাস্তি',
      contentBody: 'যদি কোন পুরুষ কোন নারী বা শিশুকে ধর্ষণ করেন, তাহা হইলে তিনি যাবজ্জীবন সশ্রম কারাদণ্ডে দণ্ডনীয় হইবেন',
      amendmentFootnotes: [], contentHash: 'c'.repeat(64), footnotesHash: 'd'.repeat(64),
      versionNumber: 1, isCurrent: true, validFrom: '2000-02-14', validFromSource: 'ENACTMENT_DATE',
    });
    const [rows] = (await db.execute(
      sql`SELECT section_number FROM statute_sections WHERE MATCH(marginal_heading, content_body) AGAINST (${'কারাদণ্ডে'} IN NATURAL LANGUAGE MODE)`,
    )) as unknown as [Array<{ section_number: string }>];
    expect(rows.map((r) => r.section_number)).toContain('৯');
  });
});

describe('case files & conversations', () => {
  it('creates exactly one conversation with a lawyer case, none for a citizen case', async () => {
    const lawyer = scoped(db, lawyerId);
    const c = await lawyer.caseFiles.create({ caseNumber: 'G.R. 412/2026', allegedOffenseDate: '2026-10-02' }, { withConversation: true });
    expect(await lawyer.conversations.findForCase(c.caseFileId)).not.toBeNull();

    const citizen = scoped(db, citizenId);
    const cc = await citizen.caseFiles.create({ title: 'My FIR' }, { withConversation: false });
    expect(await citizen.conversations.findForCase(cc.caseFileId)).toBeNull();
  });

  it('DB trigger rejects a case conversation for a citizen even if the service layer is bypassed', async () => {
    const citizen = scoped(db, citizenId);
    await expectDbError(citizen.caseFiles.create({ title: 'x' }, { withConversation: true }), ER_SIGNAL_EXCEPTION, /CASE_CONVERSATION_ROLE_FORBIDDEN/);
  });

  it('rejects a second conversation for the same case', async () => {
    const lawyer = scoped(db, lawyerId);
    const c = await lawyer.caseFiles.create({ title: 'dup' }, { withConversation: true });
    await expectDbError(
      db.execute(sql`INSERT INTO conversations (conversation_id, owner_user_id, case_file_id) VALUES (UUID_TO_BIN(UUID()), UUID_TO_BIN(${lawyerId}), UUID_TO_BIN(${c.caseFileId}))`),
      ER_DUP_ENTRY,
      /Duplicate entry/,
    );
  });
});

describe('tenant isolation (TRD §4.3)', () => {
  it("never exposes another user's case, conversation or messages", async () => {
    const a = scoped(db, lawyerId);
    const b = scoped(db, otherLawyerId);

    const aCase = await a.caseFiles.create({ caseNumber: 'A-1' }, { withConversation: true });
    const aConv = (await a.conversations.findForCase(aCase.caseFileId))!;
    await a.messages.append(aConv.conversationId, { role: 'USER', content: 'secret case question' });
    const aGeneral = await a.conversations.createGeneral({ title: 'general' });

    expect(await b.caseFiles.findById(aCase.caseFileId)).toBeNull();
    expect((await b.caseFiles.list()).map((x) => x.caseFileId)).not.toContain(aCase.caseFileId);
    expect(await b.conversations.findById(aConv.conversationId)).toBeNull();
    expect(await b.conversations.findForCase(aCase.caseFileId)).toBeNull();
    expect((await b.conversations.listGeneral()).map((x) => x.conversationId)).not.toContain(aGeneral.conversationId);
    expect(await b.messages.byConversation(aConv.conversationId)).toBeNull();
    expect(await b.messages.append(aConv.conversationId, { role: 'USER', content: 'inject' })).toBeNull();
    expect(await b.artifacts.listByCase(aCase.caseFileId)).toBeNull();
    expect((await b.caseFiles.update(aCase.caseFileId, 1, { title: 'hijack' })).status).toBe('not_found');
    expect(await b.caseFiles.softDelete(aCase.caseFileId)).toBe(false);
    expect(await b.conversations.rename(aGeneral.conversationId, 'hijack')).toBe(false);

    // A's data is intact.
    expect((await a.caseFiles.findById(aCase.caseFileId))?.title).toBeNull();
    expect((await a.messages.byConversation(aConv.conversationId))?.map((m) => m.content)).toEqual(['secret case question']);
  });

  it('keeps case conversation history separate from general conversations', async () => {
    const a = scoped(db, lawyerId);
    const c1 = await a.caseFiles.create({ caseNumber: 'C-1' }, { withConversation: true });
    const c2 = await a.caseFiles.create({ caseNumber: 'C-2' }, { withConversation: true });
    const conv1 = (await a.conversations.findForCase(c1.caseFileId))!;
    const conv2 = (await a.conversations.findForCase(c2.caseFileId))!;
    await a.messages.append(conv1.conversationId, { role: 'USER', content: 'about case 1' });
    await a.messages.append(conv2.conversationId, { role: 'USER', content: 'about case 2' });

    expect((await a.messages.byConversation(conv1.conversationId))!.map((m) => m.content)).toEqual(['about case 1']);
    expect((await a.conversations.listGeneral()).map((c) => c.conversationId)).not.toContain(conv1.conversationId);
  });
});

describe('optimistic concurrency (TRD §5.4)', () => {
  it('applies with the right version and reports a conflict with a stale one', async () => {
    const a = scoped(db, lawyerId);
    const c = await a.caseFiles.create({ title: 'v1' }, { withConversation: true });
    const ok = await a.caseFiles.update(c.caseFileId, 1, { title: 'v2' });
    expect(ok.status).toBe('ok');
    const stale = await a.caseFiles.update(c.caseFileId, 1, { title: 'stale' });
    expect(stale.status).toBe('version_conflict');
    if (stale.status === 'version_conflict') expect(stale.current.title).toBe('v2');
  });

  it('soft-deletes a case together with its conversation', async () => {
    const a = scoped(db, lawyerId);
    const c = await a.caseFiles.create({ title: 'to delete' }, { withConversation: true });
    const conv = (await a.conversations.findForCase(c.caseFileId))!;
    expect(await a.caseFiles.softDelete(c.caseFileId)).toBe(true);
    expect(await a.caseFiles.findById(c.caseFileId)).toBeNull();
    expect(await a.conversations.findById(conv.conversationId)).toBeNull();
  });
});
