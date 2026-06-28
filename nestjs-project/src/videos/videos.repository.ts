import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { nanoid } from 'nanoid';
import { Video, VideoStatus, VIDEO_STATUS } from './entities/video.entity';

export interface CreateDraftInput {
  channelId: string;
  title?: string;
  mimeType: string;
  sourceKey: string;
  uploadId: string;
}

export interface MarkReadyInput {
  durationSeconds: number;
  width: number;
  height: number;
  thumbnailKey: string;
  sizeBytes: number;
}

@Injectable()
export class VideosRepository {
  constructor(
    @InjectRepository(Video)
    private readonly repository: Repository<Video>,
  ) {}

  findById(id: string): Promise<Video | null> {
    return this.repository.findOne({ where: { id } });
  }

  findByIdForOwner(id: string, channelId: string): Promise<Video | null> {
    return this.repository.findOne({ where: { id, channel_id: channelId } });
  }

  async createDraft(input: CreateDraftInput): Promise<Video> {
    const video = this.repository.create({
      id: nanoid(21),
      channel_id: input.channelId,
      title: input.title ?? '',
      status: VIDEO_STATUS.aguardando_upload as VideoStatus,
      source_key: input.sourceKey,
      upload_id: input.uploadId,
      mime_type: input.mimeType,
    });
    return this.repository.save(video);
  }

  async markProcessing(id: string): Promise<void> {
    await this.repository.update(
      { id },
      { status: VIDEO_STATUS.processando, upload_id: null },
    );
  }

  async markReady(id: string, input: MarkReadyInput): Promise<void> {
    await this.repository.update(
      { id },
      {
        status: VIDEO_STATUS.pronto,
        duration_seconds: input.durationSeconds.toFixed(3),
        width: input.width,
        height: input.height,
        thumbnail_key: input.thumbnailKey,
        size_bytes: input.sizeBytes.toString(),
      },
    );
  }

  async markError(id: string, reason: string): Promise<void> {
    await this.repository.update(
      { id },
      { status: VIDEO_STATUS.erro, failure_reason: reason },
    );
  }
}
