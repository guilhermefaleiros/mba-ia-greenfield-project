import { ArgumentsHost } from '@nestjs/common';
import { DomainExceptionFilter } from './domain-exception.filter';
import {
  EmailAlreadyExistsException,
  EmailNotConfirmedException,
  InvalidCredentialsException,
  InvalidTokenException,
  TokenExpiredException,
  TokenReuseDetectedException,
} from '../exceptions/domain.exception';

interface DomainErrorResponse {
  statusCode: number;
  error: string;
  message: string;
}

interface MockHttpResponse {
  json: (body: DomainErrorResponse) => void;
}

describe('DomainExceptionFilter', () => {
  let filter: DomainExceptionFilter;
  let mockJson: jest.MockedFunction<(body: DomainErrorResponse) => void>;
  let mockStatus: jest.MockedFunction<(statusCode: number) => MockHttpResponse>;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new DomainExceptionFilter();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    const rpcHost = {} as ReturnType<ArgumentsHost['switchToRpc']>;
    const wsHost = {} as ReturnType<ArgumentsHost['switchToWs']>;

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => rpcHost,
      switchToWs: () => wsHost,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('maps EmailAlreadyExistsException to 409 with EMAIL_ALREADY_EXISTS', () => {
    filter.catch(new EmailAlreadyExistsException(), mockHost);

    expect(mockStatus).toHaveBeenCalledWith(409);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'EMAIL_ALREADY_EXISTS',
      message: 'Email is already registered',
    });
  });

  it('maps InvalidCredentialsException to 401 with INVALID_CREDENTIALS', () => {
    const exception = new InvalidCredentialsException();

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_CREDENTIALS',
      message: exception.message,
    });
  });

  it('maps EmailNotConfirmedException to 403 with EMAIL_NOT_CONFIRMED', () => {
    const exception = new EmailNotConfirmedException();

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(403);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 403,
      error: 'EMAIL_NOT_CONFIRMED',
      message: exception.message,
    });
  });

  it('maps InvalidTokenException to 401 with INVALID_TOKEN', () => {
    const exception = new InvalidTokenException();

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'INVALID_TOKEN',
      message: exception.message,
    });
  });

  it('maps TokenExpiredException to 401 with TOKEN_EXPIRED', () => {
    const exception = new TokenExpiredException();

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_EXPIRED',
      message: exception.message,
    });
  });

  it('maps TokenReuseDetectedException to 401 with TOKEN_REUSE_DETECTED', () => {
    const exception = new TokenReuseDetectedException();

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(401);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 401,
      error: 'TOKEN_REUSE_DETECTED',
      message: exception.message,
    });
  });
});
