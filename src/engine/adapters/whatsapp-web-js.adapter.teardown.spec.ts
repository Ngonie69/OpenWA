import { ChildProcess, spawn } from 'child_process';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

// Stands in for whatsapp-web.js. Each test decides how the browser answers a close, and hands over a
// real process as the browser so that ending it is proved against the operating system.
const fakeClient = {
  destroy: jest.fn<Promise<void>, []>(),
  browserProcess: null as ChildProcess | null,
};

jest.mock('whatsapp-web.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: (): Promise<void> => fakeClient.destroy(),
    get pupBrowser() {
      return fakeClient.browserProcess ? { process: () => fakeClient.browserProcess } : undefined;
    },
  })),
  LocalAuth: jest.fn(),
  MessageMedia: jest.fn(),
}));

const CLOSE_TIMEOUT_MS = 200;

function spawnStandInBrowser(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function startedAdapter(): Promise<WhatsAppWebJsAdapter> {
  const adapter = new WhatsAppWebJsAdapter({
    sessionId: 'teardown',
    sessionDataPath: './data/test-sessions',
    browserCloseTimeoutMs: CLOSE_TIMEOUT_MS,
  });
  await adapter.initialize({});
  return adapter;
}

describe('WhatsAppWebJsAdapter closing its browser', () => {
  let browser: ChildProcess;

  beforeEach(() => {
    browser = spawnStandInBrowser();
    fakeClient.browserProcess = browser;
    fakeClient.destroy.mockReset();
  });

  afterEach(async () => {
    if (isRunning(browser)) {
      browser.kill('SIGKILL');
    }
    await exited(browser);
    fakeClient.browserProcess = null;
  });

  describe('when the browser never finishes closing', () => {
    beforeEach(() => {
      // What Puppeteer does: the close settles only once the browser's process has exited
      fakeClient.destroy.mockImplementation(() => exited(browser));
    });

    it('disconnect ends the process and returns', async () => {
      const adapter = await startedAdapter();
      const startedAt = Date.now();

      await adapter.disconnect();

      expect(isRunning(browser)).toBe(false);
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(CLOSE_TIMEOUT_MS - 20);
    }, 15000);

    it('destroy ends the process and returns', async () => {
      const adapter = await startedAdapter();

      await adapter.destroy();

      expect(isRunning(browser)).toBe(false);
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    }, 15000);

    it('a second disconnect while the first is waiting also returns', async () => {
      const adapter = await startedAdapter();

      await Promise.all([adapter.disconnect(), adapter.disconnect()]);

      expect(isRunning(browser)).toBe(false);
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    }, 15000);
  });

  describe('when the browser has no process to end', () => {
    it('disconnect still returns once the time is up', async () => {
      fakeClient.browserProcess = null;
      fakeClient.destroy.mockImplementation(() => new Promise<void>(() => {}));
      const adapter = await startedAdapter();

      await adapter.disconnect();

      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    }, 15000);
  });

  describe('when the browser closes in time', () => {
    it('disconnect leaves the process alone', async () => {
      fakeClient.destroy.mockResolvedValue(undefined);
      const adapter = await startedAdapter();

      await adapter.disconnect();

      expect(fakeClient.destroy).toHaveBeenCalledTimes(1);
      expect(isRunning(browser)).toBe(true);
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    });

    it('destroy still reports a close that failed', async () => {
      fakeClient.destroy.mockRejectedValue(new Error('Target closed'));
      const adapter = await startedAdapter();

      await expect(adapter.destroy()).rejects.toThrow('Target closed');
      expect(isRunning(browser)).toBe(true);
    });

    it('disconnect swallows a close that failed', async () => {
      fakeClient.destroy.mockRejectedValue(new Error('Target closed'));
      const adapter = await startedAdapter();

      await adapter.disconnect();

      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    });
  });
});
