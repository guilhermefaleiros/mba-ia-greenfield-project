import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule, JwtService } from '@nestjs/jwt';
import {
  ThrottlerModule,
  ThrottlerStorage,
  ThrottlerStorageService,
} from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
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
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../../src/config/storage.config';
import queueConfig from '../../src/config/queue.config';
import { cleanAllTables } from '../../src/test/create-test-data-source';

const STORAGE_MOCK: {
  createMultipartUpload: jest.Mock;
  presignPartUrl: jest.Mock;
  completeMultipartUpload: jest.Mock;
  abortMultipartUpload: jest.Mock;
  getObjectStream: jest.Mock;
  putObject: jest.Mock;
} = {
  createMultipartUpload: jest
    .fn()
    .mockResolvedValue({ uploadId: 'mocked-upload-id' }),
  presignPartUrl: jest.fn().mockResolvedValue({
    url: 'http://minio:9000/streamtube-videos/videos/ch1/vid/source.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600',
    expiresAt: new Date(Date.now() + 3600 * 1000),
  }),
  completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
  abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
  getObjectStream: jest.fn(),
  putObject: jest.fn(),
};

const PRODUCER_MOCK: { enqueueProcessVideo: jest.Mock } = {
  enqueueProcessVideo: jest.fn().mockResolvedValue({ jobId: 'mocked-job-1' }),
};

describe('Videos upload (e2e, focused on HTTP contract)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let videosRepository: VideosRepository;
  let throttlerStorage: ThrottlerStorageService;
  let user1: User;
  let user2: User;
  let channel1: Channel;
  let channel2: Channel;
  let user1Jwt: string;
  let user2Jwt: string;

  beforeAll(async () => {
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
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
      ],
      controllers: [VideosController],
      providers: [
        VideosRepository,
        VideosService,
        VideoOwnershipGuard,
        {
          provide: StorageService,
          useValue: STORAGE_MOCK,
        },
        {
          provide: VideosQueueProducer,
          useValue: PRODUCER_MOCK,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
          const request = ctx
            .switchToHttp()
            .getRequest<{ headers: Record<string, string>; user: unknown }>();
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
    videosRepository = moduleRef.get(VideosRepository);
    throttlerStorage = moduleRef.get<ThrottlerStorageService>(ThrottlerStorage);
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
    throttlerStorage.storage.clear();
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
    user2 = await userRepo.save(
      userRepo.create({
        email: `u2_${counter}@example.com`,
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
    channel2 = await channelRepo.save(
      channelRepo.create({
        name: 'u2',
        nickname: `u2_${counter}`,
        user_id: user2.id,
      }),
    );
    user1Jwt = jwtService.sign({
      sub: user1.id,
      email: user1.email,
      channelId: channel1.id,
    });
    user2Jwt = jwtService.sign({
      sub: user2.id,
      email: user2.email,
      channelId: channel2.id,
    });
  });

  describe('POST /videos/upload-init', () => {
    it('returns 401 when no Authorization header', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .send({ mimeType: 'video/mp4' });

      expect(res.status).toBe(401);
    });

    it('returns 201 with the upload envelope on the happy path', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ mimeType: 'video/mp4' });

      expect(res.status).toBe(201);
      expect(res.body.videoId).toBeDefined();
      expect(res.body.videoId).toHaveLength(21);
      expect(res.body.uploadId).toBeTruthy();
      expect(res.body.bucket).toBe('streamtube-videos');
      expect(res.body.partSize).toBe(5242880);
    });
  });

  describe('POST /videos/{videoId}/upload-part-url', () => {
    it("returns 403 with UPLOAD_NOT_OWNED on another user's video", async () => {
      const a = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ mimeType: 'video/mp4' });
      const b = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${user2Jwt}`)
        .send({ mimeType: 'video/mp4' });

      const res = await request(app.getHttpServer())
        .post(`/videos/${b.body.videoId}/upload-part-url`)
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ partNumber: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('UPLOAD_NOT_OWNED');
    });

    it('returns 400 with VALIDATION_ERROR on partNumber: 0', async () => {
      const init = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ mimeType: 'video/mp4' });

      const res = await request(app.getHttpServer())
        .post(`/videos/${init.body.videoId}/upload-part-url`)
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ partNumber: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/{videoId}/upload-complete', () => {
    it('returns 400 with VALIDATION_ERROR on empty parts array', async () => {
      const init = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ mimeType: 'video/mp4' });

      const res = await request(app.getHttpServer())
        .post(`/videos/${init.body.videoId}/upload-complete`)
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ parts: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 200 with { videoId, status: "processando", queuedJobId } on happy path', async () => {
      const init = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ mimeType: 'video/mp4' });
      const videoId = init.body.videoId;

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/upload-complete`)
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ parts: [{ partNumber: 1, etag: 'etag-1' }] });

      expect(res.status).toBe(200);
      expect(res.body.videoId).toBe(videoId);
      expect(res.body.status).toBe('processando');
      expect(res.body.queuedJobId).toBeTruthy();

      const row = await videosRepository.findById(videoId);
      expect(row!.status).toBe(VIDEO_STATUS.processando);
      expect(row!.upload_id).toBeNull();
    });
  });

  describe('POST /videos/{videoId}/upload-abort', () => {
    it('returns 204 on the happy path and moves the row to erro', async () => {
      const init = await request(app.getHttpServer())
        .post('/videos/upload-init')
        .set('Authorization', `Bearer ${user1Jwt}`)
        .send({ mimeType: 'video/mp4' });

      const res = await request(app.getHttpServer())
        .post(`/videos/${init.body.videoId}/upload-abort`)
        .set('Authorization', `Bearer ${user1Jwt}`);

      expect(res.status).toBe(204);
      const row = await videosRepository.findById(init.body.videoId);
      expect(row!.status).toBe(VIDEO_STATUS.erro);
      expect(row!.failure_reason).toBe('aborted by user');
    });
  });
});
