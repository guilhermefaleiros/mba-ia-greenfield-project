import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { VIDEOS_QUEUE_NAME } from './videos-queue.constants';

export interface ProcessVideoPayload {
  videoId: string;
  channelId: string;
  sourceKey: string;
}

export interface EnqueueResult {
  jobId: string;
}

@Injectable()
export class VideosQueueProducer {
  constructor(@InjectQueue(VIDEOS_QUEUE_NAME) private readonly queue: Queue) {}

  async enqueueProcessVideo(
    payload: ProcessVideoPayload,
  ): Promise<EnqueueResult> {
    const job = await this.queue.add('process', payload);
    if (!job.id) {
      throw new Error('BullMQ did not return a job id');
    }
    return { jobId: String(job.id) };
  }
}
