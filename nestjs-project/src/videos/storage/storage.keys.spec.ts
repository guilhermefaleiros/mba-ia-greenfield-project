import { buildSourceKey, buildThumbnailKey } from './storage.keys';

describe('buildSourceKey', () => {
  it('returns the verbatim "videos/{channelId}/{videoId}/source.mp4" key', () => {
    expect(buildSourceKey('channel-uuid', 'vidnanoid21')).toBe(
      'videos/channel-uuid/vidnanoid21/source.mp4',
    );
  });

  it('preserves underscores and special characters in ids', () => {
    const channelId = 'ch_abc-123';
    const videoId = 'V1StGXR8_Z5jdHi6B-myT';
    expect(buildSourceKey(channelId, videoId)).toBe(
      'videos/ch_abc-123/V1StGXR8_Z5jdHi6B-myT/source.mp4',
    );
  });
});

describe('buildThumbnailKey', () => {
  it('returns the verbatim "videos/{channelId}/{videoId}/thumb.jpg" key', () => {
    expect(buildThumbnailKey('channel-uuid', 'vidnanoid21')).toBe(
      'videos/channel-uuid/vidnanoid21/thumb.jpg',
    );
  });

  it('uses .jpg extension (not .jpeg)', () => {
    expect(buildThumbnailKey('c', 'v')).toBe('videos/c/v/thumb.jpg');
  });
});
