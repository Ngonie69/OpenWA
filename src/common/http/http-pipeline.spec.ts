import { Body, Controller, Get, Post } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import configuration from '../../config/configuration';
import { EngineNotReadyError } from '../../engine/errors/engine-not-ready.error';
import { applyHttpPipeline, DEFAULT_REQUEST_BODY_LIMIT, requestBodyLimit } from './http-pipeline';

@Controller('probe')
class ProbeController {
  @Post('json')
  json(@Body() body: { data: string }) {
    return { length: body.data.length };
  }

  @Post('form')
  form(@Body() body: { data: string }) {
    return { length: body.data.length };
  }

  @Get('not-ready')
  notReady(): never {
    throw new EngineNotReadyError();
  }

  @Get('broken')
  broken(): never {
    throw new Error('Something else went wrong');
  }
}

/** The app as main.ts builds it, or as Nest builds it by default when withPipeline is false. */
async function createApp(withPipeline: boolean): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>(withPipeline ? { bodyParser: false } : {});
  if (withPipeline) {
    applyHttpPipeline(app, { bodyLimit: DEFAULT_REQUEST_BODY_LIMIT });
  }
  await app.init();
  return app;
}

// About what an invoice PDF weighs in base64: its logo alone is 117 KB before base64 adds a third.
const INVOICE_SIZED = 'A'.repeat(600 * 1024);

describe('applyHttpPipeline', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('request body limit', () => {
    it('refuses an invoice-sized JSON body with the default parsers (the control)', async () => {
      app = await createApp(false);

      await request(app.getHttpServer()).post('/probe/json').send({ data: INVOICE_SIZED }).expect(413);
    });

    it('accepts an invoice-sized JSON body', async () => {
      app = await createApp(true);

      const response = await request(app.getHttpServer()).post('/probe/json').send({ data: INVOICE_SIZED }).expect(201);

      expect(response.body).toEqual({ length: INVOICE_SIZED.length });
    });

    it('accepts an invoice-sized form body', async () => {
      app = await createApp(true);

      const response = await request(app.getHttpServer())
        .post('/probe/form')
        .type('form')
        .send({ data: INVOICE_SIZED })
        .expect(201);

      expect(response.body).toEqual({ length: INVOICE_SIZED.length });
    });

    it('still refuses a body over the limit, with 413', async () => {
      app = await createApp(true);

      await request(app.getHttpServer())
        .post('/probe/json')
        .send({ data: 'A'.repeat(17 * 1024 * 1024) })
        .expect(413);
    });
  });

  describe('a session that is not ready', () => {
    it('answers 503 with the reason', async () => {
      app = await createApp(true);

      const response = await request(app.getHttpServer()).get('/probe/not-ready').expect(503);

      expect(response.body).toEqual({
        statusCode: 503,
        message: 'WhatsApp client is not ready',
        error: 'Service Unavailable',
      });
    });

    it('leaves every other error as it was', async () => {
      app = await createApp(true);

      const response = await request(app.getHttpServer()).get('/probe/broken').expect(500);

      expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });
  });
});

describe('requestBodyLimit', () => {
  it('is 16mb when API_BODY_LIMIT is not set', () => {
    expect(requestBodyLimit({})).toBe('16mb');
  });

  it('is 16mb when API_BODY_LIMIT is blank', () => {
    expect(requestBodyLimit({ API_BODY_LIMIT: '  ' })).toBe('16mb');
  });

  it('takes API_BODY_LIMIT as written, trimmed', () => {
    expect(requestBodyLimit({ API_BODY_LIMIT: ' 32mb ' })).toBe('32mb');
  });

  it('reaches the configuration main.ts reads', () => {
    const previous = process.env.API_BODY_LIMIT;
    process.env.API_BODY_LIMIT = '4mb';
    try {
      expect(configuration().api.bodyLimit).toBe('4mb');
    } finally {
      if (previous === undefined) {
        delete process.env.API_BODY_LIMIT;
      } else {
        process.env.API_BODY_LIMIT = previous;
      }
    }
  });
});
