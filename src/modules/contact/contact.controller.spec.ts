import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { applyHttpPipeline, DEFAULT_REQUEST_BODY_LIMIT } from '../../common/http/http-pipeline';
import { EngineNotReadyError } from '../../engine/errors/engine-not-ready.error';
import { SessionService } from '../session/session.service';
import { ContactController } from './contact.controller';

describe('GET sessions/:sessionId/contacts/check/:number', () => {
  let app: NestExpressApplication | undefined;

  async function createApp(engine: unknown): Promise<NestExpressApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [ContactController],
      providers: [{ provide: SessionService, useValue: { getEngine: jest.fn().mockReturnValue(engine) } }],
    }).compile();

    const created = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    applyHttpPipeline(created, { bodyLimit: DEFAULT_REQUEST_BODY_LIMIT });
    await created.init();
    return created;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('answers 503 when the session is not started', async () => {
    app = await createApp(undefined);

    const response = await request(app.getHttpServer()).get('/sessions/s1/contacts/check/263771234567').expect(503);

    expect((response.body as { message: string }).message).toBe('Session is not started');
  });

  it('answers 503 when the session has started but its client is not ready', async () => {
    app = await createApp({ checkNumberExists: jest.fn().mockRejectedValue(new EngineNotReadyError()) });

    const response = await request(app.getHttpServer()).get('/sessions/s1/contacts/check/263771234567').expect(503);

    expect((response.body as { message: string }).message).toBe('WhatsApp client is not ready');
  });

  it('answers the check once the client is ready', async () => {
    app = await createApp({ checkNumberExists: jest.fn().mockResolvedValue(true) });

    const response = await request(app.getHttpServer()).get('/sessions/s1/contacts/check/263771234567').expect(200);

    expect(response.body).toEqual({ number: '263771234567', exists: true, whatsappId: '263771234567@c.us' });
  });
});
