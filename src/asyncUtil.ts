/**
 * Adapts an async listener to the void-returning signature that DOM event
 * handlers expect. These call sites were already fire-and-forget (a Promise
 * passed to addEventListener is never awaited); wrapping it in `void` makes that
 * explicit and satisfies @typescript-eslint/no-misused-promises without changing
 * any runtime behaviour.
 */
export function voidAsync<E>(fn: (e: E) => Promise<void>): (e: E) => void {
  return (e) => {
    void fn(e);
  };
}
