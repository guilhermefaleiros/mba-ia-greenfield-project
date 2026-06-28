# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

**Current state:** Phases 01 (config base) + 02 (auth/users/channels) + 03 (upload + background processing + streaming) are implemented in the backend. Frontend (`next-frontend/`) is not yet initialized.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md). Phase 03 walkthrough: [SUBMIT.md](SUBMIT.md). Per-SI log: [docs/phases/phase-03-videos/progress.md](docs/phases/phase-03-videos/progress.md).

## Repository Structure

This is a monorepo with the following areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Modules: `auth/`, `users/`, `channels/`, `videos/`, plus a separate `worker/` (NestJS standalone bootstrap, not HTTP).
- `docs/` — Project documentation, architecture diagrams, and per-phase plans + progress logs.
- `next-frontend/` (Next.js) — not yet initialized.

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js, future) → calls API via REST, streams from Object Storage
- **API** (NestJS) → business rules, auth, reads/writes DB, talks to Storage + Queue, sends emails
- **Video Worker** (NestJS standalone) → consumes `process-video` jobs from BullMQ, runs `ffprobe` + `ffmpeg` via `fluent-ffmpeg`, uploads thumbnail to Storage, updates DB. Bootstrap: `src/worker/main.ts` (no HTTP).
- **Database** (PostgreSQL) → users, channels, refresh_tokens, verification_tokens, **videos** (Phase 03)
- **Object Storage** (MinIO in dev / S3 in prod) → video files at `videos/{channelId}/{videoId}/source.mp4` and thumbnails at `videos/{channelId}/{videoId}/thumb.jpg`
- **Message Queue** (BullMQ + Redis) → `process-video` queue with `attempts: 3, backoff: exponential 1s`
- **Email Service** (Mailpit in dev / SMTP in prod) → account confirmation + password reset

### Phase 03 data model

`videos` table: `id` (nanoid-21), `channel_id` (FK CASCADE), `title`, `description`, `status` (`rascunho`/`aguardando_upload`/`processando`/`pronto`/`erro`), `source_key`, `thumbnail_key`, `upload_id` (S3 multipart handle, null after `completeUpload`), `duration_seconds`, `width`, `height`, `size_bytes`, `mime_type`, `failure_reason`, `created_at`, `updated_at`. Indexes on `channel_id`, `status`, and `(channel_id, created_at DESC)`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names.

Compose service names in use:
- `db` — PostgreSQL 17
- `mailpit` — SMTP testing
- `minio` — S3-compatible storage (Phase 03)
- `redis` — BullMQ broker (Phase 03)
- `nestjs-api` — the HTTP API
- `video-worker` — the standalone worker (Phase 03)

`STORAGE_ENDPOINT=http://minio:9000`, `QUEUE_HOST=redis` in `.env` — the API talks to MinIO and Redis by service name, not `localhost`.

## Phase 03 modules (backend)

```
nestjs-project/src/
├── videos/
│   ├── entities/video.entity.ts        # @Entity('videos') with FK to channels
│   ├── storage/                        # StorageService (S3 multipart + Range/206)
│   │   ├── storage.service.ts          # createMultipartUpload, presignPartUrl,
│   │   │                                # completeMultipartUpload, abort,
│   │   │                                # getObjectStream (Range), putObject
│   │   ├── storage.keys.ts              # buildSourceKey/buildThumbnailKey
│   │   └── storage.module.ts
│   ├── queue/                          # QueueModule (BullMQ producer)
│   │   ├── videos-queue.constants.ts   # VIDEOS_QUEUE_NAME = 'process-video'
│   │   ├── videos-queue.module.ts      # BullModule.forRoot + registerQueue
│   │   └── videos-queue.producer.ts     # @InjectQueue, enqueueProcessVideo
│   ├── streaming/
│   │   ├── range-parser.util.ts        # parseRangeHeader: bytes=start-end
│   │   └── range-parser.util.spec.ts   # 10 unit tests
│   ├── guards/video-ownership.guard.ts # checks video.channel_id === user.channelId
│   ├── dto/                             # UploadInitDto, UploadPartUrlDto, UploadCompleteDto
│   ├── videos.repository.ts            # @InjectRepository(Video)
│   ├── videos.service.ts               # initUpload/getPresignedPartUrl/
│   │                                    # completeUpload (transaction) /abortUpload
│   ├── videos.service.spec.ts          # 12 unit tests (mocked deps)
│   ├── videos.service.integration-spec.ts # 4 integration tests (real DB+MinIO+Redis)
│   ├── videos.controller.ts            # 6 endpoints + OpenAPI decorators
│   └── videos.module.ts                # TypeOrm + Storage + Queue + VideosController
├── worker/                             # Standalone NestJS bootstrap (no HTTP)
│   ├── worker.module.ts                # Config + TypeORM + Bull + Storage
│   ├── video-processor.service.ts      # @Processor(VIDEOS_QUEUE_NAME)
│   │                                    # process() + @OnWorkerEvent('failed')
│   ├── video-processor.service.spec.ts # 5 unit tests
│   └── main.ts                          # NestFactory.createApplicationContext
└── common/exceptions/domain.exception.ts # 6 new domain exceptions
```

### Key Phase 03 patterns

- **S3 multipart upload via presigned URLs** — the client uploads directly to MinIO/S3 with PUT. The API only orchestrates (create → presign per part → complete → abort).
- **`completeUpload` is transactional** — `markProcessing` + `completeMultipartUpload` + `enqueueProcessVideo` happen inside `dataSource.transaction(...)` so a S3 failure rolls back the `aguardando_upload` → `processando` transition.
- **Worker is a separate `ApplicationContext`** — no HTTP, no controllers, no guards. Shares `ConfigModule`, `TypeOrmModule`, `BullModule`, `StorageService` with the API.
- **Worker writes source bytes to a temp file** before calling `ffmpeg`/`ffprobe` — `fluent-ffmpeg` only accepts `string | stream.Readable` for the source, not `Buffer`.
- **`upload_id` is a transactional handle, not persistent** — set in `aguardando_upload`, cleared on transition to `processando`. It is meaningless after the multipart is finalized.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.

### Running tests in Docker

All test commands run **inside** `nestjs-project/` via `docker compose -f nestjs-project/compose.yaml exec -T nestjs-api`:

```bash
# Unit + integration (uses test/jest-e2e.json indirectly? No — uses main jest config)
docker compose -f nestjs-project/compose.yaml exec -T nestjs-api \
  npm test -- --runInBand

# E2E
docker compose -f nestjs-project/compose.yaml exec -T nestjs-api \
  npm run test:e2e

# Type check
docker compose -f nestjs-project/compose.yaml exec -T nestjs-api \
  npx tsc --noEmit

# Lint (auto-fixable via --fix)
docker compose -f nestjs-project/compose.yaml exec -T nestjs-api \
  npm run lint

# OpenAPI export
docker compose -f nestjs-project/compose.yaml exec -T nestjs-api \
  npm run openapi:export
```

The API and worker containers are `tail -f /dev/null` by default (per `Dockerfile.dev` in `nestjs-project/CLAUDE.md`). To run the dev server, start it manually with `npm run start:dev` (and `npm run start:worker` in the worker container) — they are not in the Compose `command` so they don't auto-restart on file changes.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring,
reviewing, etc.), decompose the request into its underlying subtasks and
concerns, then identify which available skills match any of them and activate
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.