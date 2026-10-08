import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { Response } from 'express';
import { EngineNotReadyError } from './engine-not-ready.error';

/**
 * Answers an EngineNotReadyError with 503 and Nest's usual error body.
 *
 * It catches that one type only, so every other error keeps the response it had. It is registered
 * with app.useGlobalFilters (see applyHttpPipeline), which reaches HTTP routes and not the socket
 * gateways, so it never writes an HTTP response for a socket event.
 */
@Catch(EngineNotReadyError)
export class EngineNotReadyFilter implements ExceptionFilter<EngineNotReadyError> {
  catch(exception: EngineNotReadyError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .json(new ServiceUnavailableException(exception.message).getResponse());
  }
}
