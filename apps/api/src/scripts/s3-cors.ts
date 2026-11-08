import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@lawassist/config';

/**
 * Lets the web app upload straight to the bucket with presigned PUTs (TRD §8.1): browsers send a
 * CORS preflight first, which the bucket refuses unless it allows the web origin. Only PUT, only
 * from WEB_ORIGIN, only the signed headers. Local dev: `pnpm --filter @lawassist/api s3:cors`
 * after `docker compose up`. AWS: the same rule is set on the bucket by infrastructure code.
 */
const cfg = loadConfig();
const s3 = new S3Client({
  region: cfg.S3_REGION,
  ...(cfg.S3_ENDPOINT ? { endpoint: cfg.S3_ENDPOINT, forcePathStyle: true } : {}),
  ...(cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY } } : {}),
});
const rules = [
  {
    AllowedOrigins: [cfg.WEB_ORIGIN],
    AllowedMethods: ['PUT'],
    AllowedHeaders: ['content-type', 'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id'],
    MaxAgeSeconds: 3000,
  },
];
await s3.send(new PutBucketCorsCommand({ Bucket: cfg.S3_BUCKET, CORSConfiguration: { CORSRules: rules } }));
const applied = await s3.send(new GetBucketCorsCommand({ Bucket: cfg.S3_BUCKET }));
console.log(`CORS on ${cfg.S3_BUCKET}: PUT from ${applied.CORSRules?.[0]?.AllowedOrigins?.join(', ')}`);
