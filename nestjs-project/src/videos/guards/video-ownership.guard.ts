import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UploadNotOwnedException } from '../../common/exceptions/domain.exception';
import { JwtPayload } from '../../auth/auth.types';
import { VideosRepository } from '../videos.repository';

@Injectable()
export class VideoOwnershipGuard implements CanActivate {
  constructor(private readonly videosRepository: VideosRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ params: Record<string, string>; user: JwtPayload }>();

    const user = request.user;
    if (!user || !user.channelId) {
      throw new UnauthorizedException();
    }

    const videoId = request.params['videoId'];
    if (!videoId) {
      throw new UnauthorizedException();
    }

    const video = await this.videosRepository.findByIdForOwner(
      videoId,
      user.channelId,
    );
    if (!video) {
      throw new UploadNotOwnedException();
    }
    return true;
  }
}
