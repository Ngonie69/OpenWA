import { createLogger } from '../services/logger.service';

/** The part of `process` this needs, so a test can hand in an emitter of its own. */
type RejectionSource = Pick<NodeJS.Process, 'on'>;

const logger = createLogger('Process');

function describe(reason: unknown): { message: string; trace?: string } {
  if (reason instanceof Error) {
    return { message: `${reason.name}: ${reason.message}`, trace: reason.stack };
  }

  try {
    return { message: typeof reason === 'string' ? reason : (JSON.stringify(reason) ?? String(reason)) };
  } catch {
    return { message: 'a value that could not be described' };
  }
}

/**
 * Logs a rejection nobody handled. It never throws: an error thrown from this handler would be an
 * uncaught exception, and end the process this exists to keep running.
 */
export function logUnhandledRejection(reason: unknown): void {
  try {
    const { message, trace } = describe(reason);
    logger.error(`Unhandled promise rejection: ${message}`, trace, { action: 'unhandled_rejection' });
  } catch {
    console.error('Unhandled promise rejection, and it could not be logged');
  }
}

/**
 * Keeps the gateway running when a promise is rejected with nobody waiting on it.
 *
 * Node ends the process on the first such rejection. whatsapp-web.js leaves them behind whenever a
 * browser closes under one of its page listeners: stopping a session while WhatsApp Web is still
 * loading rejects the library's read of the page body (`Network.getResponseBody: Target closed`),
 * and that took every other session down with it. The rejection is logged in full instead.
 *
 * Uncaught exceptions are left alone. After one of those the process is in an unknown state and
 * should end.
 */
export function keepAliveOnUnhandledRejection(source: RejectionSource = process): void {
  source.on('unhandledRejection', logUnhandledRejection);
}
