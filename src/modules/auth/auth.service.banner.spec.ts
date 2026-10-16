import { Repository } from 'typeorm';
import { AuthService, bannerKey } from './auth.service';
import { ApiKey } from './entities/api-key.entity';

// The banner reads and writes data/.api-key; keep the tests off the disk.
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as { existsSync: jest.Mock; readFileSync: jest.Mock; writeFileSync: jest.Mock };

const realKey = `owa_k1_${'a1b2c3d4'.repeat(8)}`;

describe('AuthService startup banner', () => {
  const originalEnv = process.env.NODE_ENV;
  let logged: string;

  function service(existingKeys: number): AuthService {
    const repository = {
      count: jest.fn().mockResolvedValue(existingKeys),
      create: jest.fn((entity: Partial<ApiKey>) => entity),
      save: jest.fn((entity: Partial<ApiKey>) => Promise.resolve(entity)),
    };
    return new AuthService(repository as unknown as Repository<ApiKey>);
  }

  beforeEach(() => {
    logged = '';
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged += args.join(' ') + '\n';
    });
    jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      logged += args.join(' ') + '\n';
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.restoreAllMocks();
    fs.existsSync.mockReset();
    fs.readFileSync.mockReset();
    fs.writeFileSync.mockReset();
  });

  it('logs only the prefix of the key it reads from data/.api-key', async () => {
    process.env.NODE_ENV = 'production';
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(`${realKey}\n`);

    await service(1).onModuleInit();

    expect(logged).not.toContain(realKey);
    expect(logged).not.toContain(realKey.substring(12));
    expect(logged).toContain('owa_k1_a1b2c…');
    expect(logged).toContain('.api-key');
  });

  it('logs only the prefix of a key it has just minted, and still saves it whole', async () => {
    process.env.NODE_ENV = 'production';

    await service(0).onModuleInit();

    const minted = (fs.writeFileSync.mock.calls as unknown[][])[0][1] as string;
    expect(minted).toMatch(/^owa_k1_[0-9a-f]{64}$/);
    expect(logged).not.toContain(minted);
    expect(logged).toContain(`${minted.substring(0, 12)}…`);
  });

  it('shows the public development key whole', async () => {
    process.env.NODE_ENV = 'development';

    await service(0).onModuleInit();

    expect(logged).toContain('dev-admin-key');
  });

  it('never shows more than a third of a short hand-written key', () => {
    expect(bannerKey('short-secret-key')).toMatch(/^short… \(full key in .*\.api-key\)$/);
  });
});
