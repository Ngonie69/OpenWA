/**
 * The session's WhatsApp client cannot take a command yet: it is still starting, waiting for its QR
 * code to be scanned, or reconnecting.
 *
 * That passes on its own, so it answers 503 (see EngineNotReadyFilter) instead of the 500 a plain
 * Error became. A caller can then tell "try again shortly" from "this request is broken", and one that
 * backs off on 503 does not give up on a message that would have gone a minute later.
 */
export class EngineNotReadyError extends Error {
  constructor(message = 'WhatsApp client is not ready') {
    super(message);
    this.name = 'EngineNotReadyError';
  }
}
