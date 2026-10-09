import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { SessionService } from './session.service';
import { Session, SessionStatus } from './entities/session.entity';
import { EngineFactory } from '../../engine/engine.factory';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { EngineStatus, EngineEventCallbacks } from '../../engine/interfaces/whatsapp-engine.interface';

function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-uuid-1',
    name: 'test-session',
    status: SessionStatus.CREATED,
    phone: null,
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    autoStart: null,
    connectedAt: null,
    lastActiveAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('SessionService', () => {
  let service: SessionService;
  let repository: jest.Mocked<Partial<Repository<Session>>>;
  let dataSource: jest.Mocked<Partial<DataSource>>;
  let engineFactory: jest.Mocked<Partial<EngineFactory>>;
  let eventsGateway: jest.Mocked<Partial<EventsGateway>>;
  let webhookService: jest.Mocked<Partial<WebhookService>>;
  let hookManager: jest.Mocked<Partial<HookManager>>;
  let mockEngine: Record<string, jest.Mock>;

  beforeEach(async () => {
    repository = {
      count: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation(async (cb: (manager: unknown) => Promise<unknown>) => {
        const manager = {
          save: jest.fn().mockImplementation((entity: unknown) => Promise.resolve(entity)),
          remove: jest.fn().mockResolvedValue(undefined),
        };
        return cb(manager);
      }),
    };

    mockEngine = {
      initialize: jest.fn().mockResolvedValue(undefined),
      destroy: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      getQRCode: jest.fn().mockReturnValue(null),
      getGroups: jest.fn().mockResolvedValue([]),
      getStatus: jest.fn().mockReturnValue(EngineStatus.INITIALIZING),
    };

    engineFactory = {
      create: jest.fn().mockReturnValue(mockEngine),
    };

    eventsGateway = {
      emitSessionStatus: jest.fn(),
      emitMessage: jest.fn(),
    };

    webhookService = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };

    hookManager = {
      execute: jest.fn().mockResolvedValue({ continue: true, data: {} }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        {
          provide: getRepositoryToken(Session, 'data'),
          useValue: repository,
        },
        {
          provide: getDataSourceToken('data'),
          useValue: dataSource,
        },
        { provide: EngineFactory, useValue: engineFactory },
        { provide: EventsGateway, useValue: eventsGateway },
        { provide: WebhookService, useValue: webhookService },
        { provide: HookManager, useValue: hookManager },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  // ── create ────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a new session with CREATED status', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(null); // no duplicate
      (repository.create as jest.Mock).mockReturnValue(session);
      (repository.save as jest.Mock).mockResolvedValue(session);

      const result = await service.create({ name: 'test-session' });

      expect(result.name).toBe('test-session');
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ status: SessionStatus.CREATED }));
      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:created',
        session,
        expect.objectContaining({ sessionId: session.id }),
      );
    });

    it('should throw ConflictException if session name already exists', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await expect(service.create({ name: 'test-session' })).rejects.toThrow(ConflictException);
    });
  });

  // ── findAll / findOne / findByName ────────────────────────────────

  describe('findAll', () => {
    it('should return all sessions ordered by createdAt DESC', async () => {
      const sessions = [createMockSession(), createMockSession({ id: 'sess-2' })];
      (repository.find as jest.Mock).mockResolvedValue(sessions);

      const result = await service.findAll();

      expect(result).toHaveLength(2);
      expect(repository.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
    });
  });

  describe('findOne', () => {
    it('should return session by id', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      const result = await service.findOne('sess-uuid-1');
      expect(result.id).toBe('sess-uuid-1');
    });

    it('should throw NotFoundException if session not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByName', () => {
    it('should return session by name', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      const result = await service.findByName('test-session');
      expect(result.name).toBe('test-session');
    });

    it('should throw NotFoundException if name not found', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(service.findByName('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('should stop engine and remove session from DB', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.remove as jest.Mock).mockResolvedValue(session);

      await service.delete('sess-uuid-1');

      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:deleted',
        expect.objectContaining({ id: 'sess-uuid-1', name: 'test-session' }),
        expect.any(Object),
      );
    });

    it('should destroy running engine before deleting', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.save as jest.Mock).mockImplementation(s => Promise.resolve(s));
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (repository.remove as jest.Mock).mockResolvedValue(session);

      // Start the session first to create an engine
      await service.start('sess-uuid-1');

      // Now delete
      await service.delete('sess-uuid-1');

      expect(mockEngine.destroy).toHaveBeenCalled();
    });
  });

  // ── start ─────────────────────────────────────────────────────────

  describe('start', () => {
    it('should create engine and set status to INITIALIZING', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(engineFactory.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'test-session' }));
      expect(mockEngine.initialize).toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', {
        status: SessionStatus.INITIALIZING,
      });
    });

    it('should throw BadRequestException if session already started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      await expect(service.start('sess-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('should execute session:starting hook before initializing engine', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(hookManager.execute).toHaveBeenCalledWith(
        'session:starting',
        expect.objectContaining({ sessionId: 'sess-uuid-1' }),
        expect.any(Object),
      );
    });
  });

  // ── stop ──────────────────────────────────────────────────────────

  describe('stop', () => {
    it('should disconnect engine and set status to DISCONNECTED', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      // Start first
      await service.start('sess-uuid-1');

      // Stop
      await service.stop('sess-uuid-1');

      expect(mockEngine.disconnect).toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', {
        status: SessionStatus.DISCONNECTED,
      });
    });
  });

  // ── getQRCode ─────────────────────────────────────────────────────

  describe('getQRCode', () => {
    it('should throw BadRequestException if engine not started', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);

      await expect(service.getQRCode('sess-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('should return QR code from engine', async () => {
      const session = createMockSession({ status: SessionStatus.QR_READY });
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.getQRCode.mockReturnValue('data:image/png;base64,iVBOR...');

      const result = await service.getQRCode('sess-uuid-1');

      expect(result.qrCode).toBe('data:image/png;base64,iVBOR...');
    });

    it('should throw if session is READY (already authenticated)', async () => {
      const session = createMockSession({ status: SessionStatus.READY });
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      mockEngine.getQRCode.mockReturnValue(null);

      await expect(service.getQRCode('sess-uuid-1')).rejects.toThrow('already authenticated');
    });
  });

  // ── getStats ──────────────────────────────────────────────────────

  describe('getStats', () => {
    it('should return correct session statistics', async () => {
      const sessions = [
        createMockSession({ status: SessionStatus.READY }),
        createMockSession({ id: 'sess-2', status: SessionStatus.READY }),
        createMockSession({ id: 'sess-3', status: SessionStatus.DISCONNECTED }),
      ];
      (repository.find as jest.Mock).mockResolvedValue(sessions);

      const stats = await service.getStats();

      expect(stats.total).toBe(3);
      expect(stats.ready).toBe(2);
      expect(stats.disconnected).toBe(1);
      expect(stats.byStatus[SessionStatus.READY]).toBe(2);
      expect(stats.memoryUsage).toBeDefined();
    });
  });

  // ── getActiveCount / isActive ─────────────────────────────────────

  describe('getActiveCount', () => {
    it('should return 0 when no engines are running', () => {
      expect(service.getActiveCount()).toBe(0);
    });

    it('should return correct count after starting sessions', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(service.getActiveCount()).toBe(1);
    });
  });

  describe('isActive', () => {
    it('should return false for inactive session', () => {
      expect(service.isActive('nonexistent')).toBe(false);
    });

    it('should return true for active session', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');

      expect(service.isActive('sess-uuid-1')).toBe(true);
    });
  });

  // ── onModuleInit ──────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('should reset active sessions to DISCONNECTED on startup', async () => {
      (repository.find as jest.Mock).mockResolvedValue([]);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 3 });

      await service.onModuleInit();

      expect(repository.update).toHaveBeenCalledWith(expect.objectContaining({ status: expect.anything() as string }), {
        status: SessionStatus.DISCONNECTED,
      });
    });
  });

  // ── onModuleDestroy ───────────────────────────────────────────────

  describe('onModuleDestroy', () => {
    it('should destroy all running engines on shutdown', async () => {
      const session = createMockSession();
      (repository.findOne as jest.Mock).mockResolvedValue(session);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      await service.onModuleDestroy();

      expect(mockEngine.destroy).toHaveBeenCalled();
      expect(service.getActiveCount()).toBe(0);
    });
  });

  // ── autoStart: remembering which sessions should run ──────────────

  describe('autoStart', () => {
    it('should set autoStart on start and clear it on stop', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });

      await service.start('sess-uuid-1');
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', { autoStart: true });

      await service.stop('sess-uuid-1');
      expect(repository.update).toHaveBeenCalledWith('sess-uuid-1', { autoStart: false });
    });

    it('should restore sessions marked autoStart, and resolve rows from before the column by their last status', async () => {
      const sessions = [
        createMockSession({ id: 'kept-on', autoStart: true, status: SessionStatus.DISCONNECTED }),
        createMockSession({ id: 'kept-off', autoStart: false, status: SessionStatus.READY }),
        createMockSession({ id: 'legacy-stuck', autoStart: null, status: SessionStatus.AUTHENTICATING }),
        createMockSession({ id: 'legacy-stopped', autoStart: null, status: SessionStatus.DISCONNECTED }),
      ];
      (repository.find as jest.Mock).mockResolvedValue(sessions);
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
      (repository.findOne as jest.Mock).mockImplementation(({ where: { id } }: { where: { id: string } }) =>
        Promise.resolve(sessions.find(s => s.id === id) ?? null),
      );

      await service.onModuleInit();

      expect(repository.update).toHaveBeenCalledWith('legacy-stuck', { autoStart: true });
      expect(repository.update).toHaveBeenCalledWith('legacy-stopped', { autoStart: false });
      expect(repository.update).not.toHaveBeenCalledWith('kept-on', expect.anything());
      expect(repository.update).not.toHaveBeenCalledWith('kept-off', expect.anything());

      await service.restoreSessions(0);
      await new Promise(resolve => setImmediate(resolve));

      expect(service.isActive('kept-on')).toBe(true);
      expect(service.isActive('legacy-stuck')).toBe(true);
      expect(service.isActive('kept-off')).toBe(false);
      expect(service.isActive('legacy-stopped')).toBe(false);
    });

    it('should tear down an engine whose start fails, so the session can be started again', async () => {
      jest.useFakeTimers();
      try {
        (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());
        (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
        mockEngine.initialize.mockRejectedValueOnce(new Error('Execution context was destroyed'));

        await expect(service.start('sess-uuid-1')).rejects.toThrow('Execution context was destroyed');

        expect(mockEngine.destroy).toHaveBeenCalled();
        expect(service.isActive('sess-uuid-1')).toBe(false);

        // Not "already started": the operator's next press works
        await service.start('sess-uuid-1');
        expect(service.isActive('sess-uuid-1')).toBe(true);

        // ...and the retry the failure scheduled was dropped in favour of it
        await jest.advanceTimersByTimeAsync(60000);
        expect(engineFactory.create).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('should retry a restore whose start fails, through the reconnect backoff', async () => {
      jest.useFakeTimers();
      try {
        const session = createMockSession({ autoStart: true });
        (repository.find as jest.Mock).mockResolvedValue([session]);
        (repository.findOne as jest.Mock).mockResolvedValue(session);
        (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
        mockEngine.initialize.mockRejectedValueOnce(new Error('Chrome did not start'));

        await service.onModuleInit();
        await service.restoreSessions(0);
        await jest.advanceTimersByTimeAsync(0);
        expect(engineFactory.create).toHaveBeenCalledTimes(1);

        // First backoff is 5s plus up to 1s of jitter
        await jest.advanceTimersByTimeAsync(6000);
        expect(engineFactory.create).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ── ready watchdog ────────────────────────────────────────────────

  describe('ready watchdog', () => {
    const READY_TIMEOUT_MS = 5 * 60 * 1000;
    let engines: Record<string, jest.Mock>[];
    let callbacks: EngineEventCallbacks[];

    beforeEach(() => {
      jest.useFakeTimers();
      engines = [];
      callbacks = [];
      (engineFactory.create as jest.Mock).mockImplementation(() => {
        const engine: Record<string, jest.Mock> = {
          ...mockEngine,
          initialize: jest.fn().mockImplementation((cb: EngineEventCallbacks) => {
            callbacks.push(cb);
            return Promise.resolve();
          }),
          destroy: jest.fn().mockResolvedValue(undefined),
          getStatus: jest.fn().mockReturnValue(EngineStatus.AUTHENTICATING),
        };
        engines.push(engine);
        return engine;
      });
      (repository.update as jest.Mock).mockResolvedValue({ affected: 1 });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should restart an engine stuck in authenticating, then ignore the old engine', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await service.start('sess-uuid-1');
      callbacks[0].onStateChanged?.(EngineStatus.AUTHENTICATING);

      await jest.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      expect(engines[0].destroy).toHaveBeenCalled();
      expect(service.isActive('sess-uuid-1')).toBe(false);
      expect(repository.update).toHaveBeenLastCalledWith('sess-uuid-1', { status: SessionStatus.DISCONNECTED });

      // The torn-down engine reporting in must not move the session
      callbacks[0].onStateChanged?.(EngineStatus.READY);
      await jest.advanceTimersByTimeAsync(0);
      expect(repository.update).not.toHaveBeenCalledWith('sess-uuid-1', { status: SessionStatus.READY });

      await jest.advanceTimersByTimeAsync(6000);
      expect(engineFactory.create).toHaveBeenCalledTimes(2);
      expect(service.isActive('sess-uuid-1')).toBe(true);
    });

    it('should leave an engine alone once it is ready', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await service.start('sess-uuid-1');
      callbacks[0].onStateChanged?.(EngineStatus.AUTHENTICATING);
      callbacks[0].onReady?.('263700000000', 'Test');
      callbacks[0].onStateChanged?.(EngineStatus.READY);

      await jest.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 2);
      expect(engines[0].destroy).not.toHaveBeenCalled();
      expect(engineFactory.create).toHaveBeenCalledTimes(1);
    });

    it('should leave an engine waiting for a QR scan alone', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await service.start('sess-uuid-1');
      callbacks[0].onStateChanged?.(EngineStatus.QR_READY);

      await jest.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 2);
      expect(engines[0].destroy).not.toHaveBeenCalled();
    });

    it('should mark the session failed once the reconnect attempts are spent', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession({ config: { maxReconnectAttempts: 0 } }));

      await service.start('sess-uuid-1');
      callbacks[0].onStateChanged?.(EngineStatus.AUTHENTICATING);

      await jest.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      expect(engines[0].destroy).toHaveBeenCalled();
      expect(repository.update).toHaveBeenLastCalledWith('sess-uuid-1', { status: SessionStatus.FAILED });

      // Not running, so the operator can start it again
      await service.start('sess-uuid-1');
      expect(service.isActive('sess-uuid-1')).toBe(true);
    });

    it('should not restart a session that was stopped while waiting', async () => {
      (repository.findOne as jest.Mock).mockResolvedValue(createMockSession());

      await service.start('sess-uuid-1');
      callbacks[0].onStateChanged?.(EngineStatus.AUTHENTICATING);
      await service.stop('sess-uuid-1');

      await jest.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 2);
      expect(engines[0].destroy).not.toHaveBeenCalled();
      expect(engineFactory.create).toHaveBeenCalledTimes(1);
    });
  });
});
