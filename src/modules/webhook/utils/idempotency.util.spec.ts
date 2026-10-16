import { generateIdempotencyKey, generateDeliveryId } from './idempotency.util';

describe('Idempotency Utils', () => {
  describe('generateIdempotencyKey', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should generate key for message.received', () => {
      const key = generateIdempotencyKey('message.received', { sessionId: 'sess_1', messageId: 'ABC123' });
      expect(key).toBe('msg_sess_1_ABC123');
    });

    it('should key message.received on the id an IncomingMessage carries', () => {
      // WebhookService.dispatch passes { ...IncomingMessage, sessionId }: the id is `id`, there is no `messageId`
      const first = generateIdempotencyKey('message.received', {
        sessionId: 'sess_1',
        id: 'false_263771234567@c.us_3EB0A1',
        from: '263771234567@c.us',
        body: 'First',
      });
      const second = generateIdempotencyKey('message.received', {
        sessionId: 'sess_1',
        id: 'false_263771234567@c.us_3EB0A2',
        from: '263771234567@c.us',
        body: 'Second',
      });

      expect(first).toBe('msg_sess_1_false_263771234567@c.us_3EB0A1');
      expect(second).not.toBe(first);
      expect(first).not.toContain('unknown');
    });

    it('should give the same message the same key on every dispatch', () => {
      const data = { sessionId: 'sess_1', id: 'false_263771234567@c.us_3EB0A1', body: 'Hello' };
      expect(generateIdempotencyKey('message.received', data)).toBe(
        generateIdempotencyKey('message.received', { ...data }),
      );
    });

    it('should scope message keys by session', () => {
      const id = 'false_120363000000000000@g.us_3EB0E1_263771234567@c.us';
      expect(generateIdempotencyKey('message.received', { sessionId: 'sess_1', id })).not.toBe(
        generateIdempotencyKey('message.received', { sessionId: 'sess_2', id }),
      );
    });

    it('should generate key for message.ack', () => {
      const key = generateIdempotencyKey('message.ack', { sessionId: 'sess_1', messageId: 'ABC123', ack: 3 });
      expect(key).toBe('ack_sess_1_ABC123_3');
    });

    it('should generate key for session.status', () => {
      jest.spyOn(Date, 'now').mockReturnValue(1760439600000);
      const key = generateIdempotencyKey('session.status', {
        sessionId: 'sess_1',
        status: 'CONNECTED',
      });
      expect(key).toBe(`sess_sess_1_CONNECTED_${(1760439600000).toString(36)}`);
    });

    it('should give a session returning to a status it had before a new key', () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1760439600000);
      const ready = generateIdempotencyKey('session.status', { sessionId: 'sess_1', status: 'ready' });
      now.mockReturnValue(1760439660000);
      const readyAgain = generateIdempotencyKey('session.status', { sessionId: 'sess_1', status: 'ready' });

      expect(readyAgain).not.toBe(ready);
    });

    it('should give a repeated disconnect with the same reason a new key', () => {
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1760439600000);
      const first = generateIdempotencyKey('session.disconnected', { sessionId: 'sess_1', reason: 'NAVIGATION' });
      now.mockReturnValue(1760439660000);
      const second = generateIdempotencyKey('session.disconnected', { sessionId: 'sess_1', reason: 'NAVIGATION' });

      expect(second).not.toBe(first);
    });

    it('should generate key for group.join', () => {
      const key = generateIdempotencyKey('group.join', {
        groupId: 'grp_1',
        participantId: 'user_1',
      });
      expect(key).toBe('grp_grp_1_user_1_join');
    });

    it('should generate fallback key for unknown events', () => {
      const key = generateIdempotencyKey('custom.event', {});
      expect(key).toMatch(/^evt_custom_event_[a-f0-9]{12}$/);
    });
  });

  describe('generateDeliveryId', () => {
    it('should generate unique delivery IDs', () => {
      const id1 = generateDeliveryId();
      const id2 = generateDeliveryId();

      expect(id1).toMatch(/^dlv_[a-f0-9-]{36}$/);
      expect(id2).toMatch(/^dlv_[a-f0-9-]{36}$/);
      expect(id1).not.toBe(id2);
    });
  });
});
