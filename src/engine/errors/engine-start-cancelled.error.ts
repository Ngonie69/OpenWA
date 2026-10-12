/**
 * The engine was disconnected or destroyed while it was still starting.
 *
 * The start has not failed: whoever overtook it (a stop, a delete, the ready watchdog) is tearing the
 * engine down and decides what happens to the session next. So the start ends at once with this,
 * instead of running on in a browser that nothing holds any more, and whoever waits on it does not
 * tear the engine down a second time or schedule a retry.
 */
export class EngineStartCancelledError extends Error {
  constructor(message = 'The engine was disconnected while it was starting') {
    super(message);
    this.name = 'EngineStartCancelledError';
  }
}
