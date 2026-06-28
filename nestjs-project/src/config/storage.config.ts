import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || 'streamtube-access-key',
  secretAccessKey:
    process.env.STORAGE_SECRET_ACCESS_KEY || 'streamtube-secret-key',
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  forcePathStyle: true,
}));
