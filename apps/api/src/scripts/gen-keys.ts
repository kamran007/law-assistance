/**
 * Prints a fresh ES256 key pair and OTP key as .env lines for LOCAL development:
 *   pnpm --filter @lawassist/api keys >> ../../.env
 * Deployed environments get their keys from AWS Secrets Manager, never from this script's output.
 */
import { randomBytes } from 'node:crypto';
import { TokenService } from '../modules/auth/tokens';

const { privatePem, publicPem } = await TokenService.generatePem();
const oneLine = (pem: string) => pem.trim().replace(/\n/g, '\\n');
process.stdout.write(`JWT_PRIVATE_KEY=${oneLine(privatePem)}\nJWT_PUBLIC_KEY=${oneLine(publicPem)}\nOTP_HMAC_KEY=${randomBytes(32).toString('hex')}\n`);
