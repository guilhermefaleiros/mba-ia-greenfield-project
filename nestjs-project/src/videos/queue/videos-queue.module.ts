import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ConfigModule } from '@nestjs/config';
import queueConfig from '../../config/queue.config';
import { VIDEOS_QUEUE_NAME } from './videos-queue.constants';
import { VideosQueueProducer } from './videos-queue.producer';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.host,
          port: cfg.port,
          ...(cfg.password ? { password: cfg.password } : {}),
        },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEOS_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: false,
      },
    }),
  ],
  providers: [VideosQueueProducer],
  exports: [BullModule, VideosQueueProducer],
})
export class QueueModule {}
