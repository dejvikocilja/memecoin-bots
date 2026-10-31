/** Serial, abortable polling. A stalled task cannot overlap the next poll or publish fake progress. */
export function createPollingLoop(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  onError: () => void,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller = new AbortController();
  let current: Promise<void> | undefined;
  const poll = () => {
    if (current || controller.signal.aborted) return;
    const signal = controller.signal;
    current = Promise.resolve()
      .then(() => task(signal))
      .catch(() => {
        if (!signal.aborted) onError();
      })
      .finally(() => {
        current = undefined;
      });
  };
  return {
    start() {
      if (timer) return;
      controller = new AbortController();
      timer = setInterval(poll, intervalMs);
      poll();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      controller.abort();
      await current;
    },
  };
}

export class OperationCancelledError extends Error {
  constructor() {
    super('OPERATION_CANCELLED');
  }
}

/** Include callback/body parsing time in the deadline, even for a misbehaving injected adapter. */
export async function withinDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  let listener: (() => void) | undefined;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return task(signal);
      }),
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(new OperationCancelledError());
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (listener) signal.removeEventListener('abort', listener);
  }
}
