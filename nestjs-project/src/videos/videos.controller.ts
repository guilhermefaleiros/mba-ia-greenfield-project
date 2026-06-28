import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideoNotReadyException } from '../common/exceptions/domain.exception';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import {
  UploadCompleteDto,
  UploadCompletePartDto,
} from './dto/upload-complete.dto';
import { UploadInitDto } from './dto/upload-init.dto';
import { UploadPartUrlDto } from './dto/upload-part-url.dto';
import { Video, VIDEO_STATUS } from './entities/video.entity';
import { VideoOwnershipGuard } from './guards/video-ownership.guard';
import { parseRangeHeader } from './streaming/range-parser.util';
import { VideosService } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@ApiExtraModels(
  UploadInitDto,
  UploadPartUrlDto,
  UploadCompleteDto,
  UploadCompletePartDto,
)
@Controller('videos')
@UseGuards(JwtAuthGuard)
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('upload-init')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Initialize a multipart upload',
    description:
      'Creates a draft video row in aguardando_upload state and starts a MinIO multipart upload. Returns the uploadId, bucket, key, and part size to use.',
  })
  @ApiBody({ type: UploadInitDto })
  @ApiResponse({
    status: 201,
    description: 'Multipart upload initialized',
    schema: {
      properties: {
        videoId: { type: 'string', example: 'V1StGXR8_Z5jdHi6B-myT' },
        uploadId: { type: 'string' },
        bucket: { type: 'string', example: 'streamtube-videos' },
        key: {
          type: 'string',
          example: 'videos/{channelId}/{videoId}/source.mp4',
        },
        partSize: { type: 'number', example: 5242880 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadInitDto,
  ): Promise<{
    videoId: string;
    uploadId: string;
    bucket: string;
    key: string;
    partSize: number;
  }> {
    return this.videosService.initUpload(user.channelId, dto);
  }

  @Post(':videoId/upload-part-url')
  @UseGuards(VideoOwnershipGuard)
  @ApiOperation({
    summary: 'Get a presigned PUT URL for one part of the multipart upload',
  })
  @ApiParam({ name: 'videoId', description: 'nanoid-21 video identifier' })
  @ApiBody({ type: UploadPartUrlDto })
  @ApiResponse({
    status: 200,
    description: 'Presigned URL issued',
    schema: {
      properties: {
        url: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in aguardando_upload state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getPartUrl(
    @Param('videoId') videoId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadPartUrlDto,
  ): Promise<{ url: string; expiresAt: Date }> {
    return this.videosService.getPresignedPartUrl(user.channelId, videoId, dto);
  }

  @Post(':videoId/upload-complete')
  @HttpCode(200)
  @UseGuards(VideoOwnershipGuard)
  @ApiOperation({
    summary: 'Finalize the multipart upload and enqueue the process-video job',
  })
  @ApiParam({ name: 'videoId', description: 'nanoid-21 video identifier' })
  @ApiBody({ type: UploadCompleteDto })
  @ApiResponse({
    status: 200,
    description: 'Multipart completed, job enqueued',
    schema: {
      properties: {
        videoId: { type: 'string' },
        status: { type: 'string', example: 'processando' },
        queuedJobId: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in aguardando_upload state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'S3 CompleteMultipartUpload rejected the part list',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @Param('videoId') videoId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadCompleteDto,
  ): Promise<{
    videoId: string;
    status: 'processando';
    queuedJobId: string;
  }> {
    return this.videosService.completeUpload(user.channelId, videoId, dto);
  }

  @Post(':videoId/upload-abort')
  @UseGuards(VideoOwnershipGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Abort the multipart upload and mark the video as erro',
  })
  @ApiParam({ name: 'videoId', description: 'nanoid-21 video identifier' })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Caller does not own the video',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in aguardando_upload state',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abort(
    @Param('videoId') videoId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    return this.videosService.abortUpload(user.channelId, videoId);
  }

  @Get(':videoId/stream')
  @Public()
  @ApiOperation({
    summary: 'Stream a video (Range/206)',
    description:
      'Proxies a byte range from the storage backend. Honors the Range header; returns 206 with Content-Range/Accept-Ranges. Anonymous in Phase 03.',
  })
  @ApiParam({ name: 'videoId', description: 'nanoid-21 video identifier' })
  @ApiResponse({ status: 206, description: 'Partial content (range)' })
  @ApiResponse({ status: 200, description: 'Full content (no range)' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for streaming',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 416,
    description: 'Range header malformed or out of bounds',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('videoId') videoId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.videosService.findByIdForStream(videoId);
    await this.pipeVideoStream(req, res, video, true);
  }

  @Get(':videoId/download')
  @ApiOperation({
    summary: 'Download the full source object',
    description:
      'Returns the full source with Content-Disposition: attachment.',
  })
  @ApiParam({ name: 'videoId', description: 'nanoid-21 video identifier' })
  @ApiResponse({ status: 200, description: 'Full object streamed' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for download',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('videoId') videoId: string,
    @Res() res: Response,
  ): Promise<void> {
    const video = await this.videosService.findByIdForStream(videoId);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${videoId}.mp4"`,
    );
    await this.pipeVideoStream(null, res, video, false, videoId);
  }

  private async pipeVideoStream(
    req: Request | null,
    res: Response,
    video: Video,
    isStream: boolean,
    filenameForDownload?: string,
  ): Promise<void> {
    if (video.status !== VIDEO_STATUS.pronto) {
      throw new VideoNotReadyException();
    }
    if (!video.source_key || !video.size_bytes) {
      throw new VideoNotReadyException();
    }
    const totalSize = Number(video.size_bytes);
    const rangeHeader = req?.headers.range;
    const parsedRange =
      isStream && rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;
    const rangeHeaderToSend =
      parsedRange !== null
        ? `bytes=${parsedRange.start}-${parsedRange.end}`
        : rangeHeader;

    const streamRes = await this.videosService.getObjectStream(
      video.source_key,
      rangeHeaderToSend,
    );

    res.setHeader('Content-Type', streamRes.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    if (streamRes.contentRange) {
      res.setHeader('Content-Range', streamRes.contentRange);
    }
    res.setHeader('Content-Length', String(streamRes.contentLength));
    if (filenameForDownload) {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filenameForDownload}.mp4"`,
      );
    }
    res.status(streamRes.contentRange ? 206 : 200);
    await new Promise<void>((resolve, reject) => {
      streamRes.body.on('end', () => resolve());
      streamRes.body.on('error', reject);
      streamRes.body.pipe(res);
    });
  }
}
