import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { Channel } from '../../src/channels/entities/channel.entity';
import { User } from '../../src/users/entities/user.entity';
import { Video } from '../../src/videos/entities/video.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { buildSwaggerDocument } from '../../src/swagger/swagger-document';

describe('videos schema (e2e)', () => {
  let app: INestApplication<App>;
  let paths: Record<string, Record<string, Record<string, unknown>>>;
  let schemas: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'db',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_NAME ?? 'streamtube',
          entities: [User, Channel, Video],
          synchronize: false,
        }),
        AppModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    const document = buildSwaggerDocument(app);
    paths =
      (document.paths as Record<
        string,
        Record<string, Record<string, unknown>>
      >) ?? {};
    schemas =
      ((document.components as Record<string, Record<string, unknown>>)
        ?.schemas as Record<string, Record<string, unknown>>) ?? {};
    void DataSource; // suppress unused import warning
  }, 30_000);

  afterAll(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // best-effort
      }
    }
  });

  it('exposes 6 video operations under the "videos" tag', () => {
    const videoOps: Array<{ method: string; path: string; tag: string }> = [];
    for (const [p, methods] of Object.entries(paths)) {
      if (!p.startsWith('/videos/')) continue;
      for (const [method, op] of Object.entries(methods)) {
        if (method === 'parameters') continue;
        const tags = op.tags as string[] | undefined;
        videoOps.push({ method, path: p, tag: tags?.[0] ?? '' });
      }
    }
    expect(videoOps.length).toBe(6);
    for (const op of videoOps) {
      expect(op.tag).toBe('videos');
    }
  });

  it('every video operation has a non-empty requestBody or non-empty parameters', () => {
    const videoOps = collectVideoOps();
    expect(videoOps.length).toBe(6);
    for (const op of videoOps) {
      const rb = op.requestBody as
        | { content?: Record<string, { schema: Record<string, unknown> }> }
        | undefined;
      const parameters = op.parameters as
        | Array<{ in: string; schema?: Record<string, unknown> }>
        | undefined;
      const rbContent = rb?.content ?? {};
      const hasRequestBody =
        rb !== undefined &&
        Object.keys(rbContent).length > 0 &&
        Object.values(rbContent)[0]?.schema != null &&
        Object.keys(Object.values(rbContent)[0].schema).length > 0;
      const hasParams =
        parameters !== undefined &&
        parameters.some(
          (p) => p.schema != null && Object.keys(p.schema).length > 0,
        );
      expect(hasRequestBody || hasParams).toBe(true);
    }
  });

  it('every video operation has at least 3 distinct response status codes', () => {
    const videoOps = collectVideoOps();
    expect(videoOps.length).toBe(6);
    for (const op of videoOps) {
      const responses = op.responses as
        | Record<string, Record<string, unknown>>
        | undefined;
      const statusCodes = Object.keys(responses ?? {});
      expect(statusCodes.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('exposes the DTOs in components.schemas (UploadInitDto, UploadPartUrlDto, UploadCompleteDto)', () => {
    expect(schemas['UploadInitDto']).toBeDefined();
    expect(schemas['UploadPartUrlDto']).toBeDefined();
    expect(schemas['UploadCompleteDto']).toBeDefined();
  });

  it('UploadInitDto schema has title and mimeType properties', () => {
    const dto = schemas['UploadInitDto'];
    const props = dto?.properties as Record<string, unknown>;
    expect(props).toHaveProperty('title');
    expect(props).toHaveProperty('mimeType');
  });

  it('UploadCompleteDto schema has parts array property', () => {
    const dto = schemas['UploadCompleteDto'];
    const props = dto?.properties as Record<string, unknown>;
    expect(props).toHaveProperty('parts');
  });

  it('exposes ApiErrorEnvelope in components.schemas', () => {
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
  });

  function collectVideoOps(): Array<Record<string, unknown>> {
    const ops: Array<Record<string, unknown>> = [];
    for (const [p, methods] of Object.entries(paths)) {
      if (!p.startsWith('/videos/')) continue;
      for (const [method, op] of Object.entries(methods)) {
        if (method === 'parameters') continue;
        ops.push(op);
      }
    }
    return ops;
  }
});
