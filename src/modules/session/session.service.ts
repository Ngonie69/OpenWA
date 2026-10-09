import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { CreateSessionDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { IWhatsAppEngine, EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { createLogger } from '../../common/services/logger.service';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';

interface ReconnectState {
  attempts: number;
  timer: NodeJS.Timeout | null;
  maxAttempts: number;
  baseDelay: number;
}

/** How long a session may sit in initializing or authenticating before its engine is restarted. */
const DEFAULT_READY_TIMEOUT_MS = 5 * 60 * 1000;

/** Gap between restored sessions at startup, so their browsers do not all launch at once. */
const RESTORE_STAGGER_MS = 3000;

const ACTIVE_STATUSES = [
  SessionStatus.READY,
  SessionStatus.INITIALIZING,
  SessionStatus.QR_READY,
  SessionStatus.AUTHENTICATING,
];

@Injectable()
export class SessionService implements OnModuleDestroy, OnModuleInit, OnApplicationBootstrap {
  private readonly logger = createLogger('SessionService');

  // In-memory map of active engine instances
  private engines: Map<string, IWhatsAppEngine> = new Map();

  // Reconnection state per session
  private reconnectStates: Map<string, ReconnectState> = new Map();

  // Restarts an engine that never reaches ready or a QR code (whatsapp-web.js can hang after
  // 'authenticated' and never emit 'ready', and nothing else moves the session out of that state)
  private readyTimers: Map<string, NodeJS.Timeout> = new Map();

  // Sessions to start again once the application has bootstrapped, found by onModuleInit
  private sessionsToRestore: string[] = [];

  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepository: Repository<Session>,
    @InjectDataSource('data')
    private readonly dataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly eventsGateway: EventsGateway,
    private readonly webhookService: WebhookService,
    private readonly hookManager: HookManager,
  ) {}

  /**
   * On backend startup, note which sessions should be running, then reset all active session
   * statuses to disconnected because the engines are not running yet after restart
   */
  async onModuleInit(): Promise<void> {
    const sessions = await this.sessionRepository.find();
    this.sessionsToRestore = [];

    for (const session of sessions) {
      let autoStart = session.autoStart;

      if (autoStart === null || autoStart === undefined) {
        // A row from before autoStart existed: it was meant to be running if it still was when the
        // process stopped. Stop-Process and a reboot kill the gateway without shutdown hooks, so the
        // last status is what it was running as.
        autoStart = ACTIVE_STATUSES.includes(session.status);
        await this.sessionRepository.update(session.id, { autoStart });
      }

      if (autoStart) {
        this.sessionsToRestore.push(session.id);
      }
    }

    const result = await this.sessionRepository.update(
      { status: In(ACTIVE_STATUSES) },
      { status: SessionStatus.DISCONNECTED },
    );

    if (result.affected && result.affected > 0) {
      this.logger.log(`Reset ${result.affected} session(s) to disconnected on startup`, {
        action: 'startup_reset',
        affected: result.affected,
      });
    }
  }

  /**
   * Starts every session that was running before the restart. Not awaited: a browser launch can take
   * minutes, and startup must not wait on it.
   */
  onApplicationBootstrap(): void {
    void this.restoreSessions();
  }

  async restoreSessions(staggerMs = RESTORE_STAGGER_MS): Promise<void> {
    const ids = this.sessionsToRestore;
    this.sessionsToRestore = [];

    for (const [index, id] of ids.entries()) {
      if (index > 0 && staggerMs > 0) {
        await new Promise(resolve => setTimeout(resolve, staggerMs));
      }

      // Each start runs on its own, so one that hangs does not hold up the rest
      void this.restoreSession(id);
    }
  }

  private async restoreSession(id: string): Promise<void> {
    if (this.engines.has(id)) return;

    let session: Session;
    try {
      session = await this.findOne(id);
    } catch {
      return; // Deleted since startup
    }

    this.logger.log(`Restoring session after restart: ${session.name}`, {
      sessionId: id,
      action: 'restore',
    });

    try {
      await this.start(id);
    } catch (error: unknown) {
      // start has already scheduled the retry
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Restoring session ${session.name} failed`, errorMessage, {
        sessionId: id,
        action: 'restore_error',
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const id of [...this.readyTimers.keys()]) {
      this.clearReadyWatchdog(id);
    }

    // Clean up all engines on shutdown
    for (const [sessionId, engine] of this.engines) {
      this.logger.log(`Destroying engine for session ${sessionId}`, {
        sessionId,
        action: 'shutdown',
      });
      await engine.destroy();
    }
    this.engines.clear();

    // Clear all reconnect timers
    for (const [, state] of this.reconnectStates) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.reconnectStates.clear();
  }

  async create(dto: CreateSessionDto): Promise<Session> {
    // Check if session with same name exists
    const existing = await this.sessionRepository.findOne({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException(`Session with name '${dto.name}' already exists`);
    }

    const session = this.sessionRepository.create({
      name: dto.name,
      config: dto.config || {},
      proxyUrl: dto.proxyUrl || null,
      proxyType: dto.proxyType || null,
      status: SessionStatus.CREATED,
    });

    const saved = await this.dataSource.transaction(async manager => {
      return await manager.save(session);
    });
    this.logger.log(`Session created: ${saved.name}`, {
      sessionId: saved.id,
      action: 'create',
    });

    // Execute hook after session created (outside transaction since hooks do external I/O)
    await this.hookManager.execute('session:created', saved, {
      sessionId: saved.id,
      source: 'SessionService',
    });

    return saved;
  }

  async findAll(): Promise<Session[]> {
    return this.sessionRepository.find({
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException(`Session with id '${id}' not found`);
    }
    return session;
  }

  async findByName(name: string): Promise<Session> {
    const session = await this.sessionRepository.findOne({ where: { name } });
    if (!session) {
      throw new NotFoundException(`Session with name '${name}' not found`);
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);
    this.clearReadyWatchdog(id);

    // Stop engine if running
    const engine = this.engines.get(id);
    if (engine) {
      await engine.destroy();
      this.engines.delete(id);
    }

    // Execute hook BEFORE delete so plugins can access session data
    await this.hookManager.execute(
      'session:deleted',
      {
        id: session.id,
        name: session.name,
        phone: session.phone,
        pushName: session.pushName,
      },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    await this.dataSource.transaction(async manager => {
      await manager.remove(session);
    });
    this.logger.log(`Session deleted: ${session.name}`, {
      sessionId: id,
      action: 'delete',
    });
  }

  async start(id: string): Promise<Session> {
    const session = await this.findOne(id);

    if (this.engines.has(id)) {
      throw new BadRequestException('Session is already started');
    }

    // A reconnect still waiting from an earlier engine would otherwise replace the one started here
    this.cancelReconnect(id);

    // Remembered so that a gateway restart starts it again
    await this.sessionRepository.update(id, { autoStart: true });

    // Execute hook before starting
    await this.hookManager.execute(
      'session:starting',
      { sessionId: id },
      {
        sessionId: id,
        source: 'SessionService',
      },
    );

    // Initialize reconnect state
    const config = session.config as {
      maxReconnectAttempts?: number;
      reconnectBaseDelay?: number;
    } | null;
    this.reconnectStates.set(id, {
      attempts: 0,
      timer: null,
      maxAttempts: config?.maxReconnectAttempts ?? 5,
      baseDelay: config?.reconnectBaseDelay ?? 5000,
    });

    try {
      await this.initializeEngine(id, session);
    } catch (error) {
      // Often transient (WhatsApp Web reloading itself mid-inject), so keep trying in the background;
      // the caller still hears that this attempt failed
      this.scheduleReconnect(id, session);
      throw error;
    }
    return this.findOne(id);
  }

  private async initializeEngine(id: string, session: Session): Promise<void> {
    this.logger.log(`Initializing engine for session: ${session.name}`, {
      sessionId: id,
      action: 'engine_init',
      proxyEnabled: !!session.proxyUrl,
    });

    const engine = this.engineFactory.create({
      sessionId: session.name,
      proxyUrl: session.proxyUrl || undefined,
      proxyType: session.proxyType || undefined,
    });
    this.engines.set(id, engine);

    // An engine replaced or abandoned by the watchdog can still report in while it is torn down.
    // Its news is about a browser that is going away, so it must not move the session's status.
    const isCurrent = (): boolean => this.engines.get(id) === engine;

    this.armReadyWatchdog(id, session, engine);

    try {
      await this.runEngine(id, session, engine, isCurrent);
    } catch (error) {
      // Left registered, a dead engine makes every later start answer "already started", and its
      // browser keeps running
      if (isCurrent()) {
        this.clearReadyWatchdog(id);
        this.engines.delete(id);
        try {
          await engine.destroy();
        } catch (destroyError: unknown) {
          this.logger.warn(`Destroying the failed engine for ${session.name} failed`, {
            sessionId: id,
            error: destroyError instanceof Error ? destroyError.message : String(destroyError),
            action: 'engine_init_destroy_failed',
          });
        }
      }
      throw error;
    }

    if (isCurrent()) {
      await this.updateStatus(id, SessionStatus.INITIALIZING);
    }
  }

  private async runEngine(
    id: string,
    session: Session,
    engine: IWhatsAppEngine,
    isCurrent: () => boolean,
  ): Promise<void> {
    await engine.initialize({
      onQRCode: (): void => {
        if (!isCurrent()) return;

        this.logger.log('QR code generated', {
          sessionId: id,
          action: 'qr_generated',
        });

        // Execute hook for QR event
        void this.hookManager.execute(
          'session:qr',
          { sessionId: id },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.QR_READY);
      },
      onReady: (phone: string, pushName: string): void => {
        if (!isCurrent()) return;

        this.clearReadyWatchdog(id);
        this.logger.log(`Session ready: ${phone}`, {
          sessionId: id,
          phone,
          pushName,
          action: 'ready',
        });

        // Execute hook for ready event
        void this.hookManager.execute(
          'session:ready',
          { phone, pushName },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        // Reset reconnect attempts on successful connection
        const reconnectState = this.reconnectStates.get(id);
        if (reconnectState) {
          reconnectState.attempts = 0;
        }

        void this.sessionRepository.update(id, {
          status: SessionStatus.READY,
          phone,
          pushName,
          connectedAt: new Date(),
          lastActiveAt: new Date(),
        });
      },
      onMessage: (message): void => {
        this.logger.debug(`Message received from ${message.from}`, {
          sessionId: id,
          messageId: message.id,
          from: message.from,
          action: 'message_received',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() });
        // Convert IncomingMessage to plain object for dispatch
        const messageData = { ...message };

        // Execute hook for message received - plugins can modify or stop processing
        void this.hookManager
          .execute('message:received', messageData, {
            sessionId: id,
            source: 'Engine',
          })
          .then(({ continue: shouldContinue, data: finalMessage }) => {
            if (!shouldContinue) {
              // Plugin stopped processing (e.g., auto-reply handled it)
              return;
            }

            // Dispatch to webhooks with potentially modified message
            void this.webhookService.dispatch(id, 'message.received', finalMessage as Record<string, unknown>);
            // Emit real-time event to WebSocket clients
            this.eventsGateway.emitMessage(id, finalMessage as Record<string, unknown>);
          });
      },
      onDisconnected: (reason: string): void => {
        if (!isCurrent()) return;

        this.clearReadyWatchdog(id);
        this.logger.warn(`Session disconnected: ${reason}`, {
          sessionId: id,
          reason,
          action: 'disconnected',
        });

        // Execute hook for disconnected event
        void this.hookManager.execute(
          'session:disconnected',
          { reason },
          {
            sessionId: id,
            source: 'Engine',
          },
        );

        void this.updateStatus(id, SessionStatus.DISCONNECTED);

        // Attempt to reconnect
        this.scheduleReconnect(id, session);
      },
      onStateChanged: (engineState: EngineStatus): void => {
        if (!isCurrent()) return;

        if (engineState === EngineStatus.INITIALIZING || engineState === EngineStatus.AUTHENTICATING) {
          // Each step on the way to ready gets the full timeout
          this.armReadyWatchdog(id, session, engine);
        } else {
          this.clearReadyWatchdog(id);
        }

        const statusMap: Record<EngineStatus, SessionStatus> = {
          [EngineStatus.DISCONNECTED]: SessionStatus.DISCONNECTED,
          [EngineStatus.INITIALIZING]: SessionStatus.INITIALIZING,
          [EngineStatus.QR_READY]: SessionStatus.QR_READY,
          [EngineStatus.AUTHENTICATING]: SessionStatus.AUTHENTICATING,
          [EngineStatus.READY]: SessionStatus.READY,
          [EngineStatus.FAILED]: SessionStatus.FAILED,
        };
        const newStatus = statusMap[engineState];
        if (newStatus) {
          void this.updateStatus(id, newStatus);
        }
      },
    });
  }

  private armReadyWatchdog(id: string, session: Session, engine: IWhatsAppEngine): void {
    this.clearReadyWatchdog(id);

    const configured = (session.config as { readyTimeoutMs?: number } | null)?.readyTimeoutMs;
    const timeoutMs = typeof configured === 'number' ? configured : DEFAULT_READY_TIMEOUT_MS;
    if (timeoutMs <= 0) return;

    const timer = setTimeout(() => {
      void this.restartStuckEngine(id, session, engine, timeoutMs);
    }, timeoutMs);
    timer.unref?.();
    this.readyTimers.set(id, timer);
  }

  private clearReadyWatchdog(id: string): void {
    const timer = this.readyTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.readyTimers.delete(id);
    }
  }

  /**
   * The engine has sat in initializing or authenticating for the whole timeout. Tear it down and go
   * through the reconnect backoff; once that is spent, mark the session failed so it reads as broken
   * rather than as forever on its way up.
   */
  private async restartStuckEngine(
    id: string,
    session: Session,
    engine: IWhatsAppEngine,
    timeoutMs: number,
  ): Promise<void> {
    this.readyTimers.delete(id);
    if (this.engines.get(id) !== engine) return;

    const engineStatus = engine.getStatus();
    if (engineStatus !== EngineStatus.INITIALIZING && engineStatus !== EngineStatus.AUTHENTICATING) return;

    this.logger.warn(
      `Session ${session.name} was still ${engineStatus} after ${Math.round(timeoutMs / 1000)}s; restarting it`,
      { sessionId: id, status: engineStatus, action: 'ready_timeout' },
    );

    // Removed before the teardown, so the events it fires on the way out are ignored
    this.engines.delete(id);
    try {
      await engine.destroy();
    } catch (error: unknown) {
      this.logger.warn(`Destroying the stuck engine for ${session.name} failed`, {
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
        action: 'ready_timeout_destroy_failed',
      });
    }

    if (this.scheduleReconnect(id, session)) {
      await this.updateStatus(id, SessionStatus.DISCONNECTED);
    } else {
      await this.updateStatus(id, SessionStatus.FAILED);
    }
  }

  /** Returns false when no reconnect will happen: none is set up for the session, or all are used. */
  private scheduleReconnect(id: string, session: Session): boolean {
    const state = this.reconnectStates.get(id);
    if (!state) return false;

    // One attempt pending at a time: the watchdog and a failed initialize can both ask for one
    if (state.timer) return true;

    if (state.attempts >= state.maxAttempts) {
      this.logger.error(`Max reconnect attempts reached for session: ${session.name}`, undefined, {
        sessionId: id,
        attempts: state.attempts,
        action: 'reconnect_failed',
      });
      return false;
    }

    // Exponential backoff: baseDelay * 2^attempts (with jitter)
    const delay = state.baseDelay * Math.pow(2, state.attempts) + Math.random() * 1000;
    state.attempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${state.attempts}/${state.maxAttempts} in ${Math.round(delay / 1000)}s`,
      {
        sessionId: id,
        attempt: state.attempts,
        delayMs: delay,
        action: 'reconnect_scheduled',
      },
    );

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.executeReconnect(id, session, state);
    }, delay);
    return true;
  }

  private async executeReconnect(id: string, session: Session, state: ReconnectState): Promise<void> {
    // Stopped, deleted or started afresh since this attempt was scheduled
    if (this.reconnectStates.get(id) !== state) return;

    try {
      // Clean up old engine
      const oldEngine = this.engines.get(id);
      if (oldEngine) {
        await oldEngine.destroy();
        this.engines.delete(id);
      }

      // Re-initialize
      await this.initializeEngine(id, session);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Reconnect attempt ${state.attempts} failed`, errorMessage, {
        sessionId: id,
        action: 'reconnect_error',
      });
      // Schedule another attempt
      this.scheduleReconnect(id, session);
    }
  }

  private cancelReconnect(id: string): void {
    const state = this.reconnectStates.get(id);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.reconnectStates.delete(id);
  }

  async stop(id: string): Promise<Session> {
    const session = await this.findOne(id);

    // Cancel any reconnection attempts
    this.cancelReconnect(id);
    this.clearReadyWatchdog(id);

    // Stopped on purpose, so a gateway restart leaves it stopped
    await this.sessionRepository.update(id, { autoStart: false });

    const engine = this.engines.get(id);

    if (engine) {
      await engine.disconnect();
      this.engines.delete(id);
    }

    this.logger.log(`Session stopped: ${session.name}`, {
      sessionId: id,
      action: 'stop',
    });
    await this.updateStatus(id, SessionStatus.DISCONNECTED);
    return this.findOne(id);
  }

  async getQRCode(id: string): Promise<{ qrCode: string; status: SessionStatus }> {
    const session = await this.findOne(id);
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started. Call POST /sessions/:id/start first.');
    }

    const qrCode = engine.getQRCode();

    if (!qrCode) {
      if (session.status === SessionStatus.READY) {
        throw new BadRequestException('Session is already authenticated, no QR code needed');
      }
      throw new BadRequestException('QR code is not ready yet. Please wait...');
    }

    return {
      qrCode,
      status: session.status,
    };
  }

  getEngine(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  async getGroups(id: string): Promise<{ id: string; name: string }[]> {
    await this.findOne(id); // Verify session exists
    const engine = this.engines.get(id);

    if (!engine) {
      throw new BadRequestException('Session is not started');
    }

    const groups = await engine.getGroups();
    return groups.map(g => ({
      id: g.id,
      name: g.name,
    }));
  }

  private async updateStatus(id: string, status: SessionStatus): Promise<void> {
    await this.sessionRepository.update(id, { status });
    this.logger.debug(`Session status updated to ${status}`, {
      sessionId: id,
      status,
      action: 'status_update',
    });
    // Emit real-time event to connected WebSocket clients
    this.eventsGateway.emitSessionStatus(id, status);
  }

  /**
   * Get overall session statistics for multi-session monitoring
   */
  async getStats(): Promise<{
    total: number;
    active: number;
    ready: number;
    disconnected: number;
    byStatus: Record<string, number>;
    memoryUsage: { heapUsed: number; heapTotal: number; rss: number };
  }> {
    const sessions = await this.findAll();
    const byStatus: Record<string, number> = {};

    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
    }

    const memory = process.memoryUsage();

    return {
      total: sessions.length,
      active: this.engines.size,
      ready: byStatus[SessionStatus.READY] || 0,
      disconnected: byStatus[SessionStatus.DISCONNECTED] || 0,
      byStatus,
      memoryUsage: {
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
        rss: Math.round(memory.rss / 1024 / 1024),
      },
    };
  }

  /**
   * Get count of currently active (running) sessions
   */
  getActiveCount(): number {
    return this.engines.size;
  }

  /**
   * Check if session is currently active (engine running)
   */
  isActive(id: string): boolean {
    return this.engines.has(id);
  }
}
