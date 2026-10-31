import type { DiscoveryConfig } from './config.js';
import { isObject } from './rpc.js';

export interface LogNotification {
  readonly signature: string;
  readonly slot: number;
  readonly logs: readonly string[];
  readonly receivedAt?: number;
}
export interface SocketLike {
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}
export type TransportState = 'stopped' | 'connecting' | 'ready' | 'reconnecting';

/** One-generation-at-a-time connection; no URL or untrusted server message is logged. */
export class DiscoveryTransport {
  private generation = 0;
  private stopped = true;
  private socket: SocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private attempt = 0;
  private nextId = 1;
  constructor(
    private readonly config: DiscoveryConfig,
    private readonly programs: readonly string[],
    private readonly onLogs: (notification: LogNotification) => void,
    private readonly onState: (state: TransportState) => void,
    private readonly createSocket: (url: string) => SocketLike = (url) => new WebSocket(url),
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    this.socket?.close();
    this.socket = undefined;
    this.attempt = 0;
    this.onState('stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const pending = new Map<number, string>();
    const subscriptions = new Map<number, string>();
    let lastActivity = Date.now();
    let ready = false;
    let openedAt = Date.now();
    this.onState(this.attempt ? 'reconnecting' : 'connecting');
    const current = () => !this.stopped && this.generation === generation;
    const fail = () => {
      if (!current()) return;
      this.generation++;
      clearInterval(this.watchdog);
      try {
        this.socket?.close();
      } catch {
        /* Already closed. */
      }
      this.socket = undefined;
      this.onState('reconnecting');
      // Reset only after a connection survived a heartbeat window.
      if (ready && Date.now() - openedAt >= this.config.heartbeatTimeoutMs) this.attempt = 0;
      const delay = Math.min(
        this.config.reconnectMaxMs,
        this.config.reconnectMinMs * 2 ** Math.min(this.attempt++, 16),
      );
      this.reconnectTimer = setTimeout(
        () => this.connect(),
        Math.round(delay * (0.75 + this.random() * 0.5)),
      );
    };
    let socket: SocketLike;
    try {
      socket = this.createSocket(
        typeof this.config.wsUrl === 'string' ? this.config.wsUrl : this.config.wsUrl.reveal(),
      );
    } catch {
      fail();
      return;
    }
    this.socket = socket;
    this.watchdog = setInterval(
      () => {
        if (
          (!ready && Date.now() - openedAt > this.config.ackTimeoutMs) ||
          Date.now() - lastActivity > this.config.heartbeatTimeoutMs
        )
          fail();
      },
      Math.max(10, Math.min(1_000, this.config.ackTimeoutMs, this.config.heartbeatTimeoutMs) / 2),
    );
    socket.addEventListener('open', () => {
      if (!current()) return;
      openedAt = Date.now();
      try {
        for (const program of [...this.programs, 'slots']) {
          const id = this.nextId++;
          pending.set(id, program);
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: program === 'slots' ? 'slotSubscribe' : 'logsSubscribe',
              params:
                program === 'slots' ? [] : [{ mentions: [program] }, { commitment: 'confirmed' }],
            }),
          );
        }
      } catch {
        fail();
      }
    });
    socket.addEventListener('error', fail);
    socket.addEventListener('close', fail);
    socket.addEventListener('message', ({ data }) => {
      if (!current() || typeof data !== 'string' || data.length > 2_000_000) return;
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        return;
      }
      if (!isObject(value) || value.jsonrpc !== '2.0') return;
      if (typeof value.id === 'number' && pending.has(value.id)) {
        if (
          value.error !== undefined ||
          !Number.isSafeInteger(value.result) ||
          (value.result as number) < 0 ||
          subscriptions.has(value.result as number)
        ) {
          fail();
          return;
        }
        subscriptions.set(value.result as number, pending.get(value.id)!);
        pending.delete(value.id);
        lastActivity = Date.now();
        if (!pending.size) {
          ready = true;
          this.onState('ready');
        }
        return;
      }
      if (!isObject(value.params) || typeof value.params.subscription !== 'number') return;
      const program = subscriptions.get(value.params.subscription);
      if (!program) return;
      if (program === 'slots' && value.method === 'slotNotification') {
        if (isObject(value.params.result) && Number.isSafeInteger(value.params.result.slot))
          lastActivity = Date.now();
        return;
      }
      if (value.method !== 'logsNotification' || !isObject(value.params.result)) return;
      const result = value.params.result;
      if (
        !isObject(result.context) ||
        !Number.isSafeInteger(result.context.slot) ||
        (result.context.slot as number) < 0 ||
        !isObject(result.value)
      )
        return;
      const log = result.value;
      if (
        log.err !== null ||
        typeof log.signature !== 'string' ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(log.signature) ||
        !Array.isArray(log.logs) ||
        log.logs.length > 10_000 ||
        !log.logs.every((line) => typeof line === 'string')
      )
        return;
      lastActivity = Date.now();
      this.onLogs({
        signature: log.signature,
        slot: result.context.slot as number,
        logs: log.logs as string[],
        receivedAt: Date.now(),
      });
    });
  }
}
