export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UploadNotOwnedException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_OWNED', 403, 'You do not own this video');
  }
}

export class UploadNotActiveException extends DomainException {
  constructor() {
    super('UPLOAD_NOT_ACTIVE', 409, 'Video is not in aguardando_upload state');
  }
}

export class UploadCompleteFailedException extends DomainException {
  constructor(message = 'S3 CompleteMultipartUpload rejected the part list') {
    super('UPLOAD_COMPLETE_FAILED', 422, message);
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_READY',
      409,
      'Video is not ready for streaming or download',
    );
  }
}

export class StreamRangeInvalidException extends DomainException {
  constructor(message = 'Range header is malformed or out of bounds') {
    super('STREAM_RANGE_INVALID', 416, message);
  }
}
