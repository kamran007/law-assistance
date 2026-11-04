import type { UserRole } from '@lawassist/db';
import type { FastifyRequest } from 'fastify';
import { ApiError } from './problem';

/** The caller, taken from a verified access JWT (TRD §12.1). */
export interface Principal {
  userId: string;
  /** Effective role: stays CITIZEN until a LAWYER/JUDGE credential is VERIFIED. */
  role: UserRole;
  verificationStatus: 'NOT_REQUIRED' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  /** Refresh-token family of this login; logout revokes it. */
  sessionId?: string;
}

/**
 * Resolves the caller of a request, or null for an anonymous request.
 * Must throw `ApiError(401)` for a present but invalid token, never treat it as anonymous.
 */
export type Authenticate = (req: FastifyRequest) => Promise<Principal | null>;

export const anonymous: Authenticate = async () => null;

export function requireAuth(principal: Principal | null): Principal {
  if (!principal) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in required');
  return principal;
}

const PROFESSIONAL_ROLES: readonly UserRole[] = ['LAWYER', 'JUDGE'];

/**
 * Professional features (point-in-time law, version history) need a LAWYER or JUDGE whose
 * credential is verified (TRD §12.2). ADMIN may use them too (App Flow §16). A professional
 * whose credential is still under review is a CITIZEN with status PENDING (App Flow §3).
 */
export function requireProfessional(principal: Principal | null, feature: string): Principal {
  if (!principal) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in required', `${feature} needs a signed-in lawyer or judge`);
  if (principal.role === 'ADMIN') return principal;
  if (principal.verificationStatus === 'PENDING' || (PROFESSIONAL_ROLES.includes(principal.role) && principal.verificationStatus !== 'VERIFIED')) {
    throw new ApiError(403, 'VERIFICATION_REQUIRED', 'Credential not verified yet', `${feature} is available once your credential is verified`);
  }
  if (!PROFESSIONAL_ROLES.includes(principal.role)) {
    throw new ApiError(403, 'ROLE_FORBIDDEN', 'Not available for this role', `${feature} is for lawyers and judges`);
  }
  return principal;
}
