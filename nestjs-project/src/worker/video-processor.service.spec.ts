import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { VideoProcessorService } from './video-processor.service';
import { VideosRepository } from '../videos/videos.repository';
import { StorageService } from '../videos/storage/storage.service';
import { Video, VIDEO_STATUS } from '../videos/entities/video.entity';

interface FfmpegMocks {
  call: jest.Mock;
  ffprobe: jest.Mock;
}

function getFfmpegMocks(): FfmpegMocks {
  const g = globalThis as unknown as { __ffmpegMocks?: FfmpegMocks };
  if (!g.__ffmpegMocks) {
    g.__ffmpegMocks = { call: jest.fn(), ffprobe: jest.fn() };
  }
  return g.__ffmpegMocks;
}

jest.mock('fluent-ffmpeg', () => {
  const mocks = getFfmpegMocks();
  // fluent-ffmpeg exports a function with `ffprobe` as a property.
  // We attach the ffprobe jest.fn onto the call jest.fn so both call
  // styles work (`ffmpeg(...)` and `ffmpeg.ffprobe(...)`).
  (mocks.call as unknown as { ffprobe: jest.Mock }).ffprobe = mocks.ffprobe;
  return {
    __esModule: true,
    default: mocks.call,
    ffprobe: mocks.ffprobe,
  };
});

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    promises: {
      writeFile: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockResolvedValue(Buffer.from('thumb-bytes')),
      unlink: jest.fn().mockResolvedValue(undefined),
    },
  };
});

const mockFfmpegCall = getFfmpegMocks().call;
const mockFfprobe = getFfmpegMocks().ffprobe;

interface FfmpegCommandMock {
  on: jest.Mock;
  screenshots: jest.Mock;
}

function makeJob(
  overrides: Partial<
    Job<{ videoId: string; channelId: string; sourceKey: string }>
  > = {},
): Job<{ videoId: string; channelId: string; sourceKey: string }> {
  return {
    data: { videoId: 'vid-id-1', channelId: 'channel-1', sourceKey: 'k' },
    ...overrides,
  } as unknown as Job<{
    videoId: string;
    channelId: string;
    sourceKey: string;
  }>;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'vid-id-1',
    channel_id: 'channel-1',
    title: '',
    description: null,
    status: VIDEO_STATUS.processando,
    source_key: 'k',
    thumbnail_key: null,
    upload_id: null,
    duration_seconds: null,
    width: null,
    height: null,
    size_bytes: null,
    mime_type: 'video/mp4',
    failure_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

describe('VideoProcessorService (unit, mocked deps)', () => {
  let processor: VideoProcessorService;
  let repo: jest.Mocked<VideosRepository>;
  let storage: jest.Mocked<StorageService>;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    jest.clearAllMocks();

    const repoMock: jest.Mocked<VideosRepository> = {
      createDraft: jest.fn(),
      findById: jest.fn(),
      findByIdForOwner: jest.fn(),
      markProcessing: jest.fn(),
      markReady: jest.fn().mockResolvedValue(undefined),
      markError: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<VideosRepository>;
    const storageMock: jest.Mocked<StorageService> = {
      createMultipartUpload: jest.fn(),
      presignPartUrl: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
      getObjectStream: jest.fn(),
      putObject: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessorService,
        { provide: VideosRepository, useValue: repoMock },
        { provide: StorageService, useValue: storageMock },
      ],
    }).compile();

    processor = moduleRef.get(VideoProcessorService);
    repo = moduleRef.get(VideosRepository);
    storage = moduleRef.get(StorageService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  function mockFfmpegChain(
    opts: {
      metadata?: unknown;
      thumbEnd?: 'ok' | 'error';
      thumbError?: string;
    } = {},
  ): void {
    mockFfprobe.mockImplementation(((
      _file: string,
      cb: (err: Error | null, data?: unknown) => void,
    ) => {
      if (opts.metadata === undefined) {
        cb(new Error('ffprobe-mock-failed'), undefined);
      } else {
        cb(null, opts.metadata);
      }
    }) as never);

    const cmd: FfmpegCommandMock = {
      on: jest.fn().mockImplementation(function (
        event: string,
        handler: (err?: Error) => void,
      ) {
        if (event === 'end' && opts.thumbEnd !== 'error') {
          setImmediate(() => handler());
        } else if (event === 'error' && opts.thumbEnd === 'error') {
          setImmediate(() =>
            handler(new Error(opts.thumbError ?? 'ffmpeg-error')),
          );
        }
        return cmd;
      }),
      screenshots: jest.fn().mockReturnThis(),
    };
    mockFfmpegCall.mockReturnValue(cmd as never);
  }

  it('returns immediately when the video is already pronto (idempotency)', async () => {
    const video = makeVideo({ status: VIDEO_STATUS.pronto });
    repo.findById.mockResolvedValue(video);

    await processor.process(makeJob());

    expect(storage.getObjectStream).not.toHaveBeenCalled();
    expect(mockFfprobe).not.toHaveBeenCalled();
    expect(repo.markReady).not.toHaveBeenCalled();
  });

  it('throws when the video does not exist', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(processor.process(makeJob())).rejects.toThrow(
      'Video vid-id-1 not found',
    );
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('happy path: ffprobe + thumbnail + markReady', async () => {
    const video = makeVideo();
    repo.findById.mockResolvedValue(video);
    storage.getObjectStream.mockResolvedValue({
      body: Readable.from(Buffer.from('source-bytes')),
      contentLength: 11,
      contentType: 'video/mp4',
    });
    mockFfmpegChain({
      metadata: {
        format: { duration: 12.345 },
        streams: [{ width: 1920, height: 1080, codec_name: 'h264' }],
      },
      thumbEnd: 'ok',
    });
    (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('thumb-bytes'));

    await processor.process(makeJob());

    expect(mockFfprobe).toHaveBeenCalled();
    expect(mockFfmpegCall).toHaveBeenCalled();
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/channel-1/vid-id-1/thumb.jpg',
      Buffer.from('thumb-bytes'),
      'image/jpeg',
    );
    expect(repo.markReady).toHaveBeenCalledWith('vid-id-1', {
      durationSeconds: 12.345,
      width: 1920,
      height: 1080,
      thumbnailKey: 'videos/channel-1/vid-id-1/thumb.jpg',
      sizeBytes: 12,
    });
  });

  it('ffprobe error: rethrows so BullMQ retries; markError via onFailed', async () => {
    const video = makeVideo();
    repo.findById.mockResolvedValue(video);
    storage.getObjectStream.mockResolvedValue({
      body: Readable.from(Buffer.from('source-bytes')),
      contentLength: 11,
      contentType: 'video/mp4',
    });
    mockFfmpegChain({ metadata: undefined });

    await expect(processor.process(makeJob())).rejects.toThrow(
      'ffprobe-mock-failed',
    );

    expect(repo.markError).not.toHaveBeenCalled();

    (processor as any).onFailed.call(
      processor,
      makeJob(),
      new Error('ffprobe-mock-failed'),
    );
    await new Promise((r) => setImmediate(r));
    expect(repo.markError).toHaveBeenCalledWith(
      'vid-id-1',
      'ffprobe-mock-failed',
    );
  });

  it('thumbnail error: rethrows so BullMQ retries; markError via onFailed', async () => {
    const video = makeVideo();
    repo.findById.mockResolvedValue(video);
    storage.getObjectStream.mockResolvedValue({
      body: Readable.from(Buffer.from('source-bytes')),
      contentLength: 11,
      contentType: 'video/mp4',
    });
    mockFfmpegChain({
      metadata: {
        format: { duration: 5 },
        streams: [{ width: 1280, height: 720 }],
      },
      thumbEnd: 'error',
      thumbError: 'ffmpeg-thumb-failed',
    });

    await expect(processor.process(makeJob())).rejects.toThrow(
      'ffmpeg-thumb-failed',
    );

    expect(storage.putObject).not.toHaveBeenCalled();
    expect(repo.markReady).not.toHaveBeenCalled();
  });
});
