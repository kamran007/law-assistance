import type { Authenticate } from '../../auth';
import { ApiError } from '../../problem';
import type { TokenService } from './tokens';

/**
 * `Authorization: Bearer <access JWT>` → Principal (TRD §12.1). No header = anonymous. A header
 * that is present but malformed, expired or wrongly signed is a 401, never anonymous, so clients
 * know to refresh.
 */
export function jwtAuthenticate(tokens: TokenService): Authenticate {
  return async (req) => {
    const header = req.headers.authorization;
    if (!header) return null;
    const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header);
    if (!match) throw new ApiError(401, 'TOKEN_INVALID', 'Invalid access token');
    try {
      const c = await tokens.verifyAccess(match[1]!);
      return { userId: c.sub, role: c.role, verificationStatus: c.vs, sessionId: c.sid };
    } catch (err) {
      const expired = (err as { code?: string }).code === 'ERR_JWT_EXPIRED';
      throw new ApiError(401, expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID', expired ? 'Access token expired' : 'Invalid access token');
    }
  };
}
