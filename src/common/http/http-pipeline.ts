import { NestExpressApplication } from '@nestjs/platform-express';
import { EngineNotReadyFilter } from '../../engine/errors/engine-not-ready.filter';

/**
 * The largest request body the API accepts unless API_BODY_LIMIT says otherwise.
 *
 * Express's own default is 100kb, which refuses a document sent as base64 long before WhatsApp
 * would: base64 adds a third to the file, and a one-page PDF with a logo is already over the limit.
 * 16mb of JSON carries a file of about 12 MB.
 */
export const DEFAULT_REQUEST_BODY_LIMIT = '16mb';

/** API_BODY_LIMIT as body-parser reads it ('16mb', '500kb', or a number of bytes), or the default. */
export function requestBodyLimit(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.API_BODY_LIMIT?.trim();
  return configured ? configured : DEFAULT_REQUEST_BODY_LIMIT;
}

/**
 * What every request passes through before a controller sees it: the body parsers with the
 * configured limit, and the 503 for a session whose client is not ready.
 *
 * The application must be created with bodyParser: false, so these are its only parsers. main.ts
 * and the tests both go through this, so the tests exercise what production runs.
 */
export function applyHttpPipeline(app: NestExpressApplication, options: { bodyLimit: string }): void {
  app.useBodyParser('json', { limit: options.bodyLimit });
  app.useBodyParser('urlencoded', { extended: true, limit: options.bodyLimit });
  app.useGlobalFilters(new EngineNotReadyFilter());
}
