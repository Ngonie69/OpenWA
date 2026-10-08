import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { applyHttpPipeline, DEFAULT_REQUEST_BODY_LIMIT } from '../../common/http/http-pipeline';
import { HookManager } from '../../core/hooks';
import { EngineNotReadyError } from '../../engine/errors/engine-not-ready.error';
import { SessionService } from '../session/session.service';
import { BulkMessageService } from './bulk-message.service';
import { Message, MessageStatus } from './entities/message.entity';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';

/**
 * The route ShopInventory sends invoices through, with the real controller, service and validation and
 * a stubbed engine and repository: what a request of an invoice's size meets on its way to WhatsApp.
 */
describe('POST sessions/:sessionId/messages/send-document', () => {
  let app: NestExpressApplication | undefined;
  let engine: { sendDocumentMessage: jest.Mock };
  let saved: Message[];

  // An invoice PDF in base64 is about this size; Express's default limit is 100kb.
  const invoice = {
    chatId: '263771234567@c.us',
    base64: 'A'.repeat(600 * 1024),
    mimetype: 'application/pdf',
    filename: 'Kefalos-Invoice-1048211.pdf',
    caption: 'Good day. Please find attached Kefalos tax invoice 1048211.',
  };

  beforeEach(async () => {
    engine = { sendDocumentMessage: jest.fn().mockResolvedValue({ id: 'wa-msg-1', timestamp: 1706868000 }) };
    saved = [];

    const moduleRef = await Test.createTestingModule({
      controllers: [MessageController],
      providers: [
        MessageService,
        {
          provide: getRepositoryToken(Message, 'data'),
          useValue: {
            create: jest.fn().mockImplementation((data: Partial<Message>) => ({ id: 'msg-1', ...data }) as Message),
            save: jest.fn().mockImplementation((message: Message) => {
              saved.push({ ...message });
              return Promise.resolve(message);
            }),
          },
        },
        {
          provide: SessionService,
          useValue: {
            getEngine: jest.fn().mockReturnValue(engine),
            findOne: jest.fn().mockResolvedValue({ id: 's1', phone: '263771000002' }),
          },
        },
        { provide: HookManager, useValue: { execute: jest.fn() } },
        { provide: BulkMessageService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    applyHttpPipeline(app, { bodyLimit: DEFAULT_REQUEST_BODY_LIMIT });
    // As main.ts configures it, so the DTO is validated the way production validates it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('sends an invoice-sized document', async () => {
    const response = await request(app!.getHttpServer())
      .post('/sessions/s1/messages/send-document')
      .send(invoice)
      .expect(201);

    expect(response.body).toEqual({ messageId: 'wa-msg-1', timestamp: 1706868000 });
    expect(engine.sendDocumentMessage).toHaveBeenCalledWith(
      invoice.chatId,
      expect.objectContaining({ data: invoice.base64, filename: invoice.filename }),
    );
  });

  it('refuses a body over the limit with 413, before it reaches WhatsApp or the message log', async () => {
    await request(app!.getHttpServer())
      .post('/sessions/s1/messages/send-document')
      .send({ ...invoice, base64: 'A'.repeat(17 * 1024 * 1024) })
      .expect(413);

    expect(engine.sendDocumentMessage).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('answers 503 when the client is not ready, and logs the message as failed', async () => {
    engine.sendDocumentMessage.mockRejectedValue(new EngineNotReadyError());

    await request(app!.getHttpServer()).post('/sessions/s1/messages/send-document').send(invoice).expect(503);

    expect(saved.map(message => message.status)).toEqual([MessageStatus.PENDING, MessageStatus.FAILED]);
  });
});
