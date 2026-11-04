import type { Conversation, Message } from '@lawassist/db';
import { z } from 'zod';

export const conversationSummary = z.object({
  conversation_id: z.string(),
  /** Null = general conversation; set = the single conversation of that case. */
  case_id: z.string().nullable(),
  title: z.string().nullable(),
  language: z.enum(['BN', 'EN']),
  created_at: z.string(),
  updated_at: z.string(),
});

export const message = z.object({
  message_id: z.string(),
  role: z.enum(['USER', 'ASSISTANT']),
  content: z.string(),
  input_mode: z.enum(['TEXT', 'VOICE']),
  attached_artifact_id: z.string().nullable(),
  citations: z.array(z.object({ section_id: z.string(), label: z.string() })),
  law_as_of_date: z.string().nullable(),
  status: z.enum(['COMPLETE', 'INTERRUPTED', 'NO_PROVISION', 'ERROR']),
  created_at: z.string(),
});

export const toConversationSummary = (c: Conversation): z.infer<typeof conversationSummary> => ({
  conversation_id: c.conversationId,
  case_id: c.caseFileId,
  title: c.title,
  language: c.language,
  created_at: c.createdAt.toISOString(),
  updated_at: c.updatedAt.toISOString(),
});

/** Never includes retrieval_trace, token counts or flags: those are server-side only (TRD §4.2). */
export const toMessage = (m: Message): z.infer<typeof message> => ({
  message_id: m.messageId,
  role: m.role,
  content: m.content,
  input_mode: m.inputMode,
  attached_artifact_id: m.attachedArtifactId,
  citations: (m.citations ?? []).map((c) => ({ section_id: c.sectionId, label: c.label })),
  law_as_of_date: m.lawAsOfDate,
  status: m.status,
  created_at: m.createdAt.toISOString(),
});
