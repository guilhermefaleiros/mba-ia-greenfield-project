import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class UploadCompletePartDto {
  @ApiProperty({ minimum: 1, maximum: 10000, example: 1 })
  @IsInt()
  @Min(1)
  @Max(10000)
  partNumber: number;

  @ApiProperty({ example: '"d41d8cd98f00b204e9800998ecf8427e"' })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class UploadCompleteDto {
  @ApiProperty({ type: [UploadCompletePartDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UploadCompletePartDto)
  parts: UploadCompletePartDto[];
}
