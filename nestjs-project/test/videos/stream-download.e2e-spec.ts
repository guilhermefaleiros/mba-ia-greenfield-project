import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { Readable } from 'node:stream';
import type { Response as SuperagentResponse } from 'superagent';
import request from 'supertest';
import { App } from 'supertest/types';
import { Channel } from '../../src/channels/entities/channel.entity';
import { User } from '../../src/users/entities/user.entity';
import { Video, VIDEO_STATUS } from '../../src/videos/entities/video.entity';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { VideoOwnershipGuard } from '../../src/videos/guards/video-ownership.guard';
import { VideosController } from '../../src/videos/videos.controller';
import { VideosRepository } from '../../src/videos/videos.repository';
import { VideosService } from '../../src/videos/videos.service';
import { StorageService } from '../../src/videos/storage/storage.service';
import { VideosQueueProducer } from '../../src/videos/queue/videos-queue.producer';
import storageConfig from '../../src/config/storage.config';
import queueConfig from '../../src/config/queue.config';
import { cleanAllTables } from '../../src/test/create-test-data-source';

const STREAMING_MIME = 'video/mp4';

const MOCK_OBJECT_BUFFER = Buffer.alloc(2 * 1024 * 1024, 0x42);

type ErrorBody = { error: string };
type ObjectStreamResult = {
  body: Readable;
  contentLength: number;
  contentRange?: string;
  contentType: string;
};
type GetObjectStreamFn = (
  key: string,
  rangeHeader?: string,
) => Promise<ObjectStreamResult>;

function bodyOf<T>(res: { body: unknown }): T {
  return res.body as T;
}

function bufferParser(
  res: SuperagentResponse,
  callback: (error: Error | null, body: unknown) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function makeObjectStreamMock(
  totalSize: number,
  contentType: string = STREAMING_MIME,
): jest.MockedFunction<GetObjectStreamFn> {
  return jest.fn((_: string, rangeHeader?: string) => {
    if (!rangeHeader) {
      return Promise.resolve({
        body: Readable.from(MOCK_OBJECT_BUFFER),
        contentLength: totalSize,
        contentRange: undefined,
        contentType,
      });
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    if (!m) {
      throw new Error(`Invalid range header: ${rangeHeader}`);
    }
    const start = parseInt(m[1], 10);
    const end = Math.min(parseInt(m[2], 10), totalSize - 1);
    const slice = MOCK_OBJECT_BUFFER.subarray(start, end + 1);
    return Promise.resolve({
      body: Readable.from(slice),
      contentLength: slice.length,
      contentRange: `bytes ${start}-${end}/${totalSize}`,
      contentType,
    });
  });
}

describe('Videos stream & download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let user1: User;
  let channel1: Channel;
  let user1Jwt: string;
  let videoProntoId: string;
  let videoDraftId: string;

  beforeAll(async () => {
    const storageMock = {
      createMultipartUpload: jest.fn(),
      presignPartUrl: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      getObjectStream: makeObjectStreamMock(
        MOCK_OBJECT_BUFFER.length,
        STREAMING_MIME,
      ),
      putObject: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig, queueConfig],
          isGlobal: true,
        }),
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
        TypeOrmModule.forFeature([Video, Channel, User]),
        JwtModule.register({
          secret: 'test-secret',
          signOptions: { expiresIn: '1h' },
        }),
      ],
      controllers: [VideosController],
      providers: [
        VideosRepository,
        VideosService,
        VideoOwnershipGuard,
        {
          provide: StorageService,
          useValue: storageMock,
        },
        {
          provide: VideosQueueProducer,
          useValue: { enqueueProcessVideo: jest.fn() },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useFactory({
        factory: (reflector: Reflector) => ({
          canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
            const isPublic = reflector.getAllAndOverride<boolean>('isPublic', [
              ctx.getHandler(),
              ctx.getClass(),
            ]);
            const request = ctx
              .switchToHttp()
              .getRequest<{ headers: Record<string, string>; user: unknown }>();
            if (isPublic) {
              const auth = request.headers['authorization'];
              if (auth && auth.startsWith('Bearer ')) {
                try {
                  const payload = jwtService.verify<{
                    sub: string;
                    channelId: string;
                  }>(auth.slice(7));
                  request.user = payload;
                } catch {
                  // ignore — public endpoint
                }
              }
              return true;
            }
            const auth = request.headers['authorization'];
            if (!auth || !auth.startsWith('Bearer ')) {
              throw new UnauthorizedException();
            }
            const token = auth.slice(7);
            try {
              const payload = jwtService.verify<{
                sub: string;
                channelId: string;
              }>(token);
              request.user = payload;
              return true;
            } catch {
              throw new UnauthorizedException();
            }
          },
        }),
        inject: [Reflector],
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleRef.get(DataSource);
    jwtService = moduleRef.get(JwtService);
  });

  afterAll(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // best-effort
      }
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    jest.clearAllMocks();

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const counter = Date.now();
    user1 = await userRepo.save(
      userRepo.create({
        email: `u1_${counter}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    channel1 = await channelRepo.save(
      channelRepo.create({
        name: 'u1',
        nickname: `u1_${counter}`,
        user_id: user1.id,
      }),
    );
    user1Jwt = jwtService.sign({
      sub: user1.id,
      email: user1.email,
      channelId: channel1.id,
    });

    const videoRepo = dataSource.getRepository(Video);
    const videoDraft = await videoRepo.save(
      videoRepo.create({
        id: 'aaaaaaaaaaaaaaaaaaaaa',
        channel_id: channel1.id,
        title: 'draft',
        source_key: `videos/${channel1.id}/aaaaaaaaaaaaaaaaaaaaa/source.mp4`,
        upload_id: 'some-upload-id',
        status: VIDEO_STATUS.aguardando_upload,
        mime_type: STREAMING_MIME,
        size_bytes: String(MOCK_OBJECT_BUFFER.length),
      }),
    );
    videoDraftId = videoDraft.id;
    const videoPronto = await videoRepo.save(
      videoRepo.create({
        id: 'bbbbbbbbbbbbbbbbbbbbb',
        channel_id: channel1.id,
        title: 'pronto',
        source_key: `videos/${channel1.id}/bbbbbbbbbbbbbbbbbbbbb/source.mp4`,
        upload_id: null,
        status: VIDEO_STATUS.pronto,
        mime_type: STREAMING_MIME,
        size_bytes: String(MOCK_OBJECT_BUFFER.length),
      }),
    );
    videoProntoId = videoPronto.id;
  });

  describe('GET /videos/{videoId}/stream', () => {
    it('1.1 returns 206 with Content-Range, Accept-Ranges, Content-Length, Content-Type, and the requested body slice', async () => {
      const start = 0;
      const end = 1024 * 1024 - 1;
      const expected = MOCK_OBJECT_BUFFER.subarray(start, end + 1);
      const expectedHash = crypto
        .createHash('sha256')
        .update(expected)
        .digest('hex');

      const res = await request(app.getHttpServer())
        .get(`/videos/${videoProntoId}/stream`)
        .set('Range', `bytes=${start}-${end}`)
        .buffer(true)
        .parse(bufferParser);

      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(
        `bytes ${start}-${end}/${MOCK_OBJECT_BUFFER.length}`,
      );
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-length']).toBe(String(expected.length));
      expect(res.headers['content-type']).toMatch(/video\/mp4/);
      const bodyBuf = bodyOf<Buffer>(res);
      expect(bodyBuf.length).toBe(expected.length);
      expect(crypto.createHash('sha256').update(bodyBuf).digest('hex')).toBe(
        expectedHash,
      );
    });

    it('1.2.a returns 416 with STREAM_RANGE_INVALID on inverted range', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoProntoId}/stream`)
        .set('Range', 'bytes=100-99');

      expect(res.status).toBe(416);
      expect(bodyOf<ErrorBody>(res).error).toBe('STREAM_RANGE_INVALID');
    });

    it('1.2.b returns 416 on out-of-bounds range (parsed before MinIO call)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoProntoId}/stream`)
        .set('Range', 'bytes=0-999999999999');

      expect(res.status).toBe(416);
      expect(bodyOf<ErrorBody>(res).error).toBe('STREAM_RANGE_INVALID');
    });

    it('1.2.c returns 416 on malformed range header', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoProntoId}/stream`)
        .set('Range', 'bytes=abc-def');

      expect(res.status).toBe(416);
      expect(bodyOf<ErrorBody>(res).error).toBe('STREAM_RANGE_INVALID');
    });

    it('1.2.d returns 409 with VIDEO_NOT_READY for a draft video', async () => {
      const res = await request(app.getHttpServer()).get(
        `/videos/${videoDraftId}/stream`,
      );

      expect(res.status).toBe(409);
      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    });

    it('1.2.e returns 404 with VIDEO_NOT_FOUND for a nonexistent video', async () => {
      const res = await request(app.getHttpServer()).get(
        '/videos/nonexistent-id-21chars/stream',
      );

      expect(res.status).toBe(404);
      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 200 with the full body when no Range header is sent', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoProntoId}/stream`)
        .buffer(true)
        .parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-length']).toBe(
        String(MOCK_OBJECT_BUFFER.length),
      );
      const bodyBuf = bodyOf<Buffer>(res);
      expect(bodyBuf.length).toBe(MOCK_OBJECT_BUFFER.length);
    });
  });

  describe('GET /videos/{videoId}/download', () => {
    it('1.3.a returns 401 when no Authorization header is sent', async () => {
      const res = await request(app.getHttpServer()).get(
        `/videos/${videoProntoId}/download`,
      );
      expect(res.status).toBe(401);
    });

    it('1.3.b returns 404 with VIDEO_NOT_FOUND for a nonexistent video', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/nonexistent-id-21chars/download')
        .set('Authorization', `Bearer ${user1Jwt}`);

      expect(res.status).toBe(404);
      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('1.3.c returns 409 with VIDEO_NOT_READY for a draft video', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoDraftId}/download`)
        .set('Authorization', `Bearer ${user1Jwt}`);

      expect(res.status).toBe(409);
      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    });

    it('1.3.d returns 200 with Content-Disposition, Content-Type, and full body', async () => {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoProntoId}/download`)
        .set('Authorization', `Bearer ${user1Jwt}`)
        .buffer(true)
        .parse(bufferParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/video\/mp4/);
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="${videoProntoId}.mp4"`,
      );
      expect(res.headers['content-length']).toBe(
        String(MOCK_OBJECT_BUFFER.length),
      );
      const bodyBuf = bodyOf<Buffer>(res);
      const expectedHash = crypto
        .createHash('sha256')
        .update(MOCK_OBJECT_BUFFER)
        .digest('hex');
      expect(crypto.createHash('sha256').update(bodyBuf).digest('hex')).toBe(
        expectedHash,
      );
    });
  });
});
