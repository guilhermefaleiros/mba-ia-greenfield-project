---
libs:
  bullmq:
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-06-28T15:31:35-03:00"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-06-28T15:31:35-03:00"
  nanoid:
    version: "^5.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-06-28T15:31:35-03:00"
  fluent-ffmpeg:
    version: "^2.1.x"
    context7_id: "/thedave42/node-fluent-ffmpeg"
    fetched_at: "2026-06-28T15:31:35-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-28T15:31:35-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-28T15:31:35-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-28T15:31:35-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-28T15:29:30-03:00"
---

# Phase 03 — Library Reference Cache

> Library documentation cache for the libraries decided in Phase 03. Each entry pins a Context7-fetched doc excerpt relevant to the TDs that introduced the lib. Sync'd by `/plan-resolve` (this file is the only library cache; per-scope `library-refs.md` files under other phase/task dirs byte-copy from here when a lib cross-propagates).

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7). **TD ref:** `phase-03-videos/TD-01`.

**Use in Phase 03:** Queue producer (API) and consumer (worker) for `process-video` jobs. Producer publishes when an upload completes (multipart finalize); worker (standalone NestJS bootstrap) consumes, runs `ffprobe` + thumbnail generation via `fluent-ffmpeg`, updates the `videos` row.

**Producer — adding a job with retry budget (TD-07):**

```ts
import { Queue } from 'bullmq';

const myQueue = new Queue('process-video');

await myQueue.add(
  'process',
  { videoId, channelId, sourceKey },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
);
```

The `attempts` + `backoff` combination is the BullMQ equivalent of pg-boss's built-in retry. The 5-state video status cycle (`rascunho → aguardando_upload → processando → pronto/erro`) is layered on top by the worker; BullMQ handles the retry budget.

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7; covers both `@nestjs/bull` and `@nestjs/bullmq` packages). **TD ref:** `phase-03-videos/TD-01` and `phase-03-videos/TD-06`.

**Use in Phase 03:** NestJS integration for BullMQ. The API process uses `@InjectQueue('process-video')` to publish; the standalone worker bootstrap uses `@Processor('process-video')` with a `WorkerHost` subclass. Both processes share the same `BullModule.forRoot({ connection: { host, port } })` config via the project's namespaced `registerAs` pattern.

**Worker — `WorkerHost` pattern (per Context7):**

```ts
@Processor('process-video')
class VideoProcessor extends WorkerHost {
  async process(job: Job<ProcessVideoData>): Promise<any> {
    // ffprobe + thumbnail
  }
}
```

**Module wiring with config injection (per project's registerAs pattern):**

```ts
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});
```

## nanoid

**Source:** `/ai/nanoid` (Context7). **TD ref:** `phase-03-videos/TD-05`.

**Use in Phase 03:** Generate the public `videos.id` URL segment (the 21-char string the player/UI uses in `/v/{id}`). Collision budget exceeds the project's lifetime video count; URL-safe out of the box.

**Default 21-char generator (matches the chosen TD-05 Option A):**

```ts
import { nanoid } from 'nanoid';

const id = nanoid();  // e.g., "V1StGXR8_Z5jdHi6B-myT"
```

The default alphabet is `A-Za-z0-9_-` (64 chars, URL-safe). Default size is 21 — collision probability equivalent to UUID v4 per nanoid's docs. No configuration needed for the Phase 03 use case.

## fluent-ffmpeg

**Source:** `/thedave42/node-fluent-ffmpeg` (Context7). **TD ref:** `phase-03-videos/TD-06`.

**Use in Phase 03:** Worker invokes `ffprobe` for metadata (duration, codec, resolution) and `ffmpeg` to extract a thumbnail frame at a target timestamp. Both require the `ffmpeg` binary on the worker's container PATH — Dockerfile adds the `ffmpeg` package.

**Read video metadata (per fluent-ffmpeg README):**

```js
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.ffprobe('/path/to/source.mp4', (err, metadata) => {
  if (err) return reject(err);
  // metadata.streams[0] = video stream (codec, width, height, duration)
  // metadata.format    = container (duration, bit_rate, size)
  const durationSeconds = parseFloat(metadata.format.duration);
});
```

**Generate thumbnail (per fluent-ffmpeg recipes):**

```js
ffmpeg(inputPath)
  .on('end', () => resolve())
  .on('error', reject)
  .screenshots({
    count: 1,
    timemarks: ['10%'],         // frame at 10% of duration
    folder: '/tmp',
    filename: 'thumb.jpg',
    size: '1280x720',
  });
```

The `.screenshots()` API also accepts `timestamps: ['00:00:05']` for an absolute seek. The worker writes the resulting file to the storage bucket under `videos/{channelId}/{videoId}/thumb.jpg`.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7; umbrella doc covers `client-s3`, `s3-request-presigner`, and `lib-storage`). **TD ref:** `phase-03-videos/TD-04`; also used by TD-02, TD-03, TD-06.

**Use in Phase 03:** All S3-compatible operations against MinIO. The `S3Client` is configured with a custom `endpoint` and `forcePathStyle: true` so the same code targets MinIO in dev and AWS S3 in production (env swap only).

**Client wiring for MinIO (per AWS SDK v3 test fixtures):**

```ts
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,    // e.g., "http://minio:9000" in compose
  region: process.env.S3_REGION,        // required by SDK even for MinIO
  forcePathStyle: true,                 // path-style for MinIO compatibility
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});
```

**Range `GetObject` for streaming proxy (TD-03):**

```ts
import { GetObjectCommand } from '@aws-sdk/client-s3';

const out = await s3.send(new GetObjectCommand({
  Bucket: 'streamtube-videos',
  Key: sourceKey,
  Range: req.headers.range,    // e.g., "bytes=0-1048575"
}));
// out.Body is a Readable; pipe to res with 206 status and Content-Range header
```

**Multipart upload (TD-02, used in presign-initiate and presign-part endpoints):**

```ts
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

const created = await s3.send(new CreateMultipartUploadCommand({
  Bucket: 'streamtube-videos',
  Key: sourceKey,
  ContentType: 'video/mp4',
}));
// created.UploadId + per-part UploadPartCommand(UploadId, partNumber, Body) presign
// + CompleteMultipartUploadCommand(UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }, ...] })
// + AbortMultipartUploadCommand on client-side failure
```

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (umbrella doc). **TD ref:** `phase-03-videos/TD-02`, `TD-04`.

**Use in Phase 03:** Generate presigned URLs for the multipart upload handshake (TD-02). The API issues per-part presigned `PUT` URLs that the client uses to upload each chunk directly to MinIO. Same code, same `S3Client`, just a different command.

**Per-part presign (per the package README):**

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand } from '@aws-sdk/client-s3';

const url = await getSignedUrl(
  s3,
  new UploadPartCommand({
    Bucket: 'streamtube-videos',
    Key: sourceKey,
    UploadId,
    PartNumber: i,
  }),
  { expiresIn: 3600 },  // 1h window per part
);
```

The presign pattern keeps AWS credentials off the client and out of the API's per-byte path.

## @aws-sdk/lib-storage

**Source:** `/aws/aws-sdk-js-v3` (umbrella doc). **TD ref:** `phase-03-videos/TD-06` (worker-side streaming).

**Use in Phase 03:** The worker uses `lib-storage`'s `Upload` class to **read** the source from MinIO as a stream (the upload already went to MinIO via presigned multipart — the worker doesn't write to S3 from the original file; lib-storage is for the multipart-write case when/if Phase 04+ needs server-side transcoding outputs written back to S3). For Phase 03's worker, `lib-storage`'s `Upload` is on the dependency surface for forward-compat; the actual source read is via `GetObjectCommand` (stream) piped to `ffmpeg`/`ffprobe`.

**Forward-compat pattern (if/when worker writes back to S3):**

```ts
import { Upload } from '@aws-sdk/lib-storage';

const uploader = new Upload({
  client: s3,
  params: { Bucket: 'streamtube-videos', Key: thumbKey, Body: thumbStream },
  queueSize: 4,                  // concurrent part uploads
  partSize: 1024 * 1024 * 5,     // 5MB minimum
  leavePartsOnError: false,
});

uploader.on('httpUploadProgress', (p) => log.info({ p }, 'thumb upload progress'));
await uploader.done();
```

For Phase 03 the worker only **reads** from S3 (`GetObjectCommand` stream) and writes thumbnails locally before `PutObject`-ing the final thumbnail — `@aws-sdk/client-s3` is sufficient. `@aws-sdk/lib-storage` is kept in the dependency surface for the streaming-write future (Phase 04+ transcoding outputs).
