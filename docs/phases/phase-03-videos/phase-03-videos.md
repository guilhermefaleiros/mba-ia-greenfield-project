---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-06-28T15:32:10-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-28T15:32:02-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-28T15:29:30-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the Phase 03 backend for video upload (up to 10GB), background processing (ffprobe + thumbnail), and streaming/download — backed by S3-compatible object storage (MinIO in dev), a BullMQ/Redis queue, and a standalone NestJS FFmpeg worker, all running in Docker Compose alongside the existing NestJS API and PostgreSQL stack.

---

## Step Implementations

### SI-03.1 — Infra: stack compose, dependências, env config (MinIO + Redis + worker)

**Description:** Provisionar a nova infra do `compose.yaml` (MinIO + Redis + serviço `video-worker`) e estender `package.json`, validação Joi, e os arquivos `registerAs` em `src/config/` para que a API e o worker compartilhem hosts/nomes de bucket via injeção ConfigService — per phase-03-videos/TD-04, TD-01, TD-06 e convenção de phase-01 (config com `registerAs`).

**Technical actions:**

1. Atualizar `nestjs-project/compose.yaml` — adicionar serviços `minio` (image `minio/minio`, ports 9000/9001, env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, volume `./.data/minio:/data`, healthcheck), `redis` (image `redis:7-alpine`, port 6379, healthcheck) e `video-worker` (build a partir do mesmo `Dockerfile.dev`, command `node dist/worker/main.js`, `depends_on` em `db`, `minio`, `redis` com healthchecks); adicionar `minio`, `redis` ao `depends_on` do `nestjs-api`. (per phase-03-videos/TD-04 + TD-01)
2. Atualizar `nestjs-project/Dockerfile.dev` (ou criar `Dockerfile.worker`) — instalar `ffmpeg` no container (apt-get install ffmpeg) para o `fluent-ffmpeg` invocar o binário. (per phase-03-videos/TD-06)
3. Atualizar `nestjs-project/package.json` — adicionar dependências `bullmq`, `@nestjs/bullmq`, `nanoid`, `fluent-ffmpeg`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`; devDep `@types/fluent-ffmpeg`. (per phase-03-videos/TD-01, TD-04, TD-05, TD-06)
4. Criar `nestjs-project/src/config/storage.config.ts` — `registerAs('storage', () => ({ endpoint, region, accessKeyId, secretAccessKey, bucket, forcePathStyle: true }))` via `ConfigType<typeof storageConfig>`. (per phase-01-configuracao-base/TD-03 + phase-03-videos/TD-04)
5. Criar `nestjs-project/src/config/queue.config.ts` — `registerAs('queue', () => ({ host, port, password? }))`. (per phase-01-configuracao-base/TD-03 + phase-03-videos/TD-01)
6. Estender `nestjs-project/src/config/env.validation.ts` — adicionar schema Joi para `STORAGE_*`, `QUEUE_*` (host, port, password opcional); garantir `validationOptions: { allowUnknown: true, abortEarly: false }` (já em vigor per phase-01-configuracao-base/TD-02). Atualizar `nestjs-project/.env.example` com placeholders.

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `db`, `mailpit`, `minio`, `redis`, `nestjs-api`, `video-worker` — todos com healthcheck `running`.
- `docker compose exec minio curl -f http://localhost:9000/minio/health/ready` retorna 200.
- `docker compose exec redis redis-cli ping` retorna `PONG`.
- `docker compose exec video-worker ls /usr/bin/ffmpeg` confirma o binário presente no PATH.
- `npm run start:dev` na API carrega o ConfigModule sem erros; a chamada de healthcheck retorna 200.
- `npm run start:dev` no worker (via override do entrypoint) instancia o TypeORM DataSource e o BullMQ Worker sem erros no boot.

---

### SI-03.2 — Migration `videos` + entidade `Video` + `VideosRepository`

**Description:** Criar a migration versionada da tabela `videos` (DDL exato conforme `### Data Model → Video`), o entity `Video` (com o enum `video_status` de 5 valores conforme phase-03-videos/TD-07), e o `VideosRepository` (TypeORM) com os métodos de domínio que as SIs subsequentes consomem — sem controller, sem service, sem DTOs (entram nas SIs 03.3+).

**Technical actions:**

1. Gerar migration: `cd nestjs-project && npm run migration:generate src/database/migrations/<timestamp>-CreateVideos` — revisar SQL para casar com `### Data Model → Video` (PK `id` varchar(21), FK `channel_id` uuid com `on delete CASCADE`, colunas `title`, `description`, `status` `video_status` enum, `source_key`, `thumbnail_key`, `upload_id`, `duration_seconds`, `width`, `height`, `size_bytes`, `mime_type`, `failure_reason`, `created_at`, `updated_at`; índices em `channel_id`, `status`, e composto `(channel_id, created_at desc)`). (per `### Data Model → Video`)
2. Criar `nestjs-project/src/videos/entities/video.entity.ts` — entity TypeORM com decorators `@Entity('videos')`, `@PrimaryColumn('varchar', { length: 21 })` em `id` (gerado via `nanoid(21)` no service, não aqui), colunas conforme Data Model, `@ManyToOne(() => Channel)` em `channel_id` com `JoinColumn({ name: 'channel_id' })` e `onDelete: 'CASCADE'`, `@CreateDateColumn`/`@UpdateDateColumn`. Declarar enum `video_status` via TypeScript const + type-only export (`'rascunho' | 'aguardando_upload' | 'processando' | 'pronto' | 'erro'`). (per phase-03-videos/TD-07 + `### Data Model`)
3. Criar `nestjs-project/src/videos/videos.repository.ts` — `Injectable` estendendo `Repository<Video>` via `@InjectRepository(Video)`; métodos de domínio: `findById(id: string)`, `findByIdForOwner(id, channelId)` (filtra `channel_id` para o guard), `createDraft({ channelId, title, mimeType, sourceKey, uploadId })` (gera `id` via `nanoid(21)`, status `aguardando_upload`), `markProcessing(id)` (status `processando`, `upload_id = null`), `markReady(id, { durationSeconds, width, height, thumbnailKey, sizeBytes })`, `markError(id, reason)` (status `erro`, `failure_reason = reason`). (per `### Data Model → Video` + phase-03-videos/TD-05)
4. Criar `nestjs-project/src/videos/videos.module.ts` (esqueleto mínimo) — importar `TypeOrmModule.forFeature([Video, Channel])`, declarar `VideosRepository` como provider (será extendido nas SIs seguintes com StorageService, Queue producer, etc.). (per phase-01-configuracao-base/TD-03 + inherited `TypeOrmModule.forRootAsync` convention)
5. Registrar `VideosModule` em `nestjs-project/src/app.module.ts` — `imports: [..., VideosModule]`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `videos` table + `video_status` enum | Integration: constraints, defaults, FK cascade | `nestjs-project/src/videos/entities/video.entity.integration-spec.ts` |
| `VideosRepository` | Integration: DB contract (findById/createDraft/mark*; FK on delete CASCADE) | `nestjs-project/src/videos/videos.repository.integration-spec.ts` |
| `VideosModule` | Unit: compilation | `nestjs-project/src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas + enum + índices + FK CASCADE para `channels.id`; rollback via `npm run migration:revert` desfaz a tabela.
- Inserir um `Video` com `id` = `nanoid(21)` é bem-sucedido; inserir com `id` duplicado falha com constraint unique violation; inserir com `channel_id` inexistente falha com FK violation.
- `videosRepository.createDraft({...})` retorna um `Video` com `id` de 21 chars URL-safe, `status = 'aguardando_upload'`, `source_key` e `upload_id` populados; chamada repetida com mesmo `id` falha.
- `markReady(id, { ... })` move o status para `pronto` e popula `duration_seconds`/`width`/`height`/`thumbnail_key`; `markError(id, 'falha')` move para `erro` e popula `failure_reason`.
- Deletar um `Channel` (FK cascade) remove os `Video` associados.

---

### SI-03.3 — `StorageService` (cliente S3/MinIO) + key helpers

**Description:** Encapsular o AWS SDK v3 (`S3Client` com `forcePathStyle: true`) num `StorageService` injetável, expondo os métodos do contrato multipart (create/presign-part/complete/abort) e Range/206 streaming — e os key helpers que derivam `videos/{channelId}/{videoId}/source.mp4` e `thumb.jpg` a partir do row `Video`. Sem controller, sem DTOs, sem lógica de negócio de vídeo.

**Technical actions:**

1. Criar `nestjs-project/src/videos/storage/storage.service.ts` — `Injectable` recebendo `ConfigType<typeof storageConfig>` via `@Inject(storageConfig.KEY)`; constrói `S3Client` (singleton no escopo do service) com `endpoint`, `region`, `credentials`, `forcePathStyle: true` (per library-refs AWS SDK v3 / MinIO configuration). Métodos: `createMultipartUpload(key, contentType): Promise<{ uploadId }>`, `presignPartUrl(key, uploadId, partNumber, expiresInSeconds = 3600): Promise<{ url, expiresAt }>`, `completeMultipartUpload(key, uploadId, parts): Promise<void>`, `abortMultipartUpload(key, uploadId): Promise<void>`, `getObjectStream(key, rangeHeader?): Promise<{ body: Readable, contentLength: number, contentRange?: string, contentType: string }>`, `putObject(key, body, contentType): Promise<void>`. (per phase-03-videos/TD-04 + `### Data Model → Storage key structure` + library-refs AWS SDK v3)
2. Criar `nestjs-project/src/videos/storage/storage.keys.ts` — funções puras `buildSourceKey(channelId: string, videoId: string): string` retornando `videos/{channelId}/{videoId}/source.mp4`; `buildThumbnailKey(channelId: string, videoId: string): string` retornando `videos/{channelId}/{videoId}/thumb.jpg`. (per phase-03-videos/TD-04)
3. Criar `nestjs-project/src/videos/storage/storage.module.ts` — provê `StorageService`; importa `ConfigModule` (já global per phase-01).
4. Importar `StorageModule` em `nestjs-project/src/videos/videos.module.ts` (anexa ao esqueleto de SI-03.2).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` (real SDK) | Unit: real `@aws-sdk/client-s3` + `s3-request-presigner` against local MinIO via test config (`S3_ENDPOINT=http://minio:9000`, `forcePathStyle: true`) — covers create/presign/complete/abort/get/put, incl. Range parsing | `nestjs-project/src/videos/storage/storage.service.spec.ts` |
| `StorageService` (compose infra) | Integration: real `S3Client` against MinIO container in compose — end-to-end multipart round-trip (create → presign → simulate PUT via supertest-like stream → complete → get with Range) | `nestjs-project/src/videos/storage/storage.service.integration-spec.ts` |
| `buildSourceKey` / `buildThumbnailKey` | Unit: pure-function shape | `nestjs-project/src/videos/storage/storage.keys.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `presignPartUrl(key, uploadId, 1)` retorna uma URL com hostname `minio:9000`, `path-style` (`/streamtube-videos/videos/...`), e query string `X-Amz-Algorithm=AWS4-HMAC-SHA256`, `X-Amz-SignedHeaders=host`, `X-Amz-Expires=3600`. (per library-refs AWS SDK v3)
- `getObjectStream(key, 'bytes=0-1023')` retorna um Readable com `contentRange: 'bytes 0-1023/<total>'` e `contentLength = 1024`; sem `rangeHeader`, retorna o objeto completo com `contentLength` igual ao `ContentLength` do S3.
- PUT-ing um buffer de 5MB via `putObject(key, buffer, 'image/jpeg')` e subsequentemente `getObjectStream(key, undefined)` retorna o mesmo buffer.
- `completeMultipartUpload` com `parts: [{ partNumber: 1, etag: '...' }, ...]` (≥1 parte) sucede; com parts vazios, lança erro do SDK (pass-through).
- `buildSourceKey('channel-uuid', 'vidnanoid21')` retorna exatamente `videos/channel-uuid/vidnanoid21/source.mp4` (verbatim; field-name verbatim invariant).

---

### SI-03.4 — `QueueModule` (BullMQ producer) + `VideosQueueProducer`

**Description:** Conectar o `BullModule` ao Redis (config da SI-03.1) e expor um `VideosQueueProducer` injetável que o `VideosService` usa para enfileirar o job `process-video`. Sem worker (entra em SI-03.9) — só o lado produtor.

**Technical actions:**

1. Criar `nestjs-project/src/videos/queue/videos-queue.constants.ts` — `export const VIDEOS_QUEUE_NAME = 'process-video';` (single source-of-truth para o nome da fila; reusado em SI-03.9).
2. Criar `nestjs-project/src/videos/queue/videos-queue.module.ts` — `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port, password: cfg.password } }) })` + `BullModule.registerQueue({ name: VIDEOS_QUEUE_NAME, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: { age: 24 * 3600, count: 1000 }, removeOnFail: false } })`. (per phase-03-videos/TD-01 + TD-07 + library-refs `@nestjs/bullmq`)
3. Criar `nestjs-project/src/videos/queue/videos-queue.producer.ts` — `Injectable` com `@InjectQueue(VIDEOS_QUEUE_NAME) private queue: Queue`; método `enqueueProcessVideo(payload: { videoId: string; channelId: string; sourceKey: string }): Promise<{ jobId: string }>` chamando `this.queue.add('process', payload)` e retornando `{ jobId: String(job.id) }`. (per phase-03-videos/TD-01 + library-refs `@nestjs/bullmq`)
4. Importar `QueueModule` em `nestjs-project/src/videos/videos.module.ts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosQueueProducer` (real BullMQ) | Unit: real `bullmq` against local Redis via test config — covers enqueue + retry options + backoff shape on the job options | `nestjs-project/src/videos/queue/videos-queue.producer.spec.ts` |
| `QueueModule` | Unit: compilation (`Test.createTestingModule({ imports: [QueueModule] }).compile()`) | `nestjs-project/src/videos/queue/videos-queue.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `producer.enqueueProcessVideo({ videoId, channelId, sourceKey })` retorna `{ jobId: <string> }`; chamada subsequente com mesmo payload retorna jobId diferente (BullMQ gera IDs únicos).
- O job enfileirado tem `opts.attempts = 3` e `opts.backoff = { type: 'exponential', delay: 1000 }` visíveis via `job.opts` no Redis (assert via `queue.getJob(jobId)`).
- `BullModule.registerQueue` é registrado com `name = 'process-video'` e `defaultJobOptions.removeOnComplete.age = 86400`; falha de job mantém o job no Redis (assertion via `queue.getJobCounts()`).
- O `QueueModule` compila sem erros com `Test.createTestingModule({ imports: [QueueModule, ConfigModule.forRoot({ load: [queueConfig] })] }).compile()`.

---

### SI-03.5 — DTOs de upload + `VideosService` (orquestração de domínio)

**Description:** Implementar os DTOs validados por `class-validator` (entrada de cada endpoint de upload) e o `VideosService` que orquestra o ciclo de upload — criação de draft, presign de part, complete (com finalização do multipart + enqueue do job BullMQ + transição de status em uma única transação DB), abort. Sem controller (entra em SI-03.6), sem worker (SI-03.9).

**Technical actions:**

1. Criar `nestjs-project/src/videos/dto/upload-init.dto.ts` — `UploadInitDto` com `title?: string` (`@IsOptional() @IsString @MaxLength(255)`), `mimeType: string` (`@IsIn(['video/mp4', 'video/quicktime', 'video/webm'])`); expor via `@ApiProperty` (per phase-03-videos/TD-04 + openapi-docs-nestjs/TD-01 Revisions).
2. Criar `nestjs-project/src/videos/dto/upload-part-url.dto.ts` — `UploadPartUrlDto` com `partNumber: number` (`@IsInt @Min(1) @Max(10000)`).
3. Criar `nestjs-project/src/videos/dto/upload-complete.dto.ts` — `UploadCompleteDto` com `parts: Array<{ partNumber: number; etag: string }>` (`@IsArray @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => UploadPartDto)`, com `partNumber: number` `@IsInt @Min(1) @Max(10000)` e `etag: string` `@IsString @IsNotEmpty`).
4. Criar `nestjs-project/src/videos/videos.service.ts` — `Injectable` injetando `VideosRepository`, `StorageService`, `VideosQueueProducer`; métodos: `initUpload(channelId, dto: UploadInitDto): Promise<{ videoId, uploadId, bucket, key, partSize: 5*1024*1024 }>` (chama `videosRepository.createDraft` + `storageService.createMultipartUpload(key, mimeType)` + atualiza `upload_id` no row; retorna o envelope da `### API Contracts → POST /videos/upload-init`); `getPresignedPartUrl(channelId, videoId, dto: UploadPartUrlDto): Promise<{ url, expiresAt }>` (chama `storageService.presignPartUrl(...)`; ownership enforced upstream pela `VideoOwnershipGuard`); `completeUpload(channelId, videoId, dto: UploadCompleteDto): Promise<{ videoId, status: 'processando', queuedJobId }>` — em uma única transação DB: `videosRepository.markProcessing(videoId)`, depois (fora da transação) `storageService.completeMultipartUpload(key, uploadId, dto.parts)`, depois `producer.enqueueProcessVideo({ videoId, channelId, sourceKey })`; em caso de falha do `completeMultipartUpload`, a transação é revertida (status volta para `aguardando_upload`) e `UPLOAD_COMPLETE_FAILED` é lançado; `abortUpload(channelId, videoId)` — chama `storageService.abortMultipartUpload` + `videosRepository.markError(videoId, 'aborted by user')`. (per `### API Contracts` + phase-03-videos/TD-01 + TD-02 + TD-04 + TD-07)
5. Atualizar `nestjs-project/src/videos/videos.module.ts` — declarar `VideosService` como provider.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: branch logic (mock `VideosRepository` + `StorageService` + `VideosQueueProducer`) — covers happy paths + ownership 403 + UPLOAD_COMPLETE_FAILED rollback + abort | `nestjs-project/src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: DB contract against real PostgreSQL + real MinIO + real Redis (compose infra) — covers draft creation + presign URL validity + complete end-to-end with a small test video | `nestjs-project/src/videos/videos.service.integration-spec.ts` |
| `UploadInitDto` / `UploadPartUrlDto` / `UploadCompleteDto` | (E2E via SI-03.6 controller spec; DTO-level unit not needed per testing guide — one E2E wiring test per endpoint suffices) | _(no separate spec)_ |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `service.initUpload(channelId, { mimeType: 'video/mp4' })` retorna `{ videoId, uploadId, bucket, key, partSize: 5242880 }`; o `videoId` tem 21 chars URL-safe; o row `videos` correspondente tem `status = 'aguardando_upload'` e `upload_id` populado.
- `service.getPresignedPartUrl(channelId, videoId, { partNumber: 1 })` retorna URL que aceita PUT (assertion na integration spec com uma chamada real ao MinIO).
- `service.completeUpload(channelId, videoId, { parts: [{ partNumber: 1, etag: 'etag-1' }] })` bem-sucedido: row `videos` transita `aguardando_upload → processando`; job `process-video` aparece na fila (assertion: `queue.getJob(jobId)`); o `CompleteMultipartUpload` no MinIO sucede e o source object fica disponível.
- `service.completeUpload(...)` quando `storageService.completeMultipartUpload` lança: a transação DB é revertida, o row permanece em `aguardando_upload`; a exception é mapeada para `UPLOAD_COMPLETE_FAILED` pelo service.
- `service.abortUpload(channelId, videoId)` chama `storageService.abortMultipartUpload` e move o row para `erro` com `failure_reason = 'aborted by user'`.

---

### SI-03.6 — Controller de upload (4 endpoints) + `VideoOwnershipGuard` + throttle override

**Description:** Expor os 4 endpoints de upload como rotas HTTP da API (`POST /videos/upload-init`, `POST /videos/{videoId}/upload-part-url`, `POST /videos/{videoId}/upload-complete`, `POST /videos/{videoId}/upload-abort`), com `VideoOwnershipGuard` para os 3 endpoints que recebem `videoId`, e `@Throttle()` override no `upload-init` (per phase-02-auth/TD-08 + `### Authorization Matrix`).

**Route:** POST /videos/upload-init, POST /videos/{videoId}/upload-part-url, POST /videos/{videoId}/upload-complete, POST /videos/{videoId}/upload-abort
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated (all four); Owner only (the three `{videoId}` routes — `VideoOwnershipGuard`)

**Technical actions:**

1. Criar `nestjs-project/src/videos/guards/video-ownership.guard.ts` — `Injectable` implements `CanActivate`; resolve `@Param('videoId')` + `req.user.channelId`; chama `videosRepository.findByIdForOwner(videoId, channelId)`; se não encontrado ou channel mismatch, lança `DomainException` com `errorCode: 'UPLOAD_NOT_OWNED'` (HTTP 403). (per `### Error Catalog` + `### Authorization Matrix`)
2. Criar `nestjs-project/src/videos/videos.controller.ts` — `Controller('videos')` com 4 endpoints:
   - `@Post('upload-init') @UseGuards(JwtAuthGuard) @Throttle({ default: { limit: 5, ttl: 60_000 } }) async initUpload(@CurrentUser() user, @Body() dto: UploadInitDto)` — chama `videosService.initUpload(user.channelId, dto)`; retorna 201.
   - `@Post(':videoId/upload-part-url') @UseGuards(JwtAuthGuard, VideoOwnershipGuard) async getPartUrl(@Param('videoId') videoId, @CurrentUser() user, @Body() dto: UploadPartUrlDto)` — chama `videosService.getPresignedPartUrl(user.channelId, videoId, dto)`; retorna 200.
   - `@Post(':videoId/upload-complete') @UseGuards(JwtAuthGuard, VideoOwnershipGuard) async complete(@Param('videoId') videoId, @CurrentUser() user, @Body() dto: UploadCompleteDto)` — chama `videosService.completeUpload(user.channelId, videoId, dto)`; retorna 200 com `{ videoId, status: 'processando', queuedJobId }`.
   - `@Post(':videoId/upload-abort') @UseGuards(JwtAuthGuard, VideoOwnershipGuard) @HttpCode(204) async abort(@Param('videoId') videoId, @CurrentUser() user)` — chama `videosService.abortUpload(user.channelId, videoId)`. (per `### API Contracts` + `### Authorization Matrix`)
3. Adicionar `@ApiTags('videos')` na classe; adicionar `@ApiOperation`, `@ApiResponse`, `@ApiParam`, `@ApiBody`, `@ApiBearerAuth` por método (per openapi-docs-nestjs/TD-01 + Revisions — alinhado ao envelope de phase-02-auth/TD-07).
4. Adicionar `VideosController` em `videos.module.ts` controllers array.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `videos.upload-init` E2E | E2E: validation wiring + auth + throttle + 201 envelope | `nestjs-project/test/videos/upload-init.e2e-spec.ts` |
| `videos.upload-part-url` E2E | E2E: ownership guard + presign URL shape + 404/403/409 paths | `nestjs-project/test/videos/upload-part-url.e2e-spec.ts` |
| `videos.upload-complete` E2E | E2E: happy path end-to-end (multipart round-trip with MinIO) + 422 path | `nestjs-project/test/videos/upload-complete.e2e-spec.ts` |
| `videos.upload-abort` E2E | E2E: 204 happy path + 403 ownership + 409 not-active | `nestjs-project/test/videos/upload-abort.e2e-spec.ts` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/upload-init` com JWT válido e `{"mimeType": "video/mp4"}` retorna `201` com `{ videoId, uploadId, bucket, key, partSize: 5242880 }`.
- `POST /videos/upload-init` sem JWT retorna `401` com `{ statusCode: 401, error: "UNAUTHENTICATED", message: ... }`.
- 6 chamadas em 60s a `/videos/upload-init` do mesmo usuário → a 6ª retorna `429` com `error: "TOO_MANY_REQUESTS"`.
- `POST /videos/{otherUserVideoId}/upload-part-url` com JWT do user atual retorna `403` com `error: "UPLOAD_NOT_OWNED"`.
- `POST /videos/{videoId}/upload-part-url` com `partNumber: 0` retorna `400` com erro de validation.
- `POST /videos/{videoId}/upload-complete` com `parts: []` retorna `400` (validation: `@ArrayMinSize(1)`).
- `POST /videos/{videoId}/upload-complete` end-to-end (multipart com MinIO real) retorna `200` com `{ videoId, status: "processando", queuedJobId: <bullmq id> }`; subsequent GET no row mostra `status: "processando"`, `upload_id: null`.

---

### SI-03.7 — Controller de streaming (Range/206) e download

**Description:** Expor `GET /videos/{videoId}/stream` (Range/206 parcial via proxy do MinIO) e `GET /videos/{videoId}/download` (full object com `Content-Disposition: attachment`) — endpoints de leitura que dependem do status `pronto` (não-streaming de rascunhos). O `Range` é parseado no controller; o serviço delega ao `StorageService.getObjectStream(key, rangeHeader)` que retorna o range já fatiado pelo MinIO.

**Route:** GET /videos/{videoId}/stream, GET /videos/{videoId}/download
**Test Specs:** see `nestjs-project/specs/videos-stream-download.plan.md`
**Authorization:** stream: anonymous (Phase 03) / download: authenticated

**Technical actions:**

1. Criar `nestjs-project/src/videos/streaming/range-parser.util.ts` — função pura `parseRangeHeader(header: string | undefined, totalSize: number): { start: number; end: number } | null` que valida o header `bytes=start-end` (regex `^bytes=(\d*)-(\d*)$`); se `start > end` ou `end >= totalSize`, lança `DomainException` com `errorCode: 'STREAM_RANGE_INVALID'` (HTTP 416); se `header` ausente, retorna `null` (controller decide default full object). (per `### Error Catalog` + `### API Contracts → GET /videos/{videoId}/stream`)
2. Criar `nestjs-project/src/videos/videos.streaming.controller.ts` — `@Controller('videos')` com 2 endpoints (ou adicionar ao `videos.controller.ts` da SI-03.6 — preferido adicionar à mesma classe para coesão, mas separar em outro controller se o `videos.controller.ts` já cresce além de ~150 linhas):
   - `@Get(':videoId/stream') async stream(@Param('videoId') videoId, @Req() req, @Res() res)` — `videosRepository.findById(videoId)`; se não encontrado → 404 `VIDEO_NOT_FOUND`; se `status !== 'pronto'` → 409 `VIDEO_NOT_READY`; chama `parseRangeHeader(req.headers.range, totalSize)`; chama `storageService.getObjectStream(sourceKey, rangeHeader)`; pipe `body` para `res` com `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`, `Content-Type: 'video/mp4'`; status 206 (com Range) ou 200 (sem Range).
   - `@Get(':videoId/download') @UseGuards(JwtAuthGuard) async download(@Param('videoId') videoId, @Res() res)` — mesmo lookup + `VIDEO_NOT_FOUND`/`VIDEO_NOT_READY`; chama `storageService.getObjectStream(sourceKey)`; pipe + `Content-Disposition: attachment; filename="{videoId}.mp4"`, `Content-Length`, `Content-Type: 'video/mp4'`. (per `### API Contracts` + phase-03-videos/TD-03)
3. Adicionar `@ApiOperation` + `@ApiResponse` + `@ApiParam` aos 2 endpoints (per openapi-docs-nestjs/TD-01 Revisions).
4. Adicionar o controller em `videos.module.ts` controllers array.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `videos.stream` E2E | E2E: 206 happy path com `Range: bytes=0-1023` + 416 invalid range + 404 + 409 not-ready + 200 sem range | `nestjs-project/test/videos/stream.e2e-spec.ts` |
| `videos.download` E2E | E2E: 200 happy path + 401 + 404 + 409 not-ready | `nestjs-project/test/videos/download.e2e-spec.ts` |
| `parseRangeHeader` | Unit: pure function (regex cases + bounds + invalid) | `nestjs-project/src/videos/streaming/range-parser.util.spec.ts` |

**Dependencies:** SI-03.3, SI-03.5, SI-03.6

**Acceptance criteria:**

- `GET /videos/{prontoVideoId}/stream` com header `Range: bytes=0-1048575` retorna `206` com `Content-Range: bytes 0-1048575/<total>`, `Accept-Ranges: bytes`, `Content-Length: 1048576`; body contém exatamente 1MB do início do arquivo (assertion: hash do range igual ao hash do range correspondente do source object).
- `GET /videos/{prontoVideoId}/stream` com header `Range: bytes=100-99` (inverted) retorna `416` com `error: "STREAM_RANGE_INVALID"`.
- `GET /videos/{prontoVideoId}/stream` com header `Range: bytes=0-999999999999` (out of bounds) retorna `416` (MinIO devolve 416 também — assertion: response status).
- `GET /videos/{rascunhoVideoId}/stream` retorna `409` com `error: "VIDEO_NOT_READY"`.
- `GET /videos/nonexistent/stream` retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- `GET /videos/{prontoVideoId}/download` retorna `200` com `Content-Disposition: attachment; filename="{videoId}.mp4"`, body idêntico ao source object; sem JWT retorna `401`.

---

### SI-03.8 — OpenAPI enrichment + regenerar `openapi.json`

**Description:** Adicionar os decorators explícitos de OpenAPI (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiBearerAuth`, `@ApiExtraModels`) nos 6 endpoints de vídeo (4 upload em SI-03.6 + 2 stream/download em SI-03.7), alinhando o `openapi.json` ao envelope de erros de phase-02-auth/TD-07 e expondo os DTOs (per openapi-docs-nestjs/TD-01 Revisions). Regenerar o artifact `openapi.json` via `npm run openapi:export` (per openapi-docs-nestjs/TD-02).

**Technical actions:**

1. Em `nestjs-project/src/videos/videos.controller.ts` e `videos.streaming.controller.ts` (SI-03.6 + SI-03.7) — adicionar decorators por método (resumo; SI-03.6 + SI-03.7 já adicionam os básicos, esta SI completa o set):
   - `@ApiOperation({ summary, description })` em cada um dos 6 métodos.
   - `@ApiResponse({ status: 201|200|204, description, type: <ResponseDto> })` no happy path; `@ApiResponse({ status: 400, description: 'Validation error' })`; `@ApiResponse({ status: 401, description: 'Unauthenticated' })`; `@ApiResponse({ status: 403, description: 'UPLOAD_NOT_OWNED' })`; `@ApiResponse({ status: 404, description: 'VIDEO_NOT_FOUND' })`; `@ApiResponse({ status: 409, description: 'UPLOAD_NOT_ACTIVE | VIDEO_NOT_READY' })`; `@ApiResponse({ status: 416, description: 'STREAM_RANGE_INVALID' })`; `@ApiResponse({ status: 422, description: 'UPLOAD_COMPLETE_FAILED' })`; `@ApiResponse({ status: 429, description: 'TOO_MANY_REQUESTS' })` no `upload-init`.
   - `@ApiExtraModels(UploadInitDto, UploadPartUrlDto, UploadCompleteDto, UploadPartDto)` no controller.
   - `@ApiBearerAuth()` nos métodos protegidos por `JwtAuthGuard`.
2. Adicionar `@ApiProperty({ description, example })` nos DTOs (`title`, `mimeType`, `partNumber`, `parts[]`, `etag`) para que o CLI plugin infira os schemas corretos (per openapi-docs-nestjs/TD-01 Revisions + library-refs `@nestjs/swagger`).
3. Regenerar `openapi.json` — `cd nestjs-project && npm run openapi:export` (per openapi-docs-nestjs/TD-02); commitar o artifact atualizado.
4. Verificar o artifact regenerado: `curl http://localhost:3000/api/docs-json` (ou ler `openapi.json` direto) e validar que as 6 operações de `videos` aparecem com responses tipadas por status e schemas de request/response não-vazios.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `openapi.json` shape | E2E: spawn Nest app + GET `/api/docs-json` + assert the 6 `videos.*` operations are present with `requestBody` schema + at least 2 distinct response status codes per operation | `nestjs-project/test/openapi/videos-schema.e2e-spec.ts` |

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- O `openapi.json` regerado contém 6 operations sob a tag `videos` (paths `/videos/upload-init`, `/videos/{videoId}/upload-part-url`, `/videos/{videoId}/upload-complete`, `/videos/{videoId}/upload-abort`, `/videos/{videoId}/stream`, `/videos/{videoId}/download`).
- Cada operation tem `requestBody` com schema não-vazio (não `{}`); cada uma tem `responses` para pelo menos 3 status codes distintos (e.g., 201/400/401 para `upload-init`).
- O E2E spec `videos-schema.e2e-spec.ts` passa: GET em `/api/docs-json` retorna 200 + a estrutura validada.
- `npm run openapi:export` (script já existente) regenera o artifact sem erros; o diff em `openapi.json` está restrito às adições dos 6 endpoints (não toca endpoints existentes).

---

### SI-03.9 — Worker: bootstrap NestJS standalone + `VideoProcessor` (ffprobe + thumbnail)

**Description:** Implementar o `VideoProcessor` que consome a fila `process-video` (do `QueueModule` em SI-03.4) num container NestJS separado (worker), rodando `ffprobe` via `fluent-ffmpeg` para extrair metadados e `ffmpeg` para extrair um frame como thumbnail — depois atualizando o row `Video` para `pronto` (ou `erro` em falha). O worker é um bootstrap NestJS standalone em `src/worker/main.ts` que importa o mesmo `BullModule`, `StorageService`, e `VideosRepository` da API — sem HTTP, sem controller, sem guard.

**Technical actions:**

1. Criar `nestjs-project/src/worker/video-processor.service.ts` — `Injectable` com `@Processor(VIDEOS_QUEUE_NAME)` estendendo `WorkerHost`; método `async process(job: Job<{ videoId, channelId, sourceKey }>): Promise<void>` que implementa os 7 passos do `### Events/Messages → process-video` (per phase-03-videos/TD-06 + TD-07 + library-refs `fluent-ffmpeg`):
   1. `videosRepository.findByIdForUpdate(videoId)`; se `status === 'pronto'`, return (idempotency);
   2. `storageService.getObjectStream(sourceKey)` → stream; pipe para `fluent.ffprobe(...)` (callbacks) extraindo `metadata.format.duration`, `metadata.streams[0].width`, `height`, `codec_name`;
   3. `fluent(inputStream).screenshots({ count: 1, timemarks: ['10%'], folder: '/tmp', filename: 'thumb.jpg', size: '1280x720' })`; on `end`, lê `/tmp/thumb.jpg` para buffer;
   4. `storageService.putObject(thumbnailKey, thumbBuffer, 'image/jpeg')`;
   5. `videosRepository.markReady(videoId, { durationSeconds, width, height, thumbnailKey, sizeBytes })`;
   6. on any error: `videosRepository.markError(videoId, err.message)`; throw para acionar o BullMQ retry;
   7. handle `OnWorkerEvent('failed')` para log + (após attempts esgotados) deixar o row em `erro`.
2. Criar `nestjs-project/src/worker/worker.module.ts` — importa `TypeOrmModule.forFeature([Video, Channel])` (reutiliza `TypeOrmModule.forRootAsync` global), `BullModule.forRootAsync(...)` (reutiliza `QueueModule` da SI-03.4 — ou re-registra com mesmo config), `StorageModule` (reutiliza), e provê `VideoProcessor`. (per phase-03-videos/TD-06)
3. Criar `nestjs-project/src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule, { logger: ['log', 'error', 'warn'] })` (ApplicationContext, não HTTP server); `await app.init()`; log `Worker started, listening on queue 'process-video'`; `process.on('SIGTERM', () => app.close())`. (per phase-03-videos/TD-06 + library-refs `@nestjs/bullmq`)
4. Adicionar `start:worker` script em `package.json` — `"start:worker": "ts-node -r tsconfig-paths/register src/worker/main.ts"`; o entrypoint no `compose.yaml` da SI-03.1 aponta para `node dist/worker/main.js` em produção.
5. Verificar que o `Dockerfile.dev` (ou `Dockerfile.worker`) tem `ffmpeg` instalado e o CMD do serviço `video-worker` invoca o script do worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor.process` | Unit: branch logic (mock StorageService + mock fluent-ffmpeg + mock VideosRepository) — covers happy path + idempotency (pronto skip) + ffprobe error → erro + thumbnail error → erro | `nestjs-project/src/worker/video-processor.service.spec.ts` |
| `VideoProcessor` (compose infra) | Integration: real fluent-ffmpeg + real MinIO + real Redis + real PostgreSQL — feed a small test video (e.g., 5s MP4 fixture committed under `nestjs-project/test/fixtures/`) end-to-end, assert duration + thumbnail uploaded + status = `pronto` | `nestjs-project/src/worker/video-processor.service.integration-spec.ts` |
| `WorkerModule` | Unit: compilation (`Test.createTestingModule({ imports: [WorkerModule] }).compile()`) | `nestjs-project/src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `worker process` iniciado standalone: `docker compose up -d video-worker` → logs `Worker started, listening on queue 'process-video'`.
- Enqueue um job (via API ou `queue.add` direto num teste) com `{ videoId, channelId, sourceKey }` onde o source já está no MinIO: o worker processa; o row `videos` transita `processando → pronto`; `duration_seconds`, `width`, `height`, `thumbnail_key` populados; o `thumb.jpg` está no MinIO e é um JPEG válido.
- Enqueue um job com `sourceKey` que aponta para um arquivo inexistente no MinIO: o worker loga o erro, marca o row como `erro` com `failure_reason`; o BullMQ retentará até `attempts: 3`; após esgotar, o row permanece em `erro` para revisão manual.
- Enqueue um job para um `videoId` que já está em `pronto` (job duplicado por retentativa): o worker retorna imediatamente sem reprocessar (idempotency).
- O `WorkerModule` compila sem erros; o test de compilação passa.
- O `ffmpeg` binário está disponível no container do worker: `docker compose exec video-worker which ffmpeg` → `/usr/bin/ffmpeg`.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | varchar(21) | PK, generated via `nanoid(21)` (per phase-03-videos/TD-05) |
| channel_id | uuid | FK → channels.id, NOT NULL, on delete CASCADE |
| title | varchar(255) | NOT NULL, default '' (placeholder until Phase 04 sets the editable title) |
| description | text | NULL (default) |
| status | video_status enum | NOT NULL, default 'rascunho' (per phase-03-videos/TD-07) |
| source_key | varchar(512) | NOT NULL, default ''; storage key under `videos/{channelId}/{id}/source.mp4` (per phase-03-videos/TD-04) |
| thumbnail_key | varchar(512) | NULL; storage key under `videos/{channelId}/{id}/thumb.jpg` |
| upload_id | varchar(128) | NULL; S3 multipart uploadId; cleared on complete |
| duration_seconds | numeric(10,3) | NULL; populated by worker ffprobe |
| width | integer | NULL; from ffprobe |
| height | integer | NULL; from ffprobe |
| size_bytes | bigint | NULL; from complete-multipart response |
| mime_type | varchar(64) | NULL; from upload init ContentType |
| failure_reason | text | NULL; populated when status → erro |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() on update |

**Relations:** `Video` belongs to `Channel` (many-to-one via `channel_id` → `channels.id`).
**Indexes:** unique on `id` (PK); index on `channel_id`; index on `status`; composite index on `(channel_id, created_at desc)` for the Phase 04 channel panel query.

**Enum `video_status` (per phase-03-videos/TD-07):**

| Value | Meaning |
|-------|---------|
| `rascunho` | Initial state when `POST /videos/upload-init` is called |
| `aguardando_upload` | Multipart upload started on MinIO; client is uploading parts |
| `processando` | Multipart complete; worker picked the `process-video` BullMQ job |
| `pronto` | Worker finished; duration, dimensions, thumbnail written; row public-ready |
| `erro` | Worker exhausted retries; `failure_reason` populated; source retained for re-enqueue |

#### VideoPart (optional tracking of per-part ETags)

For Phase 03, the API does NOT need to persist per-part ETags in the DB — `CompleteMultipartUpload` is invoked client-side in a single request carrying all parts, and the S3 `UploadId` is stored on `Video.upload_id`. Tracking per-part state in the DB is deferred (Phase 04+ only if resumable-multipart-on-server-side becomes a requirement). If a future phase needs it, add a `video_parts` table: `(video_id, part_number, etag, size_bytes)`.

#### Storage key structure (off-DB, per phase-03-videos/TD-04)

- **Bucket:** `streamtube-videos` (single bucket for all videos in dev; production can split by region or env).
- **Source key:** `videos/{channelId}/{videoId}/source.mp4` (channel-scoped, stable, prefix-listable).
- **Thumbnail key:** `videos/{channelId}/{videoId}/thumb.jpg`.
- Keys are derived at runtime from the `Video` row (`channelId` + `id`); they are never stored independently and never collide because `id` is a `nanoid(21)` URL-safe string.

---

### API Contracts

#### POST /videos/upload-init (SI-03.1)

**Request headers:**
- Authorization: Bearer {access_token} (per phase-02-auth/TD-02 — JWT auth)
- Content-Type: application/json

**Request body:**
- title: string, optional — defaults to '' (placeholder until Phase 04 adds edit)
- mimeType: string, required — must be one of `video/mp4`, `video/quicktime`, `video/webm` (validate via class-validator `@IsIn`)

**Response 201:**
- videoId: string (21-char nanoid)
- uploadId: string — S3 multipart `UploadId` (per phase-03-videos/TD-04)
- bucket: string
- key: string — `videos/{channelId}/{videoId}/source.mp4`
- partSize: number — 5 * 1024 * 1024 (5MB minimum per AWS SDK multipart)

**Error responses:**
- 401 UNAUTHENTICATED: missing/invalid JWT (per phase-02-auth/TD-02)
- 400 validation error: invalid body
- 429 TOO_MANY_REQUESTS: rate limited by `@Throttle()` (per phase-02-auth/TD-08 — upload-init is a candidate for per-route throttling)

**Side effects:** creates a new `Video` row with status `aguardando_upload`, `upload_id` set, `source_key` set; calls S3 `CreateMultipartUploadCommand` (per phase-03-videos/TD-04).

---

#### POST /videos/{videoId}/upload-part-url (SI-03.2)

**Request headers:**
- Authorization: Bearer {access_token}

**Request body:**
- partNumber: integer, required — 1 to 10000 (per AWS SDK multipart constraints)

**Response 200:**
- url: string — presigned PUT URL for the part (per phase-03-videos/TD-02 + TD-04)
- expiresAt: string (ISO-8601) — URL expiry (default 1h)

**Error responses:**
- 401 UNAUTHENTICATED
- 403 UPLOAD_NOT_OWNED: caller is not the video's channel owner
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_NOT_ACTIVE: video status is not `aguardando_upload` (multipart was never started, was completed, or was aborted)
- 400 validation error: partNumber out of range

**Side effects:** calls S3 `UploadPartCommand` + `getSignedUrl` (per phase-03-videos/TD-04); no DB mutation.

---

#### POST /videos/{videoId}/upload-complete (SI-03.3)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array of { partNumber: integer, etag: string }, required — non-empty, all partNumbers distinct

**Response 200:**
- videoId: string
- status: string — `'processando'`
- queuedJobId: string — BullMQ job id (per phase-03-videos/TD-01 + TD-07)

**Error responses:**
- 401 UNAUTHENTICATED
- 403 UPLOAD_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_NOT_ACTIVE: video status is not `aguardando_upload`
- 422 UPLOAD_COMPLETE_FAILED: S3 `CompleteMultipartUploadCommand` failed (invalid part list, expired uploadId, etc.)
- 400 validation error: parts malformed

**Side effects:** calls S3 `CompleteMultipartUploadCommand`; in a single DB transaction: sets `Video.status` to `processando`, clears `upload_id`; publishes a BullMQ `process-video` job with `{ videoId, channelId, sourceKey }` (per phase-03-videos/TD-01 + TD-07).

---

#### POST /videos/{videoId}/upload-abort (SI-03.4)

**Request headers:**
- Authorization: Bearer {access_token}

**Request body:** (none)

**Response 204:** No content.

**Error responses:**
- 401 UNAUTHENTICATED
- 403 UPLOAD_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_NOT_ACTIVE: video status is not `aguardando_upload`

**Side effects:** calls S3 `AbortMultipartUploadCommand`; sets `Video.status` to `erro` with `failure_reason: 'aborted by user'`; preserves `source_key` for audit but the multipart upload is gone.

---

#### GET /videos/{videoId}/stream (SI-03.5)

**Request headers:**
- (none required for anonymous or authenticated playback; future Phase 04 may require auth for `unlisted`)

**Request query parameters:**
- (none; the `Range` header is read from the HTTP request, not from a query param)

**Response 206:**
- Body: bytes from MinIO at the requested range
- Headers: `Content-Type: video/mp4`, `Content-Range: bytes {start}-{end}/{total}`, `Accept-Ranges: bytes`, `Content-Length: {range_size}`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: video status is not `pronto` (cannot stream a draft or processing video)
- 416 STREAM_RANGE_INVALID: `Range` header is malformed (e.g., `bytes=abc-def`) or out of bounds

**Side effects:** reads S3 `GetObjectCommand` with the `Range` header from the request, pipes the response body (per phase-03-videos/TD-03 + TD-04).

---

#### GET /videos/{videoId}/download (SI-03.6)

**Request headers:**
- Authorization: Bearer {access_token} — required to bind a download to the user (used in Phase 04+ analytics; optional in Phase 03)

**Response 200:**
- Body: full video bytes
- Headers: `Content-Type: video/mp4`, `Content-Disposition: attachment; filename="{videoId}.mp4"`, `Content-Length: {size}`

**Error responses:**
- 401 UNAUTHENTICATED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: video status is not `pronto`

**Side effects:** reads S3 `GetObjectCommand` without `Range`, streams the full body (per phase-03-videos/TD-03 + TD-04).

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos/upload-init | ✗ | ✓ (creates own draft) | n/a |
| POST /videos/{videoId}/upload-part-url | ✗ | ✗ | ✓ (video.channel_id == caller's channel.id) |
| POST /videos/{videoId}/upload-complete | ✗ | ✗ | ✓ |
| POST /videos/{videoId}/upload-abort | ✗ | ✗ | ✓ |
| GET /videos/{videoId}/stream | ✓ (Phase 03 — open; Phase 04 may require auth for `unlisted`) | ✓ | ✓ |
| GET /videos/{videoId}/download | ✗ | ✓ | ✓ |

**Guard stack (per route):**
- All write endpoints (`/videos/upload-init`, `/upload-part-url`, `/upload-complete`, `/upload-abort`) use the global `JwtAuthGuard` (per phase-02-auth/TD-02) plus a `VideoOwnershipGuard` that resolves `video.channel_id` to the caller's `channels.id` and rejects with `403 UPLOAD_NOT_OWNED` on mismatch.
- `/stream` and `/download` use `JwtAuthGuard` only for `/download`; `/stream` is anonymous in Phase 03 (Future Phase 04's `unlisted` will add a per-video authorization check before streaming).

**Throttler overrides (per phase-02-auth/TD-08):**
- `POST /videos/upload-init` is rate-limited at `5 / 60s` per user (prevents draft-row spam; an attacker can otherwise create millions of draft rows). Use `@Throttle({ default: { limit: 5, ttl: 60_000 } })` decorator.
- All other video endpoints inherit the global default throttle.

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `videos.id` (nanoid) does not exist or was deleted (FK cascade) |
| UPLOAD_NOT_OWNED | 403 | Authenticated user is not the owner of the video (channel mismatch) |
| UPLOAD_NOT_ACTIVE | 409 | Video is not in `aguardando_upload` state (upload was already completed, aborted, or never started) |
| UPLOAD_COMPLETE_FAILED | 422 | S3 `CompleteMultipartUploadCommand` rejected the part list |
| UPLOAD_TOO_LARGE | 413 | (Phase 04 — deferred; Phase 03 enforces 10GB via presigned URL + part size limits; explicit body-size check is the API's responsibility only for `upload-init` metadata, not the bytes themselves) |
| VIDEO_NOT_READY | 409 | Stream/download requested on a video whose status is not `pronto` |
| STREAM_RANGE_INVALID | 416 | `Range` header malformed or out of bounds (regex `^bytes=\d*-\d*$`; bounds-check `start <= end < total`) |
| UNAUTHENTICATED | 401 | Missing or invalid JWT (per phase-02-auth/TD-02) |
| TOO_MANY_REQUESTS | 429 | `@Throttle()` per-route or global limit exceeded (per phase-02-auth/TD-08) |

**Error response envelope (per phase-02-auth/TD-07 + inherited convention):** `{ statusCode, error, message }` — machine-readable `error` code; `message` is human-readable. Errors flow through the existing `DomainException` filter (`src/common/exceptions/domain.exception.ts`).

---

### Events/Messages

#### process-video

**Payload:**

```json
{
  "videoId": "string (nanoid 21)",
  "channelId": "uuid",
  "sourceKey": "string"
}
```

**Producer:** `VideosService.completeUpload()` (per phase-03-videos/TD-01 + TD-07). Published inside the same DB transaction that flips the `videos.status` from `aguardando_upload` to `processando`; BullMQ enqueue is the last step in the transaction.
**Consumer:** `VideoProcessor` (standalone NestJS worker, per phase-03-videos/TD-06) — `WorkerHost` subclass with `@Processor('process-video')`.
**Trigger:** client calls `POST /videos/{videoId}/upload-complete` (SI-03.3) successfully.
**Delivery semantics:** at-least-once (per phase-03-videos/TD-07 — BullMQ `attempts: 3, backoff: { type: 'exponential', delay: 1000 }`). The worker is idempotent: re-running a `process-video` job on an already-`pronto` video is a no-op (the worker's first action is `SELECT … FOR UPDATE` on the `videos` row, with a guard `if (status === 'pronto') return;`). Failed jobs (after 3 attempts) leave the video in `erro` with `failure_reason` populated; the source object is retained for manual re-enqueue.

**Worker processing steps (per phase-03-videos/TD-06):**
1. `SELECT … FOR UPDATE` the `videos` row; if `status === 'pronto'`, return (idempotency).
2. Download source bytes from MinIO via S3 `GetObjectCommand` → stream.
3. Pipe to `ffmpeg.ffprobe()` (per fluent-ffmpeg README) — extract `duration`, `width`, `height`, `codec_name`.
4. Pipe to `ffmpeg().screenshots({ count: 1, timemarks: ['10%'] })` (per fluent-ffmpeg recipes) — generate 1280x720 thumbnail at 10% of duration.
5. Upload the thumbnail buffer via S3 `PutObjectCommand` to `videos/{channelId}/{videoId}/thumb.jpg`.
6. In a single DB transaction: set `duration_seconds`, `width`, `height`, `thumbnail_key`, and `status = 'pronto'`.
7. On any failure (ffprobe error, ffmpeg error, S3 error): set `status = 'erro'` and `failure_reason = <error message>`; throw to trigger BullMQ retry; after `attempts: 3` exhausted, the job is moved to BullMQ's failed set and the video stays in `erro` for operator review.

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — Infra: compose + deps + env config)
├── SI-03.2 — Migration + Video entity + VideosRepository (needs compose infra)
│   ├── SI-03.3 — StorageService + key helpers (needs SI-03.1, SI-03.2)
│   │   ├── SI-03.5 — DTOs + VideosService (needs SI-03.2 + SI-03.3 + SI-03.4)
│   │   │   └── SI-03.6 — Upload controller + VideoOwnershipGuard (needs SI-03.5)
│   │   │       └── SI-03.7 — Stream/download controller (needs SI-03.3 + SI-03.5 + SI-03.6)
│   │   │           └── SI-03.8 — OpenAPI enrichment (needs SI-03.6 + SI-03.7)
│   │   └── (SI-03.7 also depends on SI-03.3)
│   └── SI-03.4 — QueueModule + VideosQueueProducer (needs SI-03.1 + SI-03.2)
│       └── (SI-03.5 also depends on SI-03.4)
└── (SI-03.9 — Worker bootstrap + VideoProcessor, needs SI-03.2 + SI-03.3 + SI-03.4; not on the upload path — separate container)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: stack compose, dependências, env config (MinIO + Redis + worker)
- [ ] SI-03.2 — Migration `videos` + entidade `Video` + `VideosRepository`
- [ ] SI-03.3 — `StorageService` (cliente S3/MinIO) + key helpers
- [ ] SI-03.4 — `QueueModule` (BullMQ producer) + `VideosQueueProducer`
- [ ] SI-03.5 — DTOs de upload + `VideosService` (orquestração de domínio)
- [ ] SI-03.6 — Controller de upload (4 endpoints) + `VideoOwnershipGuard` + throttle override
- [ ] SI-03.7 — Controller de streaming (Range/206) e download
- [ ] SI-03.8 — OpenAPI enrichment + regenerar `openapi.json`
- [ ] SI-03.9 — Worker: bootstrap NestJS standalone + `VideoProcessor` (ffprobe + thumbnail)

**Full test suites (nestjs-project):**

- [ ] `docker compose exec nestjs-api npm test` — unit + integration suites pass
- [ ] `docker compose exec nestjs-api npm run test:integration -- --runInBand` — integration suite (DB + MinIO + Redis real) passes
- [ ] `docker compose exec nestjs-api npm run test:e2e -- --runInBand` — E2E suite (supertest against the Nest app with full infra) passes
- [ ] `docker compose exec nestjs-api npx tsc --noEmit` — type-check exits 0
- [ ] `docker compose exec nestjs-api npm run lint` — ESLint passes (with auto-fix)
- [ ] `docker compose exec nestjs-api npm run build` — build exits 0 (compiles both `dist/main.js` and `dist/worker/main.js`)
- [ ] `docker compose exec nestjs-api npm run migration:run` — `videos` table + `video_status` enum created
- [ ] `docker compose exec nestjs-api npm run openapi:export` — `openapi.json` regenerated with the 6 video operations

**Infra checks (compose up):**

- [ ] `docker compose up -d` brings up `db`, `mailpit`, `minio`, `redis`, `nestjs-api`, `video-worker` — all services show `running` status
- [ ] `docker compose exec minio curl -f http://localhost:9000/minio/health/ready` returns 200
- [ ] `docker compose exec redis redis-cli ping` returns `PONG`
- [ ] `docker compose exec video-worker which ffmpeg` returns `/usr/bin/ffmpeg`
- [ ] `docker compose exec video-worker node dist/worker/main.js` (or `npm run start:worker` in dev) starts without errors and logs `Worker started, listening on queue 'process-video'`
