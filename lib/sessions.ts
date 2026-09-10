/**
 * Default session inactivity timeout (30 minutes).
 *
 * Deliberately generous: clients that never open a standalone SSE stream
 * (or whose stream fails to attach, as happens with mcp-remote) cannot
 * receive keep-alive pings, so their sessions are only refreshed by real
 * requests. Chat clients like Claude Desktop routinely sit idle for many
 * minutes between tool calls and cannot recover from an expired session
 * without a full restart.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

/** Default ping interval (30 seconds) - per MCP best practices */
export const DEFAULT_PING_INTERVAL_MS = 30 * 1000;

/** Max consecutive failed pings before considering session dead */
export const DEFAULT_MAX_FAILED_PINGS = 3;

export interface SessionConfig {
  /** Inactivity timeout in milliseconds */
  inactivityTimeoutMs: number;
  /** Ping interval in milliseconds (0 to disable) */
  pingIntervalMs: number;
  /** Max consecutive failed pings before session termination */
  maxFailedPings: number;
}

export interface Session {
  id: string;
  connectedAt: Date;
  lastActivity: Date;
  lastPingAt?: Date;
  lastPongAt?: Date;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  pingHandle?: ReturnType<typeof setInterval>;
  /** Number of consecutive failed ping attempts */
  failedPings: number;
  /** Client name from MCP initialize request (e.g., "Claude Code", "Cline") */
  clientName?: string;
  /** Client version from MCP initialize request */
  clientVersion?: string;
}

type SessionListener = (sessions: Session[]) => void;
type RemovalCallback = (sessionId: string) => void | Promise<void>;
type PingCallback = (sessionId: string) => Promise<boolean>;

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private listeners: Set<SessionListener> = new Set();
  private removalCallback: RemovalCallback | null = null;
  private pingCallback: PingCallback | null = null;
  private pendingRemovals = new Set<Promise<void>>();
  private activeRequests = new Map<string, number>();
  private config: SessionConfig = {
    inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS,
    pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
    maxFailedPings: DEFAULT_MAX_FAILED_PINGS,
  };

  /**
   * Configure session manager settings
   */
  configure(config: Partial<SessionConfig>): void {
    this.config = { ...this.config, ...config };
    console.log(`[MCP] Session config updated: timeout=${this.config.inactivityTimeoutMs}ms, ping=${this.config.pingIntervalMs}ms`);
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<SessionConfig> {
    return { ...this.config };
  }

  add(sessionId: string): void {
    // Don't add duplicate sessions
    if (this.sessions.has(sessionId)) {
      this.updateActivity(sessionId);
      return;
    }

    const session: Session = {
      id: sessionId,
      connectedAt: new Date(),
      lastActivity: new Date(),
      failedPings: 0,
    };
    this.resetTimeout(session);
    this.startPingInterval(session);
    this.sessions.set(sessionId, session);
    this.notifyListeners();

    console.log(`[MCP] Session connected: ${sessionId.slice(0, 8)}...`);
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.clearSessionTimers(session);

    // Delete from map FIRST to prevent re-entrancy issues
    // (e.g., if removalCallback triggers onsessionclosed which calls remove() again)
    this.sessions.delete(sessionId);
    this.activeRequests.delete(sessionId);
    this.notifyListeners();

    console.log(`[MCP] Session disconnected: ${sessionId.slice(0, 8)}...`);

    // Notify removal callback (e.g., to close transport) after removing from map
    if (this.removalCallback) {
      try {
        const removal = Promise.resolve(this.removalCallback(sessionId)).catch((error) => {
          console.error("[MCP] Session removal callback error:", error);
        });
        this.pendingRemovals.add(removal);
        void removal.finally(() => this.pendingRemovals.delete(removal));
      } catch (error) {
        console.error("[MCP] Session removal callback error:", error);
      }
    }
  }

  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      session.failedPings = 0; // Reset failed pings on activity
      this.resetTimeout(session);
    }
  }

  /** Keep a session alive while a request is executing, including queued tools. */
  beginActivity(sessionId: string): () => void {
    const session = this.sessions.get(sessionId);
    if (!session) return () => {};
    this.activeRequests.set(sessionId, (this.activeRequests.get(sessionId) ?? 0) + 1);
    this.updateActivity(sessionId);
    let ended = false;
    return () => {
      if (ended || this.sessions.get(sessionId) !== session) return;
      ended = true;
      this.endActivity(sessionId);
    };
  }

  endActivity(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    const count = (this.activeRequests.get(sessionId) ?? 1) - 1;
    if (count > 0) this.activeRequests.set(sessionId, count);
    else this.activeRequests.delete(sessionId);
    this.updateActivity(sessionId);
  }

  /**
   * Record that a ping was sent to the session
   */
  recordPingSent(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastPingAt = new Date();
    }
  }

  /**
   * Record that a pong (ping response) was received from the session.
   * This confirms the transport is alive but does NOT count as client
   * activity — only real MCP requests should reset the inactivity timer
   * (via updateActivity).
   */
  recordPongReceived(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastPongAt = new Date();
      session.failedPings = 0;
    }
  }

  /**
   * Record a failed ping attempt.
   *
   * Ping failures are diagnostic only and never terminate the session.
   * Over Streamable HTTP a server→client ping is only deliverable when the
   * client holds an open standalone SSE (GET) stream; clients without one
   * (mcp-remote/Claude Desktop among them) are healthy yet can never pong.
   * Killing their sessions on failed pings breaks them within minutes.
   * Dead sessions are reaped by the inactivity timeout instead.
   */
  recordPingFailed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Cap the counter — for clients that can never pong it would otherwise
    // grow with uptime and stop meaning "consecutive failures".
    session.failedPings = Math.min(
      session.failedPings + 1,
      this.config.maxFailedPings
    );
    if (session.failedPings < this.config.maxFailedPings) {
      console.log(`[MCP] Ping unanswered for session ${sessionId.slice(0, 8)}... (${session.failedPings}/${this.config.maxFailedPings}; informational only)`);
    }
  }

  updateClientInfo(sessionId: string, clientName?: string, clientVersion?: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clientName = clientName;
      session.clientVersion = clientVersion;
      this.notifyListeners();
      const displayName = clientName || sessionId.slice(0, 8) + '...';
      console.log(`[MCP] Session identified: ${displayName}${clientVersion ? ` v${clientVersion}` : ''}`);
    }
  }

  private clearSessionTimers(session: Session): void {
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
      session.timeoutHandle = undefined;
    }
    if (session.pingHandle) {
      clearInterval(session.pingHandle);
      session.pingHandle = undefined;
    }
  }

  private resetTimeout(session: Session): void {
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
      session.timeoutHandle = undefined;
    }
    if (this.activeRequests.has(session.id)) return;
    session.timeoutHandle = setTimeout(() => {
      console.log(`[MCP] Session timed out: ${session.id.slice(0, 8)}...`);
      this.remove(session.id);
    }, this.config.inactivityTimeoutMs);
  }

  private startPingInterval(session: Session): void {
    // Don't start ping if interval is 0 (disabled) or no callback
    if (this.config.pingIntervalMs <= 0) return;

    let pending = false;
    session.pingHandle = setInterval(async () => {
      if (!this.pingCallback || pending) return;

      pending = true;
      this.recordPingSent(session.id);
      try {
        const success = await this.pingCallback(session.id);
        if (this.sessions.get(session.id) !== session) return;
        if (success) {
          this.recordPongReceived(session.id);
        } else {
          this.recordPingFailed(session.id);
        }
      } catch (error) {
        if (this.sessions.get(session.id) !== session) return;
        console.error(`[MCP] Ping error for session ${session.id.slice(0, 8)}...:`, error);
        this.recordPingFailed(session.id);
      } finally {
        pending = false;
      }
    }, this.config.pingIntervalMs);
  }

  getAll(): Session[] {
    return [...this.sessions.values()];
  }

  getCount(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    // Immediately call with current state
    listener(this.getAll());
    return () => this.listeners.delete(listener);
  }

  /**
   * Sets a callback to be invoked when a session is removed (timeout or explicit).
   * Used to synchronize transport cleanup with session removal.
   */
  setRemovalCallback(callback: RemovalCallback | null): void {
    this.removalCallback = callback;
  }

  /**
   * Sets a callback to be invoked for pinging a session.
   * The callback should send an MCP ping request and return true if successful.
   */
  setPingCallback(callback: PingCallback | null): void {
    this.pingCallback = callback;
  }

  private notifyListeners(): void {
    const sessions = this.getAll();
    this.listeners.forEach((listener) => {
      try {
        listener(sessions);
      } catch (error) {
        console.error("[MCP] Session listener error:", error);
      }
    });
  }

  /**
   * Clears all sessions and timeouts. Used during plugin unload.
   */
  async clear(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) this.remove(sessionId);
    this.listeners.clear();
    this.pingCallback = null;
    this.removalCallback = null;
    await Promise.all(this.pendingRemovals);
  }
}

export const sessionManager = new SessionManager();
