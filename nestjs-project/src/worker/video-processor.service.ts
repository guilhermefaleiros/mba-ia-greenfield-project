import { Injectable } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VIDEOS_QUEUE_NAME } from '../videos/queue/videos-queue.constants';
import { VIDEO_STATUS } from '../videos/entities/video.entity';
import { buildThumbnailKey } from '../videos/storage/storage.keys';
import { StorageService } from '../videos/storage/storage.service';
import { VideosRepository } from '../videos/videos.repository';

export interface ProcessVideoPayload {
  videoId: string;
  channelId: string;
  sourceKey: string;
}

interface FfprobeMetadata {
  format?: { duration?: string | number };
  streams?: Array<{
    width?: number;
    height?: number;
    codec_name?: string;
  }>;
}

const TMP_FOLDER = tmpdir();
const SOURCE_TMP_FILENAME = 'video-source.mp4';
const THUMBNAIL_FILENAME = 'video-thumb.jpg';
const THUMBNAIL_SIZE = '1280x720';

@Injectable()
@Processor(VIDEOS_QUEUE_NAME, { concurrency: 1 })
export class VideoProcessorService extends WorkerHost {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoPayload>): Promise<void> {
    const { videoId, sourceKey, channelId } = job.data;
    const video = await this.videosRepository.findById(videoId);
    if (!video) {
      throw new Error(`Video ${videoId} not found`);
    }
    if (video.status === VIDEO_STATUS.pronto) {
      return;
    }

    const stream = await this.storageService.getObjectStream(sourceKey);
    const sourceBuffer = await streamToBuffer(stream.body);

    const sourcePath = join(TMP_FOLDER, SOURCE_TMP_FILENAME);
    await fs.writeFile(sourcePath, sourceBuffer);

    try {
      const metadata = await this.ffprobeFile(sourcePath);
      const duration = this.parseDuration(metadata.format?.duration);
      const firstVideoStream = metadata.streams?.find(
        (s) => typeof s.width === 'number' && typeof s.height === 'number',
      );
      const width = firstVideoStream?.width ?? 0;
      const height = firstVideoStream?.height ?? 0;

      const thumbnailKey = buildThumbnailKey(channelId, videoId);
      const thumbnailPath = join(TMP_FOLDER, THUMBNAIL_FILENAME);
      try {
        await this.generateThumbnail(sourcePath);
        const thumbBuffer = await fs.readFile(thumbnailPath);
        await this.storageService.putObject(
          thumbnailKey,
          thumbBuffer,
          'image/jpeg',
        );
      } finally {
        await fs.unlink(thumbnailPath).catch(() => undefined);
      }

      await this.videosRepository.markReady(videoId, {
        durationSeconds: duration,
        width,
        height,
        thumbnailKey,
        sizeBytes: sourceBuffer.length,
      });
    } finally {
      await fs.unlink(sourcePath).catch(() => undefined);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<ProcessVideoPayload>, err: Error): void {
    const reason = err.message || 'unknown worker error';
    void this.videosRepository.markError(job.data.videoId, reason).catch(() => {
      // best-effort
    });
  }

  private ffprobeFile(filePath: string): Promise<FfprobeMetadata> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(metadata as unknown as FfprobeMetadata);
      });
    });
  }

  private generateThumbnail(sourcePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(sourcePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          count: 1,
          timemarks: ['10%'],
          folder: TMP_FOLDER,
          filename: THUMBNAIL_FILENAME,
          size: THUMBNAIL_SIZE,
        });
    });
  }

  private parseDuration(duration: string | number | undefined): number {
    if (duration === undefined) return 0;
    const parsed =
      typeof duration === 'string' ? parseFloat(duration) : duration;
    return Number.isFinite(parsed) ? parsed : 0;
  }
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer | string) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    );
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
