import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
] as const;

export class UploadInitDto {
  @ApiProperty({ required: false, maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiProperty({
    enum: ALLOWED_VIDEO_MIME_TYPES,
    example: 'video/mp4',
  })
  @IsIn(ALLOWED_VIDEO_MIME_TYPES as unknown as string[])
  mimeType: string;
}
