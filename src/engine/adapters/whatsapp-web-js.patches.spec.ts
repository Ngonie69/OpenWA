import { readFileSync } from 'fs';
import { join } from 'path';
import type { Message } from 'whatsapp-web.js';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

// What patches/whatsapp-web.js+1.34.7.patch must have left in the installed library. These read the
// files npm installed, so they fail after an install that skipped or lost the patch. See patches/README.md
// for when to drop it.
const wwebjsRoot = join(require.resolve('whatsapp-web.js/package.json'), '..');
const installed = (relativePath: string): string => readFileSync(join(wwebjsRoot, relativePath), 'utf8');

// The library's own Message class. Its typings declare Message as an interface only.
type MessageClass = new (client: unknown, data: Record<string, unknown>) => Message;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const WwebjsMessage = (require('whatsapp-web.js') as { Message: MessageClass }).Message;

// A message key as current WhatsApp Web serializes it: the joined id is in `$1`, and there is no
// `_serialized`. Checked against web.whatsapp.com on 2026-10-16: WAWebMsgKey sets
// `this.$1 = [fromMe, remote, id].join("_")` and its toString() returns this.$1.
const chatId = '263771234567@c.us';
const keyOnlyInDollarOne = {
  fromMe: true,
  remote: chatId,
  id: '3EB0C1A2B3C4D5E6F7A8',
  $1: `true_${chatId}_3EB0C1A2B3C4D5E6F7A8`,
};

describe('patched whatsapp-web.js', () => {
  describe('#201923: media sends drop the private __x_id', () => {
    const utils = installed('src/util/Injected/Utils.js');

    it('deletes __x_id from the outgoing message before the bot options are applied', () => {
      const deletion = utils.indexOf('delete message.__x_id;');
      const botComment = utils.indexOf("// Bot's won't reply if canonicalUrl is set (linking)");

      expect(deletion).toBeGreaterThan(-1);
      expect(botComment).toBeGreaterThan(deletion);
      // Nothing but the closing brace between them: the delete sits directly above that comment.
      expect(utils.slice(deletion, botComment).replace(/\s/g, '')).toBe('deletemessage.__x_id;}');
    });
  });

  describe('#201832: message ids that WhatsApp Web keeps in $1', () => {
    it('looks a sent message up by $1 when the key has no _serialized', () => {
      // Not toContain: a failure would print the whole of Utils.js.
      expect(installed('src/util/Injected/Utils.js').includes('.Msg.get(newMsgKey._serialized || newMsgKey.$1)')).toBe(
        true,
      );
    });

    it('fills _serialized from $1 on a received or sent Message', () => {
      const message = new WwebjsMessage({}, { id: { ...keyOnlyInDollarOne }, from: chatId, to: chatId });

      expect(message.id._serialized).toBe(keyOnlyInDollarOne.$1);
    });

    it('reads from and to from $1 when WhatsApp sends them as ids', () => {
      const wid = { server: 'c.us', user: '263771234567', $1: chatId };
      const message = new WwebjsMessage({}, { id: { ...keyOnlyInDollarOne }, from: wid, to: wid });

      expect(message.from).toBe(chatId);
      expect(message.to).toBe(chatId);
    });
  });
});

describe('WhatsAppWebJsAdapter send results', () => {
  function readyAdapter(sendMessage: jest.Mock): WhatsAppWebJsAdapter {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 'send-result', sessionDataPath: './data/test-sessions' });
    // Stands in for a paired client: only sendMessage is reached by a document send.
    Object.assign(adapter as unknown as { client: unknown; status: EngineStatus }, {
      client: { sendMessage },
      status: EngineStatus.READY,
    });
    return adapter;
  }

  const document = { mimetype: 'application/pdf', data: 'JVBERi0xLjQK', filename: 'Invoice.pdf' };

  it('answers a document send with the WhatsApp message id', async () => {
    // What the patched library hands back: its own Message, built from the browser's model.
    const sent = new WwebjsMessage({}, { id: { ...keyOnlyInDollarOne }, t: 1760000000 });
    const adapter = readyAdapter(jest.fn().mockResolvedValue(sent));

    await expect(adapter.sendDocumentMessage(chatId, document)).resolves.toEqual({
      id: keyOnlyInDollarOne.$1,
      timestamp: 1760000000,
    });
  });

  it('reports a sent message without an id as unconfirmed, not as an undefined id', async () => {
    const sent = new WwebjsMessage({}, { id: { fromMe: true, remote: chatId, id: 'X' }, t: 1760000000 });
    const adapter = readyAdapter(jest.fn().mockResolvedValue(sent));

    await expect(adapter.sendDocumentMessage(chatId, document)).resolves.toEqual({
      id: null,
      timestamp: 1760000000,
      unconfirmed: true,
    });
  });

  it('reports a send that returned nothing as unconfirmed', async () => {
    const adapter = readyAdapter(jest.fn().mockResolvedValue(undefined));

    await expect(adapter.sendDocumentMessage(chatId, document)).resolves.toMatchObject({
      id: null,
      unconfirmed: true,
    });
  });
});
