/**
 * The owner of the asynchronous requests of a screen (KHA-74).
 *
 * A screen that reads and writes while the user acts needs one owner for its
 * requests, so that only the newest request may write its answer. The owner
 * knows:
 *
 * - the **context** of the screen: the composition, the identity and the
 *   focused match. A change of the context invalidates the requests of the
 *   old context, so an answer of another identity or of another match is
 *   never shown.
 * - the **pending** operation: only one operation runs at a time, and the
 *   operation that owns the pending state clears it. A stale answer of an
 *   older operation never clears the state of a newer one.
 * - the **unmount**: the cleanup of the effect invalidates the requests of the
 *   previous run, so a replay of the effect in development never revives an
 *   old answer.
 *
 * The owner is a plain object, so its rules are testable without a browser.
 */
export interface RequestOwnerOptions {
  /** The context of the screen. A change of it invalidates the requests. */
  readonly context: string;
  /** Called when a request is started or finished. */
  readonly onPendingChange?: (pending: boolean) => void;
  /** Checks live authority before the next render commits. */
  readonly isContextCurrent?: () => boolean;
}

export interface RequestOwner {
  /** The context the owner belongs to. */
  readonly context: string;
  /** True while an operation runs. */
  readonly pending: boolean;
  /**
   * Starts an operation.
   *
   * It answers the token of the operation, or zero when another operation
   * already runs, so a second click in the same tick is ignored.
   */
  begin(): number;
  /** Answers whether the token is still the owner of the screen. */
  isCurrent(token: number): boolean;
  /** Finishes the operation of the token. Only the owner clears the state. */
  finish(token: number): void;
  /**
   * Invalidates every request of the screen.
   *
   * The screen is gone, so no operation may start and no state is written.
   */
  invalidate(): void;
  /**
   * Revives the owner after the cleanup of an effect.
   *
   * A replay of the effect in development starts again, and the requests of
   * the previous run stay invalid.
   */
  revive(): void;
  /**
   * Moves the owner to another context.
   *
   * The requests of the old context are invalidated, and the pending state
   * is cleared, so a screen that changed its context never keeps a stale
   * operation.
   */
  moveTo(context: string): void;
}

/** Creates the request owner of a screen. */
export function createRequestOwner(options: RequestOwnerOptions): RequestOwner {
  let context = options.context;
  let token = 0;
  let pendingToken: number | null = null;
  let alive = true;

  function setPending(next: boolean): void {
    // A screen that is gone never writes its state any more.
    if (!alive) return;
    options.onPendingChange?.(next);
  }

  return {
    get context() {
      return context;
    },
    get pending() {
      return pendingToken !== null;
    },
    begin() {
      // The ownership is synchronous: a second click in the same tick never
      // starts a second operation, and a screen that is gone never starts
      // one.
      if (!alive || pendingToken !== null || options.isContextCurrent?.() === false) return 0;
      token += 1;
      pendingToken = token;
      setPending(true);
      return token;
    },
    isCurrent(candidate) {
      return alive && pendingToken === candidate && options.isContextCurrent?.() !== false;
    },
    finish(candidate) {
      // Only the owner of the pending state clears it. A stale answer of an
      // older operation never clears a newer one.
      if (pendingToken !== candidate) return;
      pendingToken = null;
      setPending(false);
    },
    invalidate() {
      alive = false;
      token += 1;
      pendingToken = null;
    },
    revive() {
      // A replay of the effect starts again. The requests of the previous run
      // stay invalid, because the token moved on.
      alive = true;
      token += 1;
    },
    moveTo(next) {
      if (next === context) return;
      context = next;
      this.invalidate();
      this.revive();
      setPending(false);
    },
  };
}
