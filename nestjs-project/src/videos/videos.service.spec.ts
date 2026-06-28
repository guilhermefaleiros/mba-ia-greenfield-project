import { DataSource } from 'typeorm';
import {
  UploadCompleteFailedException,
  UploadNotActiveException,
  UploadNotOwnedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { Video, VIDEO_STATUS } from './entities/video.entity';
import { VideosQueueProducer } from './queue/videos-queue.producer';
import { StorageService } from './storage/storage.service';
import { VideosService } from './videos.service';
import { VideosRepository } from './videos.repository';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'aaaaaaaaaaaaaaaaaaaaa',
    channel_id: 'ch1',
    title: '',
    description: null,
    status: VIDEO_STATUS.aguardando_upload,
    source_key: 'videos/ch1/aaaaaaaaaaaaaaaaaaaaa/source.mp4',
    thumbnail_key: null,
    upload_id: 'some-upload-id',
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

type StorageMock = {
  createMultipartUpload: jest.Mock;
  presignPartUrl: jest.Mock;
  completeMultipartUpload: jest.Mock;
  abortMultipartUpload: jest.Mock;
  getObjectStream: jest.Mock;
  putObject: jest.Mock;
};

type ProducerMock = {
  enqueueProcessVideo: jest.Mock;
};

type RepoMock = {
  createDraft: jest.Mock;
  findById: jest.Mock;
  findByIdForOwner: jest.Mock;
  markProcessing: jest.Mock;
  markReady: jest.Mock;
  markError: jest.Mock;
};

type DataSourceMock = {
  transaction: jest.Mock;
  getRepository: jest.Mock;
};

function makeService(
  opts: {
    repository?: Partial<RepoMock>;
    storage?: Partial<StorageMock>;
    producer?: Partial<ProducerMock>;
    dataSource?: Partial<DataSourceMock>;
    bucket?: string;
  } = {},
): {
  service: VideosService;
  repo: RepoMock;
  storage: StorageMock;
  producer: ProducerMock;
  dataSource: DataSourceMock;
} {
  const repo: RepoMock = {
    createDraft: jest.fn(),
    findById: jest.fn(),
    findByIdForOwner: jest.fn(),
    markProcessing: jest.fn(),
    markReady: jest.fn(),
    markError: jest.fn(),
    ...(opts.repository ?? {}),
  };
  const storage: StorageMock = {
    createMultipartUpload: jest.fn(),
    presignPartUrl: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    getObjectStream: jest.fn(),
    putObject: jest.fn(),
    ...(opts.storage ?? {}),
  };
  const producer: ProducerMock = {
    enqueueProcessVideo: jest.fn(),
    ...(opts.producer ?? {}),
  };
  const dataSource: DataSourceMock = {
    transaction: jest
      .fn()
      .mockImplementation((cb: (manager: unknown) => Promise<unknown>) =>
        cb({
          getRepository: jest.fn().mockReturnValue({
            update: jest.fn().mockResolvedValue(undefined),
          }),
        }),
      ),
    getRepository: jest.fn().mockReturnValue({
      update: jest.fn().mockResolvedValue(undefined),
    }),
    ...(opts.dataSource ?? {}),
  };

  const service = new VideosService(
    repo as unknown as VideosRepository,
    storage as unknown as StorageService,
    producer as unknown as VideosQueueProducer,
    dataSource as unknown as DataSource,
    { bucket: opts.bucket ?? 'streamtube-videos' } as never,
  );
  return { service, repo, storage, producer, dataSource };
}

describe('VideosService (unit, mocked deps)', () => {
  describe('initUpload', () => {
    it('returns the upload envelope (videoId, uploadId, bucket, key, partSize)', async () => {
      const draftId = 'V1StGXR8_Z5jdHi6B-myT';
      const { service, repo, storage } = makeService();
      repo.createDraft.mockResolvedValue(makeVideo({ id: draftId }));
      storage.createMultipartUpload.mockResolvedValue({
        uploadId: 's3-upload-id',
      });

      const result = await service.initUpload('ch1', { mimeType: 'video/mp4' });

      expect(result.videoId).toBe(draftId);
      expect(result.videoId).toHaveLength(21);
      expect(result.uploadId).toBe('s3-upload-id');
      expect(result.bucket).toBe('streamtube-videos');
      expect(result.key).toBe(`videos/ch1/${draftId}/source.mp4`);
      expect(result.partSize).toBe(5 * 1024 * 1024);
    });

    it('persists the source_key and upload_id back to the videos row', async () => {
      const draftId = 'aaaaaaaaaaaaaaaaaaaaa';
      const { service, repo, storage, dataSource } = makeService();
      const updateMock = jest.fn().mockResolvedValue(undefined);
      repo.createDraft.mockResolvedValue(makeVideo({ id: draftId }));
      storage.createMultipartUpload.mockResolvedValue({ uploadId: 'u1' });
      dataSource.getRepository = jest
        .fn()
        .mockReturnValue({ update: updateMock });

      await service.initUpload('ch1', { mimeType: 'video/mp4' });

      expect(updateMock).toHaveBeenCalledWith(
        { id: draftId },
        { source_key: `videos/ch1/${draftId}/source.mp4`, upload_id: 'u1' },
      );
    });
  });

  describe('getPresignedPartUrl', () => {
    it('throws VideoNotFound when the video does not exist', async () => {
      const { service, repo } = makeService();
      repo.findById.mockResolvedValue(null);

      await expect(
        service.getPresignedPartUrl('ch1', 'missing', { partNumber: 1 }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws UploadNotOwned when the channel does not own the video', async () => {
      const { service, repo } = makeService();
      repo.findById.mockResolvedValue(
        makeVideo({ channel_id: 'other-channel' }),
      );

      await expect(
        service.getPresignedPartUrl('ch1', 'vid', { partNumber: 1 }),
      ).rejects.toBeInstanceOf(UploadNotOwnedException);
    });

    it('throws UploadNotActive when status is not aguardando_upload', async () => {
      const { service, repo } = makeService();
      repo.findById.mockResolvedValue(
        makeVideo({ status: VIDEO_STATUS.processando, upload_id: null }),
      );

      await expect(
        service.getPresignedPartUrl('ch1', 'vid', { partNumber: 1 }),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
    });

    it('returns a presigned URL on the happy path', async () => {
      const { service, repo, storage } = makeService();
      repo.findById.mockResolvedValue(makeVideo());
      storage.presignPartUrl.mockResolvedValue({
        url: 'http://minio:9000/presigned',
        expiresAt: new Date(),
      });

      const result = await service.getPresignedPartUrl('ch1', 'vid', {
        partNumber: 3,
      });

      expect(result.url).toBe('http://minio:9000/presigned');
      expect(storage.presignPartUrl).toHaveBeenCalledWith(
        'videos/ch1/aaaaaaaaaaaaaaaaaaaaa/source.mp4',
        'some-upload-id',
        3,
      );
    });
  });

  describe('completeUpload', () => {
    it('flips status to processando, completes the multipart, and enqueues a job (happy path)', async () => {
      const { service, repo, storage, producer } = makeService();
      repo.findById.mockResolvedValue(makeVideo());
      producer.enqueueProcessVideo.mockResolvedValue({ jobId: 'job-1' });

      const result = await service.completeUpload(
        'ch1',
        'aaaaaaaaaaaaaaaaaaaaa',
        { parts: [{ partNumber: 1, etag: 'etag-1' }] },
      );

      expect(result.status).toBe(VIDEO_STATUS.processando);
      expect(result.queuedJobId).toBe('job-1');
      expect(result.videoId).toBe('aaaaaaaaaaaaaaaaaaaaa');
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/ch1/aaaaaaaaaaaaaaaaaaaaa/source.mp4',
        'some-upload-id',
        [{ partNumber: 1, etag: 'etag-1' }],
      );
      expect(producer.enqueueProcessVideo).toHaveBeenCalledWith({
        videoId: 'aaaaaaaaaaaaaaaaaaaaa',
        channelId: 'ch1',
        sourceKey: 'videos/ch1/aaaaaaaaaaaaaaaaaaaaa/source.mp4',
      });
    });

    it('rolls back the transaction and throws UploadCompleteFailed when completeMultipartUpload throws', async () => {
      const { service, repo, storage, producer, dataSource } = makeService();
      repo.findById.mockResolvedValue(makeVideo());
      const updateInTx = jest.fn();
      const manager = {
        getRepository: jest.fn().mockReturnValue({ update: updateInTx }),
      };
      dataSource.transaction = jest
        .fn()
        .mockImplementation((cb: (manager: unknown) => Promise<unknown>) =>
          cb(manager),
        );
      storage.completeMultipartUpload.mockRejectedValue(new Error('s3 boom'));

      await expect(
        service.completeUpload('ch1', 'aaaaaaaaaaaaaaaaaaaaa', {
          parts: [{ partNumber: 1, etag: 'etag-1' }],
        }),
      ).rejects.toBeInstanceOf(UploadCompleteFailedException);

      expect(producer.enqueueProcessVideo).not.toHaveBeenCalled();
    });

    it('throws VideoNotFound when the video does not exist', async () => {
      const { service, repo } = makeService();
      repo.findById.mockResolvedValue(null);

      await expect(
        service.completeUpload('ch1', 'vid', {
          parts: [{ partNumber: 1, etag: 'etag-1' }],
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws UploadNotOwned when channelId does not match', async () => {
      const { service, repo } = makeService();
      repo.findById.mockResolvedValue(
        makeVideo({ channel_id: 'other-channel' }),
      );

      await expect(
        service.completeUpload('ch1', 'aaaaaaaaaaaaaaaaaaaaa', {
          parts: [{ partNumber: 1, etag: 'etag-1' }],
        }),
      ).rejects.toBeInstanceOf(UploadNotOwnedException);
    });
  });

  describe('abortUpload', () => {
    it('calls abortMultipartUpload and markError with "aborted by user"', async () => {
      const { service, repo, storage } = makeService();
      repo.findById.mockResolvedValue(makeVideo());

      await service.abortUpload('ch1', 'aaaaaaaaaaaaaaaaaaaaa');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/ch1/aaaaaaaaaaaaaaaaaaaaa/source.mp4',
        'some-upload-id',
      );
      expect(repo.markError).toHaveBeenCalledWith(
        'aaaaaaaaaaaaaaaaaaaaa',
        'aborted by user',
      );
    });

    it('throws UploadNotActive when the video is already past aguardando_upload', async () => {
      const { service, repo, storage } = makeService();
      repo.findById.mockResolvedValue(
        makeVideo({ status: VIDEO_STATUS.pronto, upload_id: null }),
      );

      await expect(
        service.abortUpload('ch1', 'aaaaaaaaaaaaaaaaaaaaa'),
      ).rejects.toBeInstanceOf(UploadNotActiveException);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });
  });
});
