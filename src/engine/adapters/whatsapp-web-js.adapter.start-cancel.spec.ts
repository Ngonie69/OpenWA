import { ChildProcess, spawn } from 'child_process';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineStartCancelledError } from '../errors/engine-start-cancelled.error';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

// Stands in for whatsapp-web.js while it starts. As in the library, the client holds no browser until
// Chrome is up, destroy closes the browser it holds and nothing when it holds none, and a start whose
// browser is closed under it rejects with whatever Puppeteer was doing at the time. The browser is a
// real process, so that closing it is proved against the operating system.
const fakeClient = {
  browserProcess: null as ChildProcess | null,
  failStart: null as ((error: unknown) => void) | null,
  finishStart: null as (() => void) | null,
};

jest.mock('whatsapp-web.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    initialize: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        fakeClient.finishStart = resolve;
        fakeClient.failStart = reject;
      }),
    destroy: async (): Promise<void> => {
      const browser = fakeClient.browserProcess;
      if (!browser) return;
      browser.kill('SIGKILL');
      await exited(browser);
      fakeClient.failStart?.(new Error('Navigating frame was detached'));
    },
    get pupBrowser() {
      return fakeClient.browserProcess ? { process: () => fakeClient.browserProcess } : undefined;
    },
  })),
  LocalAuth: jest.fn(),
  MessageMedia: jest.fn(),
}));

const LAUNCH_MS = 150;

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

describe('WhatsAppWebJsAdapter closed while it is still starting', () => {
  let launched: ChildProcess[];
  let launchTimer: NodeJS.Timeout | null;
  let statuses: EngineStatus[];
  let adapter: WhatsAppWebJsAdapter;

  /** Chrome comes up, and only then does the client hold it. */
  function launchBrowser(afterMs: number): void {
    launchTimer = setTimeout(() => {
      const browser = spawnStandInBrowser();
      launched.push(browser);
      fakeClient.browserProcess = browser;
    }, afterMs);
  }

  function start(browserLaunchWaitMs = 5000): Promise<void> {
    adapter = new WhatsAppWebJsAdapter({
      sessionId: 'start-cancel',
      sessionDataPath: './data/test-sessions',
      browserLaunchWaitMs,
    });
    return adapter.initialize({ onStateChanged: status => statuses.push(status) });
  }

  beforeEach(() => {
    launched = [];
    launchTimer = null;
    statuses = [];
    fakeClient.browserProcess = null;
    fakeClient.failStart = null;
    fakeClient.finishStart = null;
  });

  afterEach(async () => {
    if (launchTimer) clearTimeout(launchTimer);
    for (const browser of launched) {
      if (isRunning(browser)) browser.kill('SIGKILL');
      await exited(browser);
    }
    fakeClient.browserProcess = null;
  });

  describe.each(['disconnect', 'destroy'] as const)('by %s', close => {
    it('ends the start at once while Chrome is still launching, then closes Chrome when it is up', async () => {
      launchBrowser(LAUNCH_MS);
      const starting = start();
      const closing = adapter[close]();

      await expect(starting).rejects.toBeInstanceOf(EngineStartCancelledError);
      // The start did not wait for the browser it was launching
      expect(launched).toHaveLength(0);

      await closing;

      expect(launched).toHaveLength(1);
      expect(isRunning(launched[0])).toBe(false);
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      expect(statuses).not.toContain(EngineStatus.FAILED);
    }, 15000);

    it('ends the start while the page is loading in a browser the client holds', async () => {
      launchBrowser(0);
      const starting = start();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(launched).toHaveLength(1);

      const closing = adapter[close]();

      await expect(starting).rejects.toBeInstanceOf(EngineStartCancelledError);
      await closing;
      expect(isRunning(launched[0])).toBe(false);
      expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
      expect(statuses).not.toContain(EngineStatus.FAILED);
    }, 15000);
  });

  it('does not wait for a browser once the launch has failed', async () => {
    const starting = start();
    const startedAt = Date.now();
    const closing = adapter.disconnect();
    await expect(starting).rejects.toBeInstanceOf(EngineStartCancelledError);

    fakeClient.failStart?.(new Error('Failed to launch the browser process'));
    await closing;

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  }, 15000);

  it('gives up on a browser that never comes up', async () => {
    const starting = start(200);
    const startedAt = Date.now();
    const closing = adapter.disconnect();
    await expect(starting).rejects.toBeInstanceOf(EngineStartCancelledError);

    await closing;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  }, 15000);

  it('still reports a start that fails by itself, with the error it failed with', async () => {
    const starting = start();
    fakeClient.failStart?.('auth timeout');

    await expect(starting).rejects.toBe('auth timeout');
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
  });

  it('leaves a start that finishes alone, and a later disconnect closes its browser', async () => {
    launchBrowser(0);
    const starting = start();
    await new Promise(resolve => setTimeout(resolve, 50));
    fakeClient.finishStart?.();

    await expect(starting).resolves.toBeUndefined();
    expect(isRunning(launched[0])).toBe(true);

    await adapter.disconnect();

    expect(isRunning(launched[0])).toBe(false);
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  }, 15000);
});
