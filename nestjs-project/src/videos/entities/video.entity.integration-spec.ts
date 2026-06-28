import { DataSource, Repository } from 'typeorm';
import { nanoid } from 'nanoid';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VIDEO_STATUS } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

async function seedUserAndChannel(
  dataSource: DataSource,
): Promise<{ user: User; channel: Channel }> {
  const userRepo = dataSource.getRepository(User);
  const channelRepo = dataSource.getRepository(Channel);
  const counter = Date.now();
  const user = await userRepo.save(
    userRepo.create({
      email: `vid_entity_${counter}@example.com`,
      password: 'hashed',
    }),
  );
  const channel = await channelRepo.save(
    channelRepo.create({
      name: `chan_${counter}`,
      nickname: `vid_entity_chan_${counter}`,
      user_id: user.id,
    }),
  );
  return { user, channel };
}

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let seeded: { user: User; channel: Channel };

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    seeded = await seedUserAndChannel(dataSource);
  });

  it('should accept an insert with a 21-char nanoid id', async () => {
    const id = nanoid(21);
    const video = await videoRepository.save(
      videoRepository.create({
        id,
        channel_id: seeded.channel.id,
        source_key: `videos/${seeded.channel.id}/${id}/source.mp4`,
        upload_id: 'some-upload-id',
      }),
    );

    expect(video.id).toBe(id);
    expect(video.id).toHaveLength(21);
    expect(video.status).toBe(VIDEO_STATUS.rascunho);
  });

  it('should reject duplicate id with unique violation', async () => {
    const id = nanoid(21);
    await videoRepository.save(
      videoRepository.create({
        id,
        channel_id: seeded.channel.id,
        source_key: 'k1',
      }),
    );

    await expect(
      dataSource.query(
        `INSERT INTO videos (id, channel_id, source_key) VALUES ($1, $2, 'k2')`,
        [id, seeded.channel.id],
      ),
    ).rejects.toThrow();
  });

  it('should reject insert with non-existent channel_id (FK violation)', async () => {
    const fakeChannelId = '00000000-0000-0000-0000-000000000000';
    await expect(
      videoRepository.save(
        videoRepository.create({
          id: nanoid(21),
          channel_id: fakeChannelId,
          source_key: 'k',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should default status to rascunho and source_key to empty string', async () => {
    const id = nanoid(21);
    const video = await videoRepository.save(
      videoRepository.create({
        id,
        channel_id: seeded.channel.id,
      }),
    );

    expect(video.status).toBe(VIDEO_STATUS.rascunho);
    expect(video.source_key).toBe('');
    expect(video.title).toBe('');
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should allow nullable fields: description, thumbnail_key, upload_id, duration_seconds, width, height, size_bytes, mime_type, failure_reason', async () => {
    const video = await videoRepository.save(
      videoRepository.create({
        id: nanoid(21),
        channel_id: seeded.channel.id,
        source_key: 'k',
      }),
    );

    expect(video.description).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.size_bytes).toBeNull();
    expect(video.mime_type).toBeNull();
    expect(video.failure_reason).toBeNull();
  });

  it('should reject an invalid status value', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO videos (id, channel_id, source_key, status) VALUES ($1, $2, 'k', 'invalid_status')`,
        [nanoid(21), seeded.channel.id],
      ),
    ).rejects.toThrow();
  });

  it('should cascade-delete videos when the channel is deleted', async () => {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const counter = Date.now();
    const otherUser = await userRepo.save(
      userRepo.create({
        email: `cascade_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const otherChannel = await channelRepo.save(
      channelRepo.create({
        name: 'to_delete',
        nickname: `cascade_chan_${counter}`,
        user_id: otherUser.id,
      }),
    );
    await videoRepository.save(
      videoRepository.create({
        id: nanoid(21),
        channel_id: otherChannel.id,
        source_key: 'k',
      }),
    );
    await videoRepository.save(
      videoRepository.create({
        id: nanoid(21),
        channel_id: otherChannel.id,
        source_key: 'k2',
      }),
    );

    expect(
      await videoRepository.count({ where: { channel_id: otherChannel.id } }),
    ).toBe(2);

    await channelRepo.delete({ id: otherChannel.id });

    expect(
      await videoRepository.count({ where: { channel_id: otherChannel.id } }),
    ).toBe(0);
  });
});
