import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../../config/queue.config';
import { QueueModule } from './videos-queue.module';
import { VideosQueueProducer } from './videos-queue.producer';

describe('QueueModule', () => {
  it('should compile with BullModule.forRootAsync, registerQueue, and VideosQueueProducer', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ load: [queueConfig], isGlobal: true }),
        QueueModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    const producer = module.get(VideosQueueProducer);
    expect(producer).toBeInstanceOf(VideosQueueProducer);
    await module.close();
  }, 30000);
});
