---
subproject: backend
runner: nestjs+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos/upload.e2e-spec.ts
---

# Video Upload Test Plan

## Application Overview

Four HTTP endpoints of the `videos` module covering the upload lifecycle:

- `POST /videos/upload-init` — creates a `Video` row in `aguardando_upload` and starts a MinIO multipart upload; returns the `uploadId`, bucket, key, and the part size to use.
- `POST /videos/{videoId}/upload-part-url` — returns a presigned PUT URL for a specific part of the multipart.
- `POST /videos/{videoId}/upload-complete` — finalizes the multipart on MinIO, transitions the row to `processando`, and enqueues a `process-video` BullMQ job.
- `POST /videos/{videoId}/upload-abort` — aborts the multipart on MinIO and transitions the row to `erro`.

`upload-init` is rate-limited at 5 requests / 60s per user (per phase-02-auth/TD-08 + SI-03.6 `@Throttle`). The three `{videoId}` routes pass through `VideoOwnershipGuard` which rejects with `403 UPLOAD_NOT_OWNED` if the JWT's channel does not own the video. The error envelope `{ statusCode, error, message }` is the project standard from phase-02-auth/TD-07.

## Test Scenarios

### 1. Upload flow

**Setup:** Truncate `videos`, `refresh_tokens`, `verification_tokens` tables. Bootstrap a NestJS test module with `BullModule.forRoot` against the `redis` service, `StorageService` against the `minio` service, and seed:

- A test channel `ch1` owned by `user1` (the test authenticated user for the happy path).
- A second test channel `ch2` owned by `user2` (used by the ownership-mismatch scenario).
- A confirmed user record for `user1` and `user2`, plus a valid JWT (HS256, signed with the test secret) for each.

A `beforeEach` block re-seeds; `afterAll` closes the Nest app + kills Redis/BullMQ workers.

#### 1.1. upload-init happy path

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. POST /videos/upload-init com `Authorization: Bearer <user1 jwt>` e body `{"mimeType": "video/mp4"}`
    - expect: status 201
    - expect: body shape `{ videoId: <21 chars URL-safe>, uploadId: <non-empty string>, bucket: "streamtube-videos", key: "videos/<ch1.id>/<videoId>/source.mp4", partSize: 5242880 }`
  2. SELECT id, status, source_key, upload_id FROM videos WHERE id = <videoId>
    - expect: status = 'aguardando_upload'
    - expect: source_key = "videos/<ch1.id>/<videoId>/source.mp4"
    - expect: upload_id IS NOT NULL
  3. HEAD do S3 contra o MinIO no `key` + `uploadId` retornados (via SDK ou HTTP direto)
    - expect: MinIO confirma que o multipart está em curso (ou 404 se ainda não há parts — ambos aceitáveis; o ponto é que a chave foi criada)

#### 1.2. upload-init auth + throttle errors

**Covers AC:** #2, #3
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. POST /videos/upload-init sem header `Authorization`
    - expect: status 401
    - expect: body `{ statusCode: 401, error: "UNAUTHENTICATED", message: <string> }`
  2. POST /videos/upload-init com `Authorization: Bearer <user1 jwt>` 6 vezes consecutivas em < 60s
    - expect: as 5 primeiras retornam 201
    - expect: a 6ª chamada retorna 429
    - expect: body da 6ª `{ statusCode: 429, error: "TOO_MANY_REQUESTS", message: <string> }`
  3. Limpar as 5 linhas `videos` criadas (cleanup) para o próximo cenário não ser afetado pelo throttling — usar `TRUNCATE videos` no `afterEach` deste scenario.

#### 1.3. upload-part-url ownership + validation

**Covers AC:** #4, #5
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. Setup: dois `upload-init` calls — um com JWT do `user1` (gera `video1Id` em `ch1`), outro com JWT do `user2` (gera `video2Id` em `ch2`).
  2. POST /videos/<video2Id>/upload-part-url com `Authorization: Bearer <user1 jwt>` e body `{"partNumber": 1}`
    - expect: status 403
    - expect: body `{ statusCode: 403, error: "UPLOAD_NOT_OWNED", message: <string> }`
  3. POST /videos/<video1Id>/upload-part-url com `Authorization: Bearer <user1 jwt>` e body `{"partNumber": 0}`
    - expect: status 400 (validation error do ValidationPipe)
    - expect: body error field `error: "VALIDATION_ERROR"` (alinhado ao envelope de phase-02-auth/TD-06 + TD-07)
  4. POST /videos/<video1Id>/upload-part-url com `Authorization: Bearer <user1 jwt>` e body `{"partNumber": 1}`
    - expect: status 200
    - expect: body shape `{ url: <https://minio:9000/... presigned URL>, expiresAt: <ISO-8601, ~1h from now> }`
    - expect: a URL é parseável e o host é `minio:9000` (com `path-style` `/streamtube-videos/videos/...`)

#### 1.4. upload-complete happy + validation

**Covers AC:** #6, #7
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. POST /videos/<video1Id>/upload-complete com body `{"parts": []}`
    - expect: status 400
    - expect: body error `error: "VALIDATION_ERROR"` (validation: `@ArrayMinSize(1)`)
  2. Setup happy-path: gerar presign URL para part 1 (cenario 1.3 step 4); fazer PUT real de um buffer de 5MB (`Buffer.alloc(5 * 1024 * 1024)`) para essa URL; capturar o header `ETag` da response.
  3. POST /videos/<video1Id>/upload-complete com body `{"parts": [{"partNumber": 1, "etag": "<etag-com-as-pas-duplas>"}]}`
    - expect: status 200
    - expect: body shape `{ videoId: <video1Id>, status: "processando", queuedJobId: <bullmq jobId, non-empty string> }`
  4. SELECT status, upload_id FROM videos WHERE id = <video1Id>
    - expect: status = 'processando'
    - expect: upload_id IS NULL (cleared on complete)
  5. Verificar o job na fila: `queue.getJob(<queuedJobId>)` retorna um job com `data = { videoId: <video1Id>, channelId: <ch1.id>, sourceKey: "videos/<ch1.id>/<video1Id>/source.mp4" }` e `opts.attempts = 3`, `opts.backoff = { type: 'exponential', delay: 1000 }`.
  6. HEAD do S3 contra o `sourceKey` no MinIO
    - expect: 200 OK (object foi finalizado)

#### 1.5. upload-abort happy + ownership

**Covers AC:** _(no AC — endpoint is exercised by the Tests table; abort has no explicit AC bullet in SI-03.6's `Acceptance criteria:`)_
**Source:** auto
**Last sync:** 2026-06-28T18:44:07Z

**Steps:**
  1. Setup: gerar `video3Id` em `ch1` via `upload-init`.
  2. POST /videos/<video3Id>/upload-abort com `Authorization: Bearer <user1 jwt>`
    - expect: status 204
    - expect: row.status = 'erro', row.failure_reason = 'aborted by user'
    - expect: o multipart no MinIO foi abortado (HEAD no `sourceKey` retorna 404)
  3. POST /videos/<video2Id>/upload-abort com `Authorization: Bearer <user1 jwt>` (video2 é de user2)
    - expect: status 403
    - expect: body `error: "UPLOAD_NOT_OWNED"`
