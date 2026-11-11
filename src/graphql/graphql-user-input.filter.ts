import { BadRequestException, Catch } from '@nestjs/common';
import { GqlExceptionFilter } from '@nestjs/graphql';
import { UserInputError } from '@nestjs/apollo';
import { GraphQLError } from 'graphql';
import { ReadModelUnavailableError } from '../read-model/errors';

/** Message returned when the read model cannot be reached (no internal details). */
export const READ_MODEL_UNAVAILABLE_MESSAGE = 'Order data is temporarily unavailable, please retry';

/**
 * Maps errors at the GraphQL boundary (the GraphQL counterpart of mapping exceptions to HTTP status
 * codes in REST controllers):
 * - BadRequestException from the global ValidationPipe → `BAD_USER_INPUT` with the validation
 *   messages (by default @nestjs/apollo would report `BAD_REQUEST`);
 * - ReadModelUnavailableError → `SERVICE_UNAVAILABLE` with a generic message, never the cause.
 * Anything else is rethrown unchanged.
 */
@Catch(BadRequestException, ReadModelUnavailableError)
export class GraphQLUserInputFilter implements GqlExceptionFilter {
  catch(exception: unknown): never {
    if (exception instanceof BadRequestException) {
      const messages = validationMessages(exception);
      throw new UserInputError(messages.join('; '), {
        extensions: { validationErrors: messages },
      });
    }
    if (exception instanceof ReadModelUnavailableError) {
      throw new GraphQLError(READ_MODEL_UNAVAILABLE_MESSAGE, {
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
    }
    throw exception;
  }
}

function validationMessages(exception: BadRequestException): string[] {
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null) {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) {
      return message.map(String);
    }
    if (typeof message === 'string') {
      return [message];
    }
  }
  return [exception.message];
}
