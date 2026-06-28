import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

export class UploadPartUrlDto {
  @ApiProperty({ minimum: 1, maximum: 10000, example: 1 })
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber: number;
}
