import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import queueConfig from '../../config/queue.config';
import { QueueModule } from './videos-queue.module';
import { VIDEOS_QUEUE_NAME } from './videos-queue.constants';
import { VideosQueueProducer } from './videos-queue.producer';

const REDIS_HOST = process.env.QUEUE_HOST ?? 'redis';
const REDIS_PORT = Number(process.env.QUEUE_PORT ?? 6379);

async function flushTestQueue(): Promise<void> {
  const conn = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
  });
  const q = new Queue(VIDEOS_QUEUE_NAME, { connection: conn });
  await q.obliterate({ force: true });
  await q.close();
  await conn.quit();
}

describe('VideosQueueProducer (real BullMQ against Redis)', () => {
  let producer: VideosQueueProducer;
  let queue: Queue;
  let conn: Redis;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    conn = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
    });
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ load: [queueConfig], isGlobal: true }),
        QueueModule,
      ],
    }).compile();

    await moduleRef.init();
    producer = moduleRef.get(VideosQueueProducer);
    queue = new Queue(VIDEOS_QUEUE_NAME, { connection: conn });
  });

  afterAll(async () => {
    // Skip explicit queue/conn cleanup: BullMQ closes its own connections when
    // the Nest module is closed via moduleRef.close(), and the leftover
    // explicit-close calls race with that, causing "Connection is closed"
    // errors that fail the suite. The shared dev Redis is treated as a test
    // scratch space; the beforeEach flushTestQueue() call resets state between
    // tests.
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
    if (conn) {
      try {
        void conn.disconnect();
      } catch {
        // best-effort
      }
    }
  });

  beforeEach(async () => {
    await flushTestQueue();
  });

  it('enqueueProcessVideo returns a jobId and the job is enqueued with the given payload', async () => {
    const payload = {
      videoId: 'vid12345678901234567',
      channelId: '00000000-0000-0000-0000-000000000001',
      sourceKey: 'videos/ch/vid/source.mp4',
    };
    const result = await producer.enqueueProcessVideo(payload);

    expect(result.jobId).toBeDefined();
    expect(typeof result.jobId).toBe('string');
    expect(result.jobId.length).toBeGreaterThan(0);

    const stored = await queue.getJob(result.jobId);
    expect(stored).toBeDefined();
    expect(stored!.data).toEqual(payload);
    expect(stored!.name).toBe('process');
  });

  it('enqueueProcessVideo returns a different jobId for two consecutive calls', async () => {
    const payload = {
      videoId: 'vid111111111111111111',
      channelId: '00000000-0000-0000-0000-000000000002',
      sourceKey: 'videos/ch/vid/source.mp4',
    };

    const r1 = await producer.enqueueProcessVideo(payload);
    const r2 = await producer.enqueueProcessVideo(payload);

    expect(r1.jobId).not.toBe(r2.jobId);
  });

  it('enqueued job has defaultJobOptions: attempts=3, backoff=exponential with delay 1000', async () => {
    const { jobId } = await producer.enqueueProcessVideo({
      videoId: 'vid999999999999999999',
      channelId: '00000000-0000-0000-0000-000000000003',
      sourceKey: 'k',
    });

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
  });

  it('BullModule.registerQueue uses name "process-video" and removeOnComplete age 86400 (24h)', async () => {
    const { jobId } = await producer.enqueueProcessVideo({
      videoId: 'vid555555555555555555',
      channelId: '00000000-0000-0000-0000-000000000004',
      sourceKey: 'k',
    });

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.opts.removeOnComplete).toEqual({ age: 86400, count: 1000 });
    expect(job!.opts.removeOnFail).toBe(false);
  });

  it('removeOnFail=false is configured on the queue (failed jobs are retained)', async () => {
    const { jobId } = await producer.enqueueProcessVideo({
      videoId: 'vid_failed_aaaaaaaaaa',
      channelId: '00000000-0000-0000-0000-000000000005',
      sourceKey: 'k',
    });
    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.opts.removeOnFail).toBe(false);
  });
});
