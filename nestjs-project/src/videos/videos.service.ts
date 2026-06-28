import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import storageConfig from '../config/storage.config';
import {
  UploadCompleteFailedException,
  UploadNotActiveException,
  UploadNotOwnedException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { UploadCompleteDto } from './dto/upload-complete.dto';
import { UploadInitDto } from './dto/upload-init.dto';
import { UploadPartUrlDto } from './dto/upload-part-url.dto';
import { Video, VIDEO_STATUS } from './entities/video.entity';
import { VideosQueueProducer } from './queue/videos-queue.producer';
import { buildSourceKey } from './storage/storage.keys';
import { StorageService } from './storage/storage.service';
import { VideosRepository } from './videos.repository';

const PART_SIZE_BYTES = 5 * 1024 * 1024;

export interface InitUploadResult {
  videoId: string;
  uploadId: string;
  bucket: string;
  key: string;
  partSize: number;
}

export interface PresignPartResult {
  url: string;
  expiresAt: Date;
}

export interface CompleteUploadResult {
  videoId: string;
  status: typeof VIDEO_STATUS.processando;
  queuedJobId: string;
}

@Injectable()
export class VideosService {
  constructor(
    private readonly videosRepository: VideosRepository,
    private readonly storageService: StorageService,
    private readonly queueProducer: VideosQueueProducer,
    private readonly dataSource: DataSource,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async initUpload(
    channelId: string,
    dto: UploadInitDto,
  ): Promise<InitUploadResult> {
    const draft = await this.videosRepository.createDraft({
      channelId,
      title: dto.title,
      mimeType: dto.mimeType,
      sourceKey: '',
      uploadId: '',
    });
    const key = buildSourceKey(channelId, draft.id);
    const { uploadId } = await this.storageService.createMultipartUpload(
      key,
      dto.mimeType,
    );
    await this.dataSource
      .getRepository(Video)
      .update({ id: draft.id }, { source_key: key, upload_id: uploadId });

    return {
      videoId: draft.id,
      uploadId,
      bucket: this.storageCfg.bucket,
      key,
      partSize: PART_SIZE_BYTES,
    };
  }

  async getPresignedPartUrl(
    channelId: string,
    videoId: string,
    dto: UploadPartUrlDto,
  ): Promise<PresignPartResult> {
    const video = await this.videosRepository.findById(videoId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new UploadNotOwnedException();
    }
    if (video.status !== VIDEO_STATUS.aguardando_upload || !video.upload_id) {
      throw new UploadNotActiveException();
    }
    return this.storageService.presignPartUrl(
      video.source_key,
      video.upload_id,
      dto.partNumber,
    );
  }

  async completeUpload(
    channelId: string,
    videoId: string,
    dto: UploadCompleteDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videosRepository.findById(videoId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new UploadNotOwnedException();
    }
    if (video.status !== VIDEO_STATUS.aguardando_upload || !video.upload_id) {
      throw new UploadNotActiveException();
    }

    const uploadId = video.upload_id;
    const sourceKey = video.source_key;
    let queuedJobId: string | undefined;

    try {
      await this.dataSource.transaction(async (manager: EntityManager) => {
        const repo = manager.getRepository(Video);
        await repo.update(
          { id: videoId },
          { status: VIDEO_STATUS.processando, upload_id: null },
        );
        await this.storageService.completeMultipartUpload(
          sourceKey,
          uploadId,
          dto.parts,
        );
        const { jobId } = await this.queueProducer.enqueueProcessVideo({
          videoId,
          channelId,
          sourceKey,
        });
        queuedJobId = jobId;
      });
    } catch (err) {
      if (
        err instanceof VideoNotFoundException ||
        err instanceof UploadNotOwnedException ||
        err instanceof UploadNotActiveException
      ) {
        throw err;
      }
      const message =
        err instanceof Error ? err.message : 'Unknown error during complete';
      throw new UploadCompleteFailedException(message);
    }

    return {
      videoId,
      status: VIDEO_STATUS.processando,
      queuedJobId: queuedJobId!,
    };
  }
  async abortUpload(channelId: string, videoId: string): Promise<void> {
    const video = await this.videosRepository.findById(videoId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel_id !== channelId) {
      throw new UploadNotOwnedException();
    }
    if (video.status !== VIDEO_STATUS.aguardando_upload || !video.upload_id) {
      throw new UploadNotActiveException();
    }

    try {
      await this.storageService.abortMultipartUpload(
        video.source_key,
        video.upload_id,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'abort failed';
      throw new UploadCompleteFailedException(message);
    }
    await this.videosRepository.markError(videoId, 'aborted by user');
  }

  async findByIdForStream(videoId: string): Promise<Video> {
    const video = await this.videosRepository.findById(videoId);
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getObjectStream(
    sourceKey: string,
    rangeHeader?: string,
  ): ReturnType<StorageService['getObjectStream']> {
    return this.storageService.getObjectStream(sourceKey, rangeHeader);
  }
}
