import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { VideoOwnershipGuard } from './guards/video-ownership.guard';
import { QueueModule } from './queue/videos-queue.module';
import { StorageModule } from './storage/storage.module';
import { VideosController } from './videos.controller';
import { VideosRepository } from './videos.repository';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    StorageModule,
    QueueModule,
    AuthModule,
  ],
  controllers: [VideosController],
  providers: [VideosRepository, VideosService, VideoOwnershipGuard],
  exports: [VideosRepository, VideosService, StorageModule, QueueModule],
})
export class VideosModule {}
