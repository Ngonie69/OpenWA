import { EngineNotReadyError } from '../errors/engine-not-ready.error';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

describe('WhatsAppWebJsAdapter before its client is ready', () => {
  // Never initialized, so it has no client and is not READY: the state a session is in while it starts,
  // waits for its QR code, or reconnects.
  const adapter = new WhatsAppWebJsAdapter({ sessionId: 'not-started', sessionDataPath: './data/test-sessions' });

  it.each([
    ['sendTextMessage', () => adapter.sendTextMessage('263771234567@c.us', 'Hello')],
    [
      'sendDocumentMessage',
      () =>
        adapter.sendDocumentMessage('263771234567@c.us', {
          mimetype: 'application/pdf',
          data: 'JVBERi0xLjQK',
          filename: 'Invoice.pdf',
        }),
    ],
    ['checkNumberExists', () => adapter.checkNumberExists('263771234567')],
  ])('%s refuses with EngineNotReadyError', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});
