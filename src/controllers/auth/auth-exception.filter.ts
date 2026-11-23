import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { AccessTokenError } from '../../infra/auth/access-token.error';

/** Exact 401 body, identical for every rejected token (contracts/rest-auth.md). */
const UNAUTHORIZED_BODY = { statusCode: HttpStatus.UNAUTHORIZED, message: 'Unauthorized' };

/** Exact 503 body when Identity's keys cannot be loaded. */
const UNAVAILABLE_BODY = {
  statusCode: HttpStatus.SERVICE_UNAVAILABLE,
  message: 'Service Unavailable',
};

/**
 * Answers {@link AccessTokenError} on REST (research R9): `INVALID` → 401 with
 * `WWW-Authenticate: Bearer`, `KEYS_UNAVAILABLE` → 503, both with fixed bodies so no failure can
 * be told apart from another. Logs the category only, never the token.
 */
@Catch(AccessTokenError)
export class AuthExceptionFilter implements ExceptionFilter<AccessTokenError> {
  private readonly logger = new Logger(AuthExceptionFilter.name);

  /** Writes the fixed answer for an HTTP request; rethrows for other transports. */
  catch(error: AccessTokenError, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw error;
    }
    this.logger.warn(`Rejected request: ${error.category}`);
    const response = host.switchToHttp().getResponse<Response>();
    if (error.kind === 'KEYS_UNAVAILABLE') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json(UNAVAILABLE_BODY);
      return;
    }
    response
      .status(HttpStatus.UNAUTHORIZED)
      .setHeader('WWW-Authenticate', 'Bearer')
      .json(UNAUTHORIZED_BODY);
  }
}
