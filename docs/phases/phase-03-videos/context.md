---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-28T14:55:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-28T15:29:30-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-06-28T14:55:32-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-06-28T14:55:32-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-28T14:55:32-03:00"
  .agents/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-28T14:56:29-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-28T15:32:02-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Frontend UI (upload screen, player, channel video panel) — Phase 03 is a backend challenge per the enunciado; `next-frontend/` is not extended in this phase. Video editing, visibilidade pública/unlisted, painel de administração do canal e página pública (Fase 04). Social interactions: likes, comentários, inscrições (Fase 06). Home page, busca (Fase 07).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas — backed by real object storage, queue, and an FFmpeg worker, all running in Docker Compose with the existing backend stack.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — UI surfaces for upload, player, and video management are deferred to Fase 04+; this phase delivers only the API and infra contracts a future frontend can consume.

**Sequencing notes:** Depends on Fase 01 (config/infra foundation: `@nestjs/config`, namespaced `registerAs`, Joi env validation, TypeORM `forRootAsync`, `data-source.ts` CLI sharing) and Fase 02 (auth: JWT guard, refresh-token rotation, channel entity 1:1 with user, `DomainException`/validation filters, `class-validator` DTOs, `@nestjs/throttler` global guard, `@nestjs-modules/mailer`). Phase 03 reuses the `channels` entity (videos belong to a channel), the JWT guard (upload/stream/download authorization), and the OpenAPI tooling already integrated.

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta:** provides `channels` (videos' owner), JWT auth guard, `DomainException` filter + `{ statusCode, error, message }` envelope, `class-validator` DTO pattern, throttler. Phase 03 must match these conventions — no parallel error envelope or validation story.
- **Fase 04 — Gerenciamento de Vídeos e Canal:** consumes the `videos` entity and lifecycle (`rascunho → processando → pronto/erro`) produced here; adds edição, visibilidade, painel do canal. Phase 03's status enum must leave room for Phase 04's `publicado`/`unlisted` transitions without breaking changes.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue Technology | decided | B (BullMQ + Redis — user diverged) | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Large-File Upload Strategy (up to 10GB) | decided | A (Presigned multipart direct-to-storage) | — (uses AWS SDK v3 from TD-04) |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming & Download Strategy | decided | A (API-mediated 206 range proxy) | — (uses AWS SDK v3 from TD-04) |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client & Key Organization | decided | A (AWS SDK v3 on MinIO) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL identifier | decided | A (nanoid) | nanoid |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Repo-wide | Video Worker Architecture & FFmpeg Invocation | decided | A (Standalone NestJS bootstrap + fluent-ffmpeg) | fluent-ffmpeg |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle & Processing-Failure Policy | decided | A (Five-state enum + BullMQ retry budget) | — (uses queue's built-in retry/backoff from TD-01) |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-04 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-03 |
| Download do vídeo pelo usuário | phase-03-videos/TD-03 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It keeps the infrastructure footprint to services already in the stack (PostgreSQL), gives a transactional enqueue (DB row + job in one transaction — the single biggest correctness argument against a Redis-backed queue here), and supplies production-grade semantics (concurrency, heartbeats, retries) without reimplementing `SKIP LOCKED`. Redis/BullMQ's latency advantage is irrelevant for multi-minute video jobs; its operational and dual-write cost is not.

**Libraries:** `bullmq`, `@nestjs/bullmq`

**Note:** Decision deliberately diverged from the Recommendation during `/plan-resolve` — the user picked BullMQ + Redis over pg-boss to keep the queue's retry/scheduling features independent of the DB transaction layer; the operational cost (new Redis service) was accepted.

### phase-03-videos/TD-02

**Recommendation:** Direct-to-storage multipart is the only option that keeps the API unblocked, supports resume for 10GB transfers (explicitly required), and parallelizes part uploads. Option B drops resume; Option C is the automatic-rejection case. MinIO + AWS SDK v3 implement the S3 multipart contract exactly, so the code is the same against S3 in production.

**Libraries:** — _(no new packages — uses AWS SDK v3 from TD-04 for presign + multipart coordination)_

### phase-03-videos/TD-03

**Recommendation:** It satisfies the streaming requirement (206 + `Range`) and reuse for download with one auth path, while keeping the door open for Phase 04 gating (`unlisted`) without re-architecting. The per-range bytes-through-API cost is acceptable in dev/local and resolves to a CDN in production; presigned direct URLs (Option B) would need to be thrown away the moment Phase 04 introduces access control.

**Libraries:** — _(no new packages — uses AWS SDK v3 from TD-04 for `Range` `GetObject` and 206 proxy)_

### phase-03-videos/TD-04

**Recommendation:** The code is production-portable to AWS S3 with only an env swap (matches the project's "MinIO locally, S3 in prod" stance), `Range` `GetObject` maps directly to TD-03's 206 proxy, and `lib-storage` gives the worker a streaming multipart helper. The `minio` client's MinIO convenience does not outweigh the production rewrite cost.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`

### phase-03-videos/TD-05

**Recommendation:** Short, collision-safe, and URL-safe, it matches the PROMPT's "URL curta e única" wording directly. The project already sorts listings by timestamp, so ULID's main value is unused. The dependency is one small, ubiquitous package with no tree-shake penalty.

**Libraries:** `nanoid`

### phase-03-videos/TD-06

**Recommendation:** Reusing the NestDI + config + repository seam from the API means the worker reads the same env-validated config (DB/MinIO/queue host as Compose service names), imports the same `StorageService`, and avoids a parallel `data-source.ts`/config story. `fluent-ffmpeg` removes the boilerplate of composing `ffmpeg`/`ffprobe` arg arrays for the two operations this phase needs (metadata JSON, one thumbnail frame). Option B's minimalism costs a duplicated DI surface; Option C is a fine fallback if `fluent-ffmpeg` proves incompatible with the installed FFmpeg build, but A starts further along.

**Libraries:** `fluent-ffmpeg`

### phase-03-videos/TD-07

**Recommendation:** The added `aguardando_upload` state is the only way to distinguish "user abandoned the upload" from "worker failed," which is exactly what the failure-handling requirement asks for; conflating them in Option B means the operator panel (Phase 04) cannot show the right action. pg-boss's built-in retry/backoff removes hand-rolled retry logic, and `erro` keeping the source file makes manual re-enqueue a one-line idempotent operation.

**Libraries:** — _(no new packages — relies on the queue's built-in retry/backoff; see **Revisions:** block for queue-backend update from TD-01)_

**Revisions:**

- 2026-06-28 — Queue backend updated from pg-boss to BullMQ (per TD-01 user choice in this resolve cycle). Rationale: TD-01 user diverged from the pg-boss recommendation in favor of BullMQ + Redis. TD-07's "five-state enum + retry budget" pattern is queue-agnostic — the retry mechanism is now BullMQ's job options (`attempts`, `backoff`) instead of pg-boss's built-in retry/backoff. The `aguardando_upload` state machine and `erro` semantics are unchanged.

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in DB — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** A única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** `@nestjs/swagger@^11.x`

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). Rationale: openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI, worker bootstrap). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule`, `data-source.ts`, and worker bootstrap. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Argon2id password hashing (via `argon2` package); OWASP minimums 19MiB memory, 2 iterations. _(from phase 02)_
- JWT auth via a custom `JwtAuthGuard` built directly with `@nestjs/jwt` (no Passport); access token short-lived (15min), refresh token is also a JWT carrying `userId`/`tokenFamily`/`jti`. New modules reuse the existing guard — do not introduce a second auth mechanism. _(from phase 02)_
- Refresh token rotation in DB (`refresh_tokens` table) with family-based theft detection; reuse of an old refresh token revokes the user's family. _(from phase 02)_
- Email confirmation & password reset use random opaque tokens (32 random bytes, hex-encoded = 64 chars) hashed and stored in a `verification_tokens` table; revocable; tracked via `used_at`/`expires_at`. _(from phase 02)_
- Transactional email via `@nestjs-modules/mailer` + Handlebars templates (`src/mail/templates/*.hbs`); SMTP transport (Mailpit in dev). _(from phase 02)_
- Request validation via `class-validator` + `class-transformer` decorators on DTOs; global `ValidationPipe` with `transform: true` and `whitelist: true`. New video DTOs follow the same decorator pattern. _(from phase 02)_
- Domain exceptions extend `DomainException` (`src/common/exceptions/domain.exception.ts`); a custom `DomainExceptionFilter` maps them to the envelope `{ statusCode, error, message }` with machine-readable `error` codes; a separate `ValidationExceptionFilter` normalizes `class-validator` errors into the same shape. Video-domain errors (`VIDEO_NOT_FOUND`, `UPLOAD_NOT_OWNED`, `STREAM_RANGE_INVALID`, ...) reuse this envelope. _(from phase 02)_
- Rate limiting via `@nestjs/throttler` (`ThrottlerGuard` registered as global `APP_GUARD`); `@SkipThrottle()`/`@Throttle()` for per-route overrides; in-memory storage (single-instance). The upload-init endpoint is a candidate for per-route throttling. _(from phase 02)_
- Channel `nickname` is unique (50-char limit); nickname generated at registration by lowercasing the email prefix, stripping non-`[a-z0-9_]`, truncating to 46 chars, with `user_<8-char-hex>` fallback. _(from phase 02)_
- Each user has a 1:1 channel (`channels` entity, `user_id` UUID unique FK) created at registration; the `videos` table added in Phase 03 references this channel as owner. _(from phase 02)_
- OpenAPI documentation via `@nestjs/swagger` v11 with the CLI plugin (`classValidatorShim: true`) for DTO schema introspection; explicit decorators (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`) required for operation metadata, by-status responses, error contracts aligned to the `DomainException` envelope, and examples. _(from openapi-docs-nestjs)_
- Spec is published as runtime Swagger UI at `/api/docs` (gated to dev/staging via `NODE_ENV !== 'production'` / `SWAGGER_ENABLED`) **and** as a committed `openapi.json` artifact exported by `npm run openapi:export` (`src/openapi-export.ts`) for offline codegen. New video endpoints must appear in the regenerated `openapi.json`. _(from openapi-docs-nestjs)_
- Container host names use the Docker Compose service name (e.g., `db`, `minio`, `queue`), never `localhost`. New Phase 03 services (`minio`, plus the chosen queue backend, plus the worker) follow the same convention. _(from CLAUDE.md → Docker Networking)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in the foundational phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces for the auth flows start in a later phase. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| (empty on first assembly — plan-resolve appends rows as the user marks capabilities) | | | |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces: a `videos` entity (FK to `channels`), video service(s) with branching + DB + side-effect dependencies (storage presign, queue publish), the storage service (S3/MinIO client — a configured lib), the queue producer + worker consumer (pg-boss — a configured lib), video DTOs (init/complete/stream/download), the worker module, and the streaming controller (Range/206). The pyramid applies per artifact — see the Phase Implementation Checklist table below for the per-type mapping.

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, pg-boss, S3 client) | Unit: real lib with test config |
| Service with side-effect dep (email, storage, queue) | Integration: real capture service (Mailpit) or local adapter — DO NOT mock what the compose infra can run (MinIO, pg-boss) |
| Module with configured imports (`TypeOrmModule.forFeature`, pg-boss, S3 client, Bull/queue) | Unit: compilation test (`Test.createTestingModule({ imports }).compile()`) |
| Controller | E2E only — do NOT write unit tests (HTTP contract: status codes, validation wiring, auth, response shape, `Range`/206) |
| DTO | E2E: one validation wiring test per endpoint proving `ValidationPipe` is active |
| Guard (delegates to service for business logic — e.g., video ownership) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to existing JWT guard) | E2E only — reuse `phase-02-auth`'s JwtAuthGuard |
| Exception Filter | Unit + E2E (video-domain error mapping) |
| Middleware | E2E |

### next-frontend (deferred subproject)

_Deferred in this phase — no frontend code in Phase 03. Testing requirements for the upload UI, player, and channel panel will be defined when a later phase introduces them, via the existing `testing-guide-next-frontend` skill._