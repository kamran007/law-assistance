import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './problem';

/** `ETag: "<version>"` on every mutable resource (TRD §5.4). */
export function setVersionEtag(reply: FastifyReply, version: number): void {
  reply.header('etag', `"${version}"`);
}

/**
 * The version a PATCH expects, from `If-Match: "3"` (weak `W/"3"` accepted). TRD §5.4: PATCH MUST
 * send it; a missing header is 428 so clients can't overwrite blindly.
 */
export function requireIfMatch(req: FastifyRequest): number {
  const raw = req.headers['if-match'];
  if (!raw) throw new ApiError(428, 'PRECONDITION_REQUIRED', 'If-Match header required', 'Send the ETag you last received');
  const m = /^(?:W\/)?"(\d{1,9})"$/.exec(String(raw).trim());
  if (!m) throw new ApiError(422, 'INVALID_IF_MATCH', 'If-Match must be a version ETag like "3"');
  return Number(m[1]);
}
