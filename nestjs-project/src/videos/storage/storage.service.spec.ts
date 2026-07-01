import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
}

describe('StorageService (real SDK against MinIO)', () => {
  let service: StorageService;
  const testKeys: string[] = [];

  beforeAll(async () => {
    await ensureBucket();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forFeature(storageConfig)],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  afterAll(async () => {
    const client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId:
          process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube-access-key',
        secretAccessKey:
          process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube-secret-key',
      },
    });
    await Promise.all(
      testKeys.map((k) =>
        client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })),
      ),
    );
    client.destroy();
  });

  function makeKey(prefix: string): string {
    const key = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    testKeys.push(key);
    return key;
  }

  function toBuffer(chunk: Buffer | Uint8Array | string): Buffer {
    if (Buffer.isBuffer(chunk)) {
      return chunk;
    }

    return Buffer.from(chunk);
  }

  it('presignPartUrl returns a URL with minio host, path-style, and AWS4-HMAC-SHA256 query', async () => {
    const key = makeKey('presign-test');
    const { uploadId } = await service.createMultipartUpload(key, 'video/mp4');

    const { url, expiresAt } = await service.presignPartUrl(key, uploadId, 1);

    const parsed = new URL(url);
    expect(parsed.host).toBe('minio:9000');
    expect(parsed.pathname).toContain(`/${BUCKET}/${key}`);
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(parsed.searchParams.get('partNumber')).toBe('1');
    expect(parsed.searchParams.get('uploadId')).toBe(uploadId);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('presignPartUrl respects a custom expiresIn', async () => {
    const key = makeKey('presign-expires');
    const { uploadId } = await service.createMultipartUpload(key, 'video/mp4');
    const { url } = await service.presignPartUrl(key, uploadId, 2, 60);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('putObject + getObjectStream (no range) returns the same buffer and full contentLength', async () => {
    const key = makeKey('put-get');
    const data = Buffer.from('hello-storage-service');
    await service.putObject(key, data, 'text/plain');

    const result = await service.getObjectStream(key);

    expect(result.contentLength).toBe(data.length);
    expect(result.contentRange).toBeUndefined();
    expect(result.contentType).toMatch(/text\/plain/);
    const chunks: Buffer[] = [];
    for await (const chunk of result.body as AsyncIterable<
      Buffer | Uint8Array | string
    >) {
      chunks.push(toBuffer(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe(data.toString());
  });

  it('getObjectStream with Range header returns contentRange and the requested contentLength', async () => {
    const key = makeKey('range-get');
    const data = Buffer.alloc(2048, 'a');
    await service.putObject(key, data, 'text/plain');

    const result = await service.getObjectStream(key, 'bytes=0-1023');

    expect(result.contentLength).toBe(1024);
    expect(result.contentRange).toBe(`bytes 0-1023/${data.length}`);
    const chunks: Buffer[] = [];
    for await (const chunk of result.body as AsyncIterable<
      Buffer | Uint8Array | string
    >) {
      chunks.push(toBuffer(chunk));
    }
    expect(Buffer.concat(chunks).length).toBe(1024);
  });

  it('completeMultipartUpload succeeds with at least one part; empty parts list is rejected by the SDK', async () => {
    const key = makeKey('complete-empty');
    const { uploadId } = await service.createMultipartUpload(key, 'video/mp4');

    await expect(
      service.completeMultipartUpload(key, uploadId, []),
    ).rejects.toThrow();

    await service.abortMultipartUpload(key, uploadId);
  });

  it('abortMultipartUpload is idempotent and removes the multipart', async () => {
    const key = makeKey('abort');
    const { uploadId } = await service.createMultipartUpload(key, 'video/mp4');

    await service.abortMultipartUpload(key, uploadId);
  });
});
