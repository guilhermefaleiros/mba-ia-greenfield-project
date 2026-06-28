import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import * as http from 'node:http';
import { URL } from 'node:url';
import { Redis } from 'ioredis';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VIDEO_STATUS } from './entities/video.entity';
import { QueueModule } from './queue/videos-queue.module';
import { VIDEOS_QUEUE_NAME } from './queue/videos-queue.constants';
import { StorageModule } from './storage/storage.module';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

function httpPut(
  url: string,
  body: Buffer,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        method: 'PUT',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: { 'Content-Length': body.length },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('VideosService (integration, real DB + MinIO + Redis)', () => {
  let service: VideosService;
  let repo: VideosRepository;
  let moduleRef: TestingModule;
  let queueConn: Redis;
  let queue: Queue;
  let channelId: string;

  beforeAll(async () => {
    queueConn = new Redis({
      host: process.env.QUEUE_HOST ?? 'redis',
      port: Number(process.env.QUEUE_PORT ?? 6379),
      maxRetriesPerRequest: null,
    });
    queue = new Queue(VIDEOS_QUEUE_NAME, { connection: queueConn });
    await queue.obliterate({ force: true });

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig, queueConfig],
          isGlobal: true,
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, Channel, User]),
        StorageModule,
        QueueModule,
      ],
      providers: [VideosRepository, VideosService],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(VideosService);
    repo = moduleRef.get(VideosRepository);
  });

  afterAll(async () => {
    if (moduleRef) {
      try {
        await moduleRef.close();
      } catch {
        // best-effort
      }
    }
    if (queue) {
      try {
        void queue.disconnect();
      } catch {
        // best-effort
      }
    }
    if (queueConn) {
      try {
        void queueConn.disconnect();
      } catch {
        // best-effort
      }
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource(moduleRef));
    await queue.obliterate({ force: true });
    channelId = await seedChannel(moduleRef);
  });

  function dataSource(ref: TestingModule): import('typeorm').DataSource {
    return ref.get(DataSource);
  }

  async function seedChannel(ref: TestingModule): Promise<string> {
    const ds = ref.get(DataSource);
    const userRepo = ds.getRepository(User);
    const channelRepo = ds.getRepository(Channel);
    const counter = Date.now();
    const user = await userRepo.save(
      userRepo.create({
        email: `vid_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: `chan_${counter}`,
        nickname: `vid_svc_chan_${counter}`,
        user_id: user.id,
      }),
    );
    return channel.id;
  }

  it('initUpload creates a draft in aguardando_upload and returns the upload envelope', async () => {
    const result = await service.initUpload(channelId, {
      mimeType: 'video/mp4',
      title: 'Hello',
    });

    expect(result.videoId).toHaveLength(21);
    expect(result.uploadId).toBeTruthy();
    expect(result.bucket).toBe('streamtube-videos');
    expect(result.key).toBe(`videos/${channelId}/${result.videoId}/source.mp4`);
    expect(result.partSize).toBe(5 * 1024 * 1024);

    const row = await repo.findById(result.videoId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe(VIDEO_STATUS.aguardando_upload);
    expect(row!.upload_id).toBe(result.uploadId);
    expect(row!.source_key).toBe(result.key);
    expect(row!.mime_type).toBe('video/mp4');
    expect(row!.title).toBe('Hello');
  });

  it('getPresignedPartUrl returns a PUT-acceptable URL', async () => {
    const init = await service.initUpload(channelId, { mimeType: 'video/mp4' });

    const { url } = await service.getPresignedPartUrl(channelId, init.videoId, {
      partNumber: 1,
    });

    const put = await httpPut(url, Buffer.from('hello-minio'));
    expect(put.statusCode).toBe(200);
  }, 15000);

  it('completeUpload transitions to processando, enqueues a job, and leaves a complete object in MinIO', async () => {
    const init = await service.initUpload(channelId, { mimeType: 'video/mp4' });

    const { url } = await service.getPresignedPartUrl(channelId, init.videoId, {
      partNumber: 1,
    });
    const put = await httpPut(url, Buffer.alloc(5 * 1024 * 1024, 1));
    expect(put.statusCode).toBe(200);
    const etag = String(put.headers.etag);

    const result = await service.completeUpload(channelId, init.videoId, {
      parts: [{ partNumber: 1, etag }],
    });

    expect(result.status).toBe(VIDEO_STATUS.processando);
    expect(result.queuedJobId).toBeTruthy();

    const row = await repo.findById(init.videoId);
    expect(row!.status).toBe(VIDEO_STATUS.processando);
    expect(row!.upload_id).toBeNull();

    const job = await queue.getJob(result.queuedJobId);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({
      videoId: init.videoId,
      channelId,
      sourceKey: init.key,
    });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  }, 30000);

  it('abortUpload calls Multipart Abort and moves the row to erro with "aborted by user"', async () => {
    const init = await service.initUpload(channelId, { mimeType: 'video/mp4' });

    await service.abortUpload(channelId, init.videoId);

    const row = await repo.findById(init.videoId);
    expect(row!.status).toBe(VIDEO_STATUS.erro);
    expect(row!.failure_reason).toBe('aborted by user');
  }, 15000);
});
