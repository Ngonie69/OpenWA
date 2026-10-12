import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import * as path from 'path';
import { keepAliveOnUnhandledRejection, logUnhandledRejection } from './unhandled-rejection';

interface LogEntry {
  level: string;
  context: string;
  message: string;
  action?: string;
  trace?: string;
}

function loggedEntries(spy: jest.SpyInstance): LogEntry[] {
  return (spy.mock.calls as string[][]).map(call => JSON.parse(call[0]) as LogEntry);
}

/**
 * Runs a script in a Node process of its own and reports how that process ended. Jest listens for
 * unhandled rejections itself, so what Node does with one can only be seen from outside.
 */
function runInOwnProcess(script: string) {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const INSTALL = `require('./src/common/process/unhandled-rejection').keepAliveOnUnhandledRejection();`;
const REJECT = `Promise.reject(new Error('Protocol error (Network.getResponseBody): Target closed'));`;
const STILL_RUNNING = `setTimeout(() => console.log('still running'), 200);`;

describe('logUnhandledRejection', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs an error with its name, message and stack', () => {
    const reason = new TypeError('Target closed');

    logUnhandledRejection(reason);

    const [entry] = loggedEntries(errorSpy);
    expect(entry.level).toBe('error');
    expect(entry.context).toBe('Process');
    expect(entry.message).toBe('Unhandled promise rejection: TypeError: Target closed');
    expect(entry.action).toBe('unhandled_rejection');
    expect(entry.trace).toBe(reason.stack);
  });

  it.each([
    ['a string', 'browser went away', 'browser went away'],
    ['an object', { code: 7 }, '{"code":7}'],
    ['nothing', undefined, 'undefined'],
  ])('logs a rejection with %s', (_name, reason, expected) => {
    logUnhandledRejection(reason);

    expect(loggedEntries(errorSpy)[0].message).toBe(`Unhandled promise rejection: ${expected}`);
  });

  it('does not throw for a reason that cannot be described', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logUnhandledRejection(circular)).not.toThrow();
    expect(loggedEntries(errorSpy)[0].message).toBe('Unhandled promise rejection: a value that could not be described');
  });

  it('does not throw when the log itself fails', () => {
    errorSpy.mockImplementationOnce(() => {
      throw new Error('stderr is closed');
    });

    expect(() => logUnhandledRejection(new Error('Target closed'))).not.toThrow();
  });
});

describe('keepAliveOnUnhandledRejection', () => {
  it('listens for unhandled rejections and leaves uncaught exceptions alone', () => {
    const source = new EventEmitter();

    keepAliveOnUnhandledRejection(source as unknown as NodeJS.Process);

    expect(source.listeners('unhandledRejection')).toEqual([logUnhandledRejection]);
    expect(source.listenerCount('uncaughtException')).toBe(0);
  });

  it('ends the process on an unhandled rejection when it is not installed', () => {
    const run = runInOwnProcess(`${REJECT} ${STILL_RUNNING}`);

    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('still running');
  }, 90_000);

  it('keeps the process running after an unhandled rejection, and logs it', () => {
    const run = runInOwnProcess(`${INSTALL} ${REJECT} ${STILL_RUNNING}`);

    expect(run.stdout).toContain('still running');
    expect(run.status).toBe(0);
    const entry = JSON.parse(run.stderr.trim()) as LogEntry;
    expect(entry.message).toBe(
      'Unhandled promise rejection: Error: Protocol error (Network.getResponseBody): Target closed',
    );
    expect(entry.trace).toContain('Target closed');
  }, 90_000);

  it('still ends the process on an uncaught exception', () => {
    const run = runInOwnProcess(
      `${INSTALL} setTimeout(() => { throw new Error('not a rejection'); }, 10); ${STILL_RUNNING}`,
    );

    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('still running');
    expect(run.stderr).toContain('not a rejection');
  }, 90_000);
});
