import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './exception.filter';
import { AppException } from './app-exception';
import { ErrorCode } from './error-codes';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();

    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockResponse = { status: mockStatus, json: mockJson };

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: jest.fn(),
        getNext: jest.fn()
      }),
      getArgs: jest.fn(),
      getArgByIndex: jest.fn(),
      switchToRpc: jest.fn(),
      switchToWs: jest.fn(),
      getType: jest.fn()
    } as unknown as ArgumentsHost;
  });

  // ===========================================================================
  // AppException
  // ===========================================================================
  it('handles AppException correctly', () => {
    const exception = new AppException(ErrorCode.RUN_NOT_FOUND, 'Run not found', HttpStatus.NOT_FOUND);

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: HttpStatus.NOT_FOUND,
      errorCode: ErrorCode.RUN_NOT_FOUND,
      message: 'Run not found'
    });
  });

  it('handles AppException with metadata', () => {
    const exception = new AppException(ErrorCode.VALIDATION_ERROR, 'Invalid payload', HttpStatus.BAD_REQUEST, {
      field: 'name'
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: ErrorCode.VALIDATION_ERROR,
      message: 'Invalid payload',
      metadata: { field: 'name' }
    });
  });

  // ===========================================================================
  // HttpException with object body
  // ===========================================================================
  it('handles HttpException with object body', () => {
    const body = {
      statusCode: HttpStatus.FORBIDDEN,
      message: 'Forbidden resource',
      error: 'Forbidden'
    };
    const exception = new HttpException(body, HttpStatus.FORBIDDEN);

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(mockJson).toHaveBeenCalledWith(body);
  });

  // ===========================================================================
  // HttpException with string body
  // ===========================================================================
  it('handles HttpException with string body', () => {
    const exception = new HttpException('Something went wrong', HttpStatus.BAD_REQUEST);

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Something went wrong'
    });
  });

  // ===========================================================================
  // Unknown error (plain Error)
  // ===========================================================================
  it('handles unknown error (plain Error)', () => {
    const error = new Error('Something blew up');

    filter.catch(error, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error'
    });
  });

  // ===========================================================================
  // Non-Error unknown (e.g., thrown string)
  // ===========================================================================
  it('handles non-Error unknown thrown value', () => {
    const thrown = 'random string thrown';

    filter.catch(thrown, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error'
    });
  });

  it('handles null thrown value', () => {
    filter.catch(null, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      errorCode: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error'
    });
  });
});
