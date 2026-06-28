export const VIDEO_FILE_EXTENSION = '.mp4';
export const THUMBNAIL_FILE_EXTENSION = '.jpg';

export function buildSourceKey(channelId: string, videoId: string): string {
  return `videos/${channelId}/${videoId}/source${VIDEO_FILE_EXTENSION}`;
}

export function buildThumbnailKey(channelId: string, videoId: string): string {
  return `videos/${channelId}/${videoId}/thumb${THUMBNAIL_FILE_EXTENSION}`;
}
