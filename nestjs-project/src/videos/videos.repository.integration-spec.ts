import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VIDEO_STATUS } from './entities/video.entity';
import { VideosRepository } from './videos.repository';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosRepository (integration)', () => {
  let dataSource: DataSource;
  let repo: VideosRepository;
  let channelId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, Channel, User]),
      ],
      providers: [VideosRepository],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    repo = moduleRef.get(VideosRepository);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const counter = Date.now();
    const user = await userRepo.save(
      userRepo.create({
        email: `vid_repo_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: `chan_${counter}`,
        nickname: `vid_repo_chan_${counter}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  describe('createDraft', () => {
    it('returns a Video with nanoid(21) id, status aguardando_upload, and populated source_key/upload_id', async () => {
      const video = await repo.createDraft({
        channelId,
        title: 'My Video',
        mimeType: 'video/mp4',
        sourceKey: `videos/${channelId}/abc/source.mp4`,
        uploadId: 'multipart-upload-id-123',
      });

      expect(video.id).toHaveLength(21);
      expect(video.id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(video.status).toBe(VIDEO_STATUS.aguardando_upload);
      expect(video.source_key).toBe(`videos/${channelId}/abc/source.mp4`);
      expect(video.upload_id).toBe('multipart-upload-id-123');
      expect(video.mime_type).toBe('video/mp4');
      expect(video.title).toBe('My Video');
    });

    it('defaults title to empty string when omitted', async () => {
      const video = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });

      expect(video.title).toBe('');
    });

    it('rejects a second draft with the same generated id (unique violation)', async () => {
      const first = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });

      const collision = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });

      expect(first.id).not.toBe(collision.id);
    });
  });

  describe('findById', () => {
    it('returns null when the id does not exist', async () => {
      const result = await repo.findById('nonexistent-id-that-is-21-chars');
      expect(result).toBeNull();
    });

    it('returns the video by id', async () => {
      const created = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });
      const found = await repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });
  });

  describe('findByIdForOwner', () => {
    it('returns null when the id does not exist', async () => {
      const result = await repo.findByIdForOwner(
        'nonexistent-id-that-is-21-chars',
        channelId,
      );
      expect(result).toBeNull();
    });

    it('returns null when the id exists but belongs to a different channel', async () => {
      const created = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });
      const otherChannel = '00000000-0000-0000-0000-000000000000';
      const result = await repo.findByIdForOwner(created.id, otherChannel);
      expect(result).toBeNull();
    });

    it('returns the video when the id belongs to the given channel', async () => {
      const created = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });
      const found = await repo.findByIdForOwner(created.id, channelId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });
  });

  describe('markProcessing', () => {
    it('moves status to processando and clears upload_id', async () => {
      const created = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });

      await repo.markProcessing(created.id);

      const after = await repo.findById(created.id);
      expect(after!.status).toBe(VIDEO_STATUS.processando);
      expect(after!.upload_id).toBeNull();
    });
  });

  describe('markReady', () => {
    it('moves status to pronto and populates duration/dimensions/thumbnail/size', async () => {
      const created = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });
      await repo.markProcessing(created.id);

      await repo.markReady(created.id, {
        durationSeconds: 123.456,
        width: 1920,
        height: 1080,
        thumbnailKey: `videos/${channelId}/${created.id}/thumb.jpg`,
        sizeBytes: 1024 * 1024 * 50,
      });

      const after = await repo.findById(created.id);
      expect(after!.status).toBe(VIDEO_STATUS.pronto);
      expect(after!.duration_seconds).toBe('123.456');
      expect(after!.width).toBe(1920);
      expect(after!.height).toBe(1080);
      expect(after!.thumbnail_key).toBe(
        `videos/${channelId}/${created.id}/thumb.jpg`,
      );
      expect(after!.size_bytes).toBe(String(1024 * 1024 * 50));
    });
  });

  describe('markError', () => {
    it('moves status to erro and populates failure_reason', async () => {
      const created = await repo.createDraft({
        channelId,
        mimeType: 'video/mp4',
        sourceKey: 'k',
        uploadId: 'u',
      });

      await repo.markError(created.id, 'falha no upload');

      const after = await repo.findById(created.id);
      expect(after!.status).toBe(VIDEO_STATUS.erro);
      expect(after!.failure_reason).toBe('falha no upload');
    });
  });
});
