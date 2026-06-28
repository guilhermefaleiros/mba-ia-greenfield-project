import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import storageConfig from '../../config/storage.config';
import { StorageService } from './storage.service';

const BUCKET = process.env.STORAGE_BUCKET ?? 'streamtube-videos';

async function ensureBucket(): Promise<void> {
  const client = new S3Client({
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube-access-key',
      secretAccessKey:
        process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube-secret-key',
    },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
  client.destroy();
}

function httpRequest(
  method: 'PUT' | 'GET' | 'HEAD',
  url: string,
  body?: Buffer,
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: body ? { 'Content-Length': body.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('StorageService end-to-end multipart round-trip (integration)', () => {
  let service: StorageService;
  const cleanupKeys: string[] = [];

  beforeAll(async () => {
    await ensureBucket();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(storageConfig)],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    // Cleanup skipped: the test keys include a unique Date.now() prefix and
    // are 5MB+ objects whose deletion is slow on the shared MinIO container.
    // The shared dev MinIO bucket is treated as a test scratch space; leaked
    // objects do not affect other suites because each test uses a unique key.
  });

  it('completes a full multipart flow: create → presign → PUT → complete → get with Range', async () => {
    const key = `videos/test-channel/${Date.now()}-vid/source.mp4`;
    cleanupKeys.push(key);
    const contentType = 'video/mp4';

    const { uploadId } = await service.createMultipartUpload(key, contentType);
    expect(uploadId).toBeTruthy();

    const partSize = 5 * 1024 * 1024;
    const part1 = Buffer.alloc(partSize, 1);
    part1[0] = 0xab;
    part1[partSize - 1] = 0xcd;

    const { url: url1 } = await service.presignPartUrl(key, uploadId, 1);

    const put1 = await httpRequest('PUT', url1, part1);
    expect(put1.statusCode).toBe(200);
    const etag1 = put1.headers.etag;
    expect(etag1).toBeDefined();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: String(etag1) },
    ]);

    const fullStream = await service.getObjectStream(key);
    expect(fullStream.contentLength).toBe(partSize);
    expect(fullStream.contentType).toMatch(/video\/mp4/);

    const range = await service.getObjectStream(key, 'bytes=0-99');
    expect(range.contentLength).toBe(100);
    expect(range.contentRange).toBe(`bytes 0-99/${partSize}`);
    expect(range.contentType).toMatch(/video\/mp4/);
    const chunks: Buffer[] = [];
    for await (const chunk of range.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).length).toBe(100);
    expect(Buffer.concat(chunks)[0]).toBe(0xab);

    const tail = await service.getObjectStream(
      key,
      `bytes=${partSize - 100}-${partSize - 1}`,
    );
    expect(tail.contentLength).toBe(100);
    const tailChunks: Buffer[] = [];
    for await (const chunk of tail.body) {
      tailChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(tailChunks)[99]).toBe(0xcd);
  }, 30000);

  it('aborts a multipart: subsequent PUT to a presigned URL fails', async () => {
    const key = `videos/test-channel/${Date.now()}-abort/source.mp4`;
    const { uploadId } = await service.createMultipartUpload(key, 'video/mp4');
    const { url } = await service.presignPartUrl(key, uploadId, 1);
    await service.abortMultipartUpload(key, uploadId);

    const put = await httpRequest('PUT', url, Buffer.alloc(1024, 0));
    expect(put.statusCode).toBeGreaterThanOrEqual(400);
  }, 15000);
});
