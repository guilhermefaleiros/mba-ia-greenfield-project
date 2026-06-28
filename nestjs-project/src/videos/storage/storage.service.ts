import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CompletedPart,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import storageConfig from '../../config/storage.config';

export interface CreateMultipartUploadResult {
  uploadId: string;
}

export interface PresignPartUrlResult {
  url: string;
  expiresAt: Date;
}

export type MultipartPartInput = {
  partNumber: number;
  etag: string;
};

export interface GetObjectStreamResult {
  body: Readable;
  contentLength: number;
  contentRange?: string;
  contentType: string;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
      forcePathStyle: this.config.forcePathStyle,
    });
    this.bucket = this.config.bucket;
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<CreateMultipartUploadResult> {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!out.UploadId) {
      throw new Error('S3 did not return an UploadId');
    }
    return { uploadId: out.UploadId };
  }

  async presignPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 3600,
  ): Promise<PresignPartUrlResult> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
    });
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    return { url, expiresAt };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPartInput[],
  ): Promise<void> {
    const completedParts: CompletedPart[] = parts.map((p) => ({
      ETag: p.etag,
      PartNumber: p.partNumber,
    }));
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: completedParts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async getObjectStream(
    key: string,
    rangeHeader?: string,
  ): Promise<GetObjectStreamResult> {
    const out = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      }),
    );
    if (!out.Body) {
      throw new Error('S3 GetObject returned no body');
    }
    return {
      body: out.Body as Readable,
      contentLength: out.ContentLength ?? 0,
      contentRange: out.ContentRange,
      contentType: out.ContentType ?? 'application/octet-stream',
    };
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
