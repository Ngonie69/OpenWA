import { randomUUID, createHash } from 'crypto';

/**
 * Safely convert an unknown value to a string for use in idempotency keys
 */
function toStr(value: unknown, fallback = 'unknown'): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * The first of the values that is a usable identifier. `toStr(a) || toStr(b)` never reached `b`:
 * `toStr` answers 'unknown' for a missing value, and 'unknown' is truthy.
 */
function firstStr(...values: unknown[]): string {
  for (const value of values) {
    const str = toStr(value, '');
    if (str) return str;
  }
  return 'unknown';
}

/**
 * A token for one occurrence of an event whose data recurs. A session goes `ready` again after
 * every reconnect, and it is a new transition each time; a content key gave the second one the
 * first one's key, and a receiver that remembers keys refused it as a conflicting duplicate.
 * Retries reuse the payload, key included, so they still share this token.
 */
function occurrence(): string {
  return Date.now().toString(36);
}

/**
 * Generate a short hash from data for use in idempotency keys.
 * Used when no unique identifier is available in the payload.
 */
function hashData(data: Record<string, unknown>): string {
  const str = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(str).digest('hex').substring(0, 12);
}

/**
 * Generate an idempotency key based on event type and data.
 * Same event with same data will produce the same key (deterministic).
 *
 * @remarks
 * Message keys are content-based and do NOT include timestamps, so a message dispatched twice
 * produces the same key for proper deduplication. They are scoped by session: two sessions in
 * one group see the same message id. Session lifecycle keys DO carry an occurrence token, because
 * the same status recurs as a new event. Retries reuse the payload, so they always share a key.
 */
export function generateIdempotencyKey(event: string, data: Record<string, unknown>): string {
  switch (event) {
    case 'message.received':
    case 'message.sent':
      // A message is dispatched with its id as `id` (IncomingMessage); `messageId` is accepted too
      return `msg_${toStr(data.sessionId)}_${firstStr(data.messageId, data.id)}`;

    case 'message.ack':
      // Message ID + ack status together are unique
      return `ack_${toStr(data.sessionId)}_${firstStr(data.messageId, data.id)}_${toStr(data.ack, '0')}`;

    case 'message.revoked':
      return `rev_${toStr(data.sessionId)}_${firstStr(data.messageId, data.id)}`;

    case 'session.status':
      // Session + status + occurrence: a session returns to a status it has had before
      return `sess_${toStr(data.sessionId)}_${toStr(data.status)}_${occurrence()}`;

    case 'session.qr':
      // QR changes each time, use the QR data hash for uniqueness
      return `qr_${toStr(data.sessionId)}_${hashData({ qr: data.qr })}`;

    case 'session.authenticated':
      // A session authenticates again after every re-pair
      return `auth_${toStr(data.sessionId)}_${hashData(data)}_${occurrence()}`;

    case 'session.disconnected':
      // The same reason recurs on every disconnect
      return `disc_${toStr(data.sessionId)}_${hashData({ reason: data.reason })}_${occurrence()}`;

    case 'group.join':
      return `grp_${toStr(data.groupId)}_${toStr(data.participantId)}_join`;

    case 'group.leave':
      return `grp_${toStr(data.groupId)}_${toStr(data.participantId)}_leave`;

    case 'group.update':
      // Include what changed for uniqueness
      return `grp_${toStr(data.groupId)}_update_${hashData(data)}`;

    default:
      // Fallback: hash entire payload for determinism
      return `evt_${event.replace(/\./g, '_')}_${hashData(data)}`;
  }
}

/**
 * Generate a unique delivery ID for each webhook delivery attempt
 */
export function generateDeliveryId(): string {
  return `dlv_${randomUUID()}`;
}
