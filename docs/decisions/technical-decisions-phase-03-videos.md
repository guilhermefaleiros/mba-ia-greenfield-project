---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-28
scope_description: "Backend infrastructure for video upload (up to 10GB), background processing queue, FFmpeg worker, object storage, streaming/download, unique-URL strategy, and the video status lifecycle — Phase 03 capabilities."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (entity, repository, service, controller), the S3/MinIO storage service, the queue producer, the FFmpeg worker (separate container), and the compose infrastructure for storage + queue + worker.
- `next-frontend/` — Frontend deferred for this phase (the PROMPT defines Phase 03 as a backend challenge; the UI surface for video upload/player is out of scope). No open _frontend_ decision here, but two **cross-layer** contracts (upload handshake TD-02, streaming/download TD-03) are decided now so a future frontend can consume them without renegotiation.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the message queue explicitly "TBD" — the single genuinely open stack decision of the phase. The API must publish a `process-video` job once an upload completes, and a worker must consume it to run ffprobe + thumbnail extraction. PostgreSQL is already in the stack; Redis is not. The choice dictates a new container in `compose.yaml` and a new dependency surface. Touches both API (producer) and worker (consumer).

**Options:**

### Option A: pg-boss (PostgreSQL-backed queue)

- Jobs live in dedicated `pgboss_*` tables inside the existing PostgreSQL database; workers poll via `SELECT ... FOR UPDATE SKIP LOCKED`. No new runtime service. NestJS integration is a thin custom provider wrapping `PgBoss`.
- **Pros:** Zero new infrastructure — reuses the `db` Compose service; no Redis container or extra persistence to operate. Transactions: enqueue a job in the same DB transaction that writes the video row (`rascunho` → move forward), avoiding a dual-write inconsistency between DB and queue. Mature (high reputation), full TypeScript types, concurrency controls (`localConcurrency`, `groupConcurrency`), heartbeats and AbortSignal. Migration versioning stays in one place.
- **Cons:** Polling-based (default 2s) — slightly higher latency than Redis pub/sub for the hot path, though video processing is not latency-sensitive. Job throughput is bounded by Postgres; fine for video-scale (minutes-long jobs, low jobs/min). Requires the queue to share DB resources with app load (mitigated since processing is I/O-bound, not CPU-bound, on the DB side).

### Option B: BullMQ (Redis-backed queue)

- The de-facto Node queue. Requires a Redis container. NestJS integration via `@nestjs/bullmq`. Workers consume with concurrency, retries, priorities, delayed jobs, and a dashboard (Bull Board).
- **Pros:** Purpose-built queue semantics — lowest latency, high throughput, rich feature set (priorities, rate limiting, parent-child flows), large ecosystem and community, official NestJS package.
- **Cons:** Adds Redis to `compose.yaml` and the production story — a second stateful service to operate, back up, and monitor. Dual-write problem: publishing a job is not atomic with the PostgreSQL video-row insert, so a crash between commit and enqueue (or vice-versa) can desync. More moving parts for a phase whose queue depth is one job per upload.

### Option C: Custom `FOR UPDATE SKIP LOCKED` over a `jobs` table

- Hand-roll a `video_jobs` table, a producer that `INSERT`s a row, and a worker that polls with `FOR UPDATE SKIP LOCKED`, deletes/updates on completion.
- **Pros:** Minimal dependencies (same as A, no new library). Full control; exact schema matches domain.
- **Cons:** Reimplements what pg-boss already provides — heartbeats, retries, concurrency, throttling, schema migrations, edge cases. High maintenance surface for a feature that is not differentiating. Loses the battle-tested queue semantics without saving meaningfully over Option A.

**Recommendation:** **Option A (pg-boss)** — It keeps the infrastructure footprint to services already in the stack (PostgreSQL), gives a transactional enqueue (DB row + job in one transaction — the single biggest correctness argument against a Redis-backed queue here), and supplies production-grade semantics (concurrency, heartbeats, retries) without reimplementing `SKIP LOCKED`. Redis/BullMQ's latency advantage is irrelevant for multi-minute video jobs; its operational and dual-write cost is not.

**Decision:** B
**Libraries:** `bullmq`, `@nestjs/bullmq`

---

## TD-02: Large-File Upload Strategy (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The hard requirement is that a 10GB upload must not tie up the NestJS/Express process. Streaming the file through the API multiplies memory and bandwidth and is an automatic rejection per the PROMPT. The client must therefore push bytes directly to object storage; the API only brokers the handshake. The choice fixes a contract both backend (sign the URL, expose completion endpoint) and a future frontend (upload flow) must follow. The "pré-cadastro as rascunho on upload start" capability means a draft `videos` row keyed by a server-generated storage key is created before any bytes flow.

**Options:**

### Option A: S3 presigned multipart (createMultipartUpload → presign each part → CompleteMultipartUpload)

- The API creates the draft video row + storage key, calls `CreateMultipartUpload` against MinIO, returns presigned PUT URLs for each part; the client uploads parts directly to MinIO and calls a completion endpoint that finalizes the multipart upload and enqueues the processing job.
- **Pros:** Never streams through the API — bytes go straight to MinIO. Native S3 multipart supports resumable uploads (a dropped part retries independently) and parallel part uploads, mandatory for 10GB. MinIO implements the exact S3 multipart API the AWS SDK v3 targets. Presigned URLs keep credentials off the client.
- **Cons:** More handshake endpoints (initiate, per-part URL, complete, abort) and a thin part-tracking table (or relying on `uploadId` + part ETags in the completion payload). Slightly more frontend ceremony.

### Option B: Single presigned PUT URL (`PutObject` presigned)

- The API returns one presigned PUT URL; the client streams the whole object in a single PUT. MinIO accepts very large objects in one PUT (within its max).
- **Pros:** Minimal handshake — one `GET /videos/upload-url` and one PUT. Simplest frontend flow.
- **Cons:** No resume-on-failure — a 9GB upload that drops at 8GB restarts from zero. Single HTTP request lifetime for 10GB is brittle on flaky connections; no parallelism. Violates the PROMPT note ("permita retomar em caso de falha de conexão").

### Option C: Chunked multipart streamed through the API (`@nestjs/platform-express` multipart + S3 `lib-storage` Upload)

- The API receives the multipart stream and relays parts to MinIO using `@aws-sdk/lib-storage` `Upload`.
- **Pros:** Centralized control, easy auth, client never talks to MinIO directly.
- **Cons:** Keeps the entire transfer through the NestJS process — exactly the failure mode the PROMPT names as an automatic rejection ("Passar o arquivo de 10GB pela API de forma que trave o sistema"). Adds memory pressure and couples API scaling to upload size.

**Recommendation:** **Option A (presigned multipart)** — Direct-to-storage multipart is the only option that keeps the API unblocked, supports resume for 10GB transfers (explicitly required), and parallelizes part uploads. Option B drops resume; Option C is the automatic-rejection case. MinIO + AWS SDK v3 implement the S3 multipart contract exactly, so the code is the same against S3 in production.

**Decision:** A
**Libraries:** — _(no new packages — uses AWS SDK v3 from TD-04 for `Range` `GetObject` and 206 proxy)_

---

## TD-03: Streaming & Download Strategy

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must start before the whole file is downloaded (range/seek support). A download capability must also exist. The decision fixes how a future frontend player requests bytes and whether the API or MinIO serves them. Constrained by TD-04 (storage client) and by the need to support `Range` requests for seek.

**Options:**

### Option A: API-mediated range proxy (206 Partial Content) via `GetObject` with `Range`

- The frontend player hits `GET /videos/:id/stream`; the controller parses `Range`, calls MinIO `GetObject` with a `Range` header, and pipes the partial response back with `Content-Range`/`Accept-Ranges: bytes` and status 206. Download is the same path with a `download` query forcing `Content-Disposition: attachment`.
- **Pros:** Authorization stays on the API — CDN URL cannot leak; `unlisted` videos (Phase 04) can be gated later by the same guard; one consistent base URL for player and download; no presigned-URL expiry window to manage mid-playback.
- **Cons:** Bytes flow through the API process again — but only the requested range (streaming, not buffering 10GB), and Node streams make this cheap. Adds API bandwidth cost in production; a real CDN in front of MinIO is the long-term fix, but not this phase.

### Option B: Presigned `GetObject` URL served directly to the player

- The API returns a short-lived presigned GetObject URL; the player fetches bytes directly from MinIO, which honors `Range` natively.
- **Pros:** Bandwidth off the API. Simplest for anonymous public playback.
- **Cons:** URL-bearing auth model (anyone with the URL fetches the object for its TTL) breaks once `unlisted`/gated playback lands in Phase 04 — needs a per-request signed URL per seek range, complicating the player. Presigned URLs can expire mid-playback on long videos. Leaks object-store origin to the client.

### Option C: Stream through API, fetch full object, no range support

- One endpoint returns the whole object as a 200 stream; the player's own buffering handles seek by re-requesting.
- **Cons:** No native seek — a seek re-downloads everything that was already discarded. Violates "reprodução sem download completo" on seek. Effectively not streaming.

**Recommendation:** **Option A (API range proxy)** — It satisfies the streaming requirement (206 + `Range`) and reuse for download with one auth path, while keeping the door open for Phase 04 gating (`unlisted`) without re-architecting. The per-range bytes-through-API cost is acceptable in dev/local and resolves to a CDN in production; presigned direct URLs (Option B) would need to be thrown away the moment Phase 04 introduces access control.

**Decision:** A
**Libraries:** — _(no new packages — uses AWS SDK v3 from TD-04 for presign)_

---

## TD-04: Object Storage Client & Key/Path Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage backend is fixed (S3-compatible, MinIO locally). The open decision is the client library and the bucket/kernel key layout — used by both the API (presign + download proxy) and the worker (reads the source, writes the thumbnail). The client must support `createMultipartUpload`, `presign`, `GetObject(Range)`, and a MinIO custom endpoint. Cross-component (cited in storage service + worker + compose env).

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`

- Use the modular AWS SDK v3 pointed at the MinIO endpoint (`endpoint`, `forcePathStyle: true`, static credentials). Same code targets S3 in production by swapping env. `getSignedUrl` covers multipart part presigning and GetObject presign (fallback).
- **Pros:** Industry standard, modular (tree-shakeable), first-class TypeScript, official `@aws-sdk/lib-storage` `Upload` for worker-side streaming, supports `Range` `GetObject` for TD-03's proxy, well-documented MinIO compatibility. One client in both API and worker.
- **Cons:** Two packages (`client-s3` + `s3-request-presigner`) and the multipart presigning needs `CreateMultipartUploadCommand` + a loop of `UploadPartCommand`. Slightly more verbose than `minio`.

### Option B: `minio` JS client

- The official MinIO client. Presigned URLs, multipart, range gets via `getObject` with offset/length.
- **Pros:** Purpose-built for MinIO; concise helpers for presigned `PUT`/`GET`. Single package.
- **Cons:** Production swap to real AWS S3 means learning a second client (two mental models) or rewriting. Smaller ecosystem than AWS SDK v3; the AWS SDK is the more transferable skill for the team and better documented via context7. `getObject` range API differs from S3 `Range` header semantics used by the TD-03 proxy.

**Recommendation:** **Option A (`@aws-sdk/client-s3` + `s3-request-presigner`)** — The code is production-portable to AWS S3 with only an env swap (matches the project's "MinIO locally, S3 in prod" stance), `Range` `GetObject` maps directly to TD-03's 206 proxy, and `lib-storage` gives the worker a streaming multipart helper. The `minio` client's MinIO convenience does not outweigh the production rewrite cost.

**Decision:** A
**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`

**Key/path organization (informal, decided alongside the client):** one bucket `streamtube-videos`; keys `videos/{channelId}/{videoId}/source.mp4` for the original and `videos/{channelId}/{videoId}/thumb.jpg` for the thumbnail — channel-scoped, stable, and trivial to prefix-list per channel for the Phase 04 panel.

---

## TD-05: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, URL-safe, collision-free identifier that doubles as the public path segment (`/v/:id` or Phase 05's watch route). It is stored on the `videos` table and is the public-facing handle; `uuid` PKs stay internal. Cross-component (entity column + URL contract + DTO field).

**Options:**

### Option A: `nanoid` (21-char URL-safe, custom-alphabet)

- `nanoid(21)` from the `nanoid` package; collision budget vastly exceeds the project's lifetime video count. Default alphabet is `A-Za-z0-9_-`.
- **Pros:** Short, URL-safe out of the box, no base64-width concerns, tiny package, deterministic-length for column sizing. Collision probability negligible for any plausible scale.
- **Cons:** Adds one small dependency. Not sortable (random order) — listing must sort by `created_at`, which is already the case.

### Option B: UUIDv4 (the same column type as the PK)

- Reuse the entity's `uuid` PK as the public URL id.
- **Pros:** Zero new code/packages. One id per row.
- **Cons:** 36-char UUIDs are ugly in a URL and leak row-creation structure; not "curta" as the PROMPT notes ("URL curta e única").

### Option C: ULID / UUIDv7 (sortable 26-char)

- Time-ordered, lexicographically sortable 26-char id.
- **Pros:** Sortable by creation, one source of truth for sort in indexes.
- **Cons:** 26 chars is longer than nanoid and the playlist/sort use case is already covered by `created_at`. Sortability buys little here; adds a dependency (or risky hand-rolling).

**Recommendation:** **Option A (nanoid)** — Short, collision-safe, and URL-safe, it matches the PROMPT's "URL curta e única" wording directly. The project already sorts listings by timestamp, so ULID's main value is unused. The dependency is one small, ubiquitous package with no tree-shake penalty.

**Decision:** A
**Libraries:** `nanoid`

---

## TD-06: Video Worker Architecture & FFmpeg Invocation

**Scope:** Repo-wide

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker is a separate container in `compose.yaml` that consumes `process-video` jobs (TD-01) and runs `ffprobe` for metadata/duration and `ffmpeg` to grab a thumbnail frame. Two sub-decisions: (i) the worker's runtime shape — a standalone NestJS bootstrap vs a plain Node script — and (ii) how to drive FFmpeg — the library wrapper `fluent-ffmpeg` vs spawning `ffprobe`/`ffmpeg` directly. This is repo-wide because it adds a container + image build + entrypoint.

**Options:**

### Option A: Standalone NestJS bootstrap + `fluent-ffmpeg`

- The worker is a separate NestJS app (`src/worker/main.ts` + a `WorkerModule`) sharing the storage service, queue consumer, and TypeORM connection with the API via the same module files; it boots the DI container and subscribes. `fluent-ffmpeg` wraps `ffprobe`/`ffmpeg` calls with a promise API.
- **Pros:** Reuses DI/config/repo/storage-service code from the API without divergence; one TS compilation, one lint config, one Dockerfile (parametrized entrypoint). `fluent-ffmpeg` gives progress events, clean promise wrapping, thumbnail extraction helpers.
- **Cons:** Carries the NestJS runtime overhead in a process that mostly spawns FFmpeg. Adds `fluent-ffmpeg` (occasionally unmaintained stretches) on top of the binary.

### Option B: Plain Node script + `child_process.spawn` of `ffprobe`/`ffmpeg`

- A standalone `src/worker/main.ts` bootstrap without the Nest container; instantiate pg-boss, the S3 client, and a TypeORM DataSource directly. Shell out to `ffprobe -v quiet -print_format json` and `ffmpeg -ss <n> -i in -frames:v 1 out.jpg`.
- **Pros:** Smallest possible surface — no DI, no wrapper lib, just `spawn` and parse JSON. Full control over FFmpeg args (codec selection, seek offset for the thumbnail). Fewer transitive deps.
- **Cons:** Duplicates DI seam: the worker re-instantiates storage/repo/config instead of importing modules, risking drift on env keys and DB options. TypeORM `DataSource` duplication versus the API's `data-source.ts`. Loses `fluent-ffmpeg`'s progress/event ergonomics.

### Option C: NestJS bootstrap + direct `child_process.spawn` (hybrid)

- Same standalone NestJS bootstrap as A (reuse DI/config/repos), but invoke FFmpeg directly via `spawn` instead of through `fluent-ffmpeg`.
- **Pros:** Keeps DI/DI code sharing with the API, avoids the `fluent-ffmpeg` dependency, and retains precise FFmpeg control. One Dockerfile, one lint config.
- **Cons:** Must hand-parse `ffprobe` JSON and assemble `ffmpeg` arg arrays — small, but explicit.

**Recommendation:** **Option A (standalone NestJS bootstrap + `fluent-ffmpeg`)** — Reusing the NestDI + config + repository seam from the API means the worker reads the same env-validated config (Dr/MinIO/queue host as Compose service names), imports the same `StorageService`, and avoids a parallel `data-source.ts`/config story. `fluent-ffmpeg` removes the boilerplate of composing `ffmpeg`/`ffprobe` arg arrays for the two operations this phase needs (metadata JSON, one thumbnail frame). Option B's minimalism costs a duplicated DI surface; Option C is a fine fallback if `fluent-ffmpeg` proves incompatible with the installed FFmpeg build, but A starts further along.

**Decision:** A
**Libraries:** `fluent-ffmpeg`

---

## TD-07: Video Status Lifecycle & Processing-Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The PROMPT requires an explicit cycle (`rascunho → processando → pronto/erro`) in the DB, plus defined behavior on failure. The machine is: a draft row at upload-init, a transition to `processando` when the worker picks the job, `pronto` on success (duration + thumbnail written), `erro` on exhausted retries. This state machine is cross-component: implied by TD-02 (init), TD-01 (queues), and TD-06 (worker), and exposed in every DTO/contract.

**Options:**

### Option A: Five-state enum + pg-boss retry budget (`rascunho`, `aguardando_upload`, `processando`, `pronto`, `erro`)

- `rascunho` at presign-init; → `aguardando_upload` until the client completes multipart; → `processando` when the worker claims the job; → `pronto` (writes `duration_seconds`, `metadata`, `thumbnail_key`) or `erro` (writes `failure_reason`). pg-boss exhausts its `retryLimit` (3 attempts with backoff) then marks `erro`; an `erro` video keeps its source file so the operator/user can re-enqueue manually.
- **Pros:** `aguardando_upload` cleanly distinguishes abandoned uploads (never completed) from processing failures — important for `erro` semantics and future cleanup. Reuses pg-boss retry/backoff instead of hand-rolling. Manual re-enqueue is a new job on the same row (idempotent on `videoId`).
- **Cons:** Five states is one more than the literal PROMPT cycle — `aguardando_upload` is an addition justified by distinguishing abandoned multipart uploads.

### Option B: Four-state enum exactly as the PROMPT (`rascunho`, `processando`, `pronto`, `erro`)

- Collapse the upload-wait into `rascunho`. On completion the worker moves `rascunho → processando`.
- **Pros:** Matches the PROMPT wording verbatim; simpler.
- **Cons:** Cannot tell an upload in progress from one that was abandoned (multipart started, never completed) — both stay `rascunho` forever. `erro` then conflates "upload never happened" with "processing failed," complicating the operator view and Phase 04's panel.

### Option C: Four-state enum + a separate `upload_completed_at` timestamp

- Keep the PROMPT's four states but add an `upload_completed_at` nullable column; `rascunho` with `upload_completed_at IS NULL` = in-progress, `IS NOT NULL` = stalling jacket.
- **Cons:** Pushes a state distinction into a nullable timestamp; two sources of truth for "upload is done." More brittle than a dedicated state and harder to read in queries than Option A.

**Recommendation:** **Option A (five-state enum + pg-boss retry budget)** — The added `aguardando_upload` state is the only way to distinguish "user abandoned the upload" from "worker failed," which is exactly what the failure-handling requirement asks for; conflating them in Quarter B means the operator panel (Phase 04) cannot show the right action. pg-boss's built-in retry/backoff removes hand-rolled retry logic, and `erro` keeping the source file makes manual re-enqueue a one-line idempotent operation.

**Decision:** A
**Libraries:** — _(no new packages — relies on the queue's built-in retry/backoff; see **Revisions:** block for queue-backend update from TD-01)_

**Revisions:**
- 2026-06-28 — Queue backend updated from pg-boss to BullMQ (per TD-01 user choice in this resolve cycle). Rationale: TD-01 user diverged from the pg-boss recommendation in favor of BullMQ + Redis. TD-07's "five-state enum + retry budget" pattern is queue-agnostic — the retry mechanism is now BullMQ's job options (`attempts`, `backoff`) instead of pg-boss's built-in retry/backoff. The `aguardando_upload` state machine and `erro` semantics are unchanged.

---

## Decisions Summary

| ID    | Scope       | Decision                                           | Recommendation                                                      | Choice                              | Libraries                                                                                     |
| ----- | ----------- | -------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| TD-01 | Backend     | Background Job Queue Technology                    | pg-boss (PostgreSQL)                                                | **B** (BullMQ + Redis — user diverged) | `bullmq`, `@nestjs/bullmq`                                                                    |
| TD-02 | Cross-layer | Large-File Upload Strategy (up to 10GB)            | Presigned multipart direct-to-storage                               | A                                   | — _(uses AWS SDK v3 from TD-04)_                                                              |
| TD-03 | Cross-layer | Streaming & Download Strategy                      | API-mediated 206 range proxy                                        | A                                   | — _(uses AWS SDK v3 from TD-04)_                                                              |
| TD-04 | Backend     | Object Storage Client & Key Organization           | AWS SDK v3 (`@aws-sdk/client-s3` + `s3-request-presigner`) on MinIO | A                                   | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`                |
| TD-05 | Backend     | Unique Video URL identifier                        | nanoid                                                              | A                                   | `nanoid`                                                                                      |
| TD-06 | Repo-wide   | Video Worker Architecture & FFmpeg Invocation      | Standalone NestJS bootstrap + `fluent-ffmpeg`                       | A                                   | `fluent-ffmpeg`                                                                               |
| TD-07 | Backend     | Video Status Lifecycle & Processing-Failure Policy | Five-state enum + pg-boss retry budget                              | A _(queue backend updated to BullMQ — see Revisions on TD-07)_ | — _(uses queue's built-in retry/backoff from TD-01)_                                          |
