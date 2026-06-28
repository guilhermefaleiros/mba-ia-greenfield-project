import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { VIDEOS_QUEUE_NAME } from '../videos/queue/videos-queue.constants';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'error', 'warn'],
  });
  await app.init();
  logger.log(`Worker started, listening on queue '${VIDEOS_QUEUE_NAME}'`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}, shutting down...`);
    try {
      await app.close();
    } catch (err) {
      logger.error(
        `Error during shutdown: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap();
