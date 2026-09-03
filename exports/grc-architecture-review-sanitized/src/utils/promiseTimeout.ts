/**
 * withTimeout — race a promise against a wall-clock deadline.
 *
 * Shared so every live external call (CRMProvider reads/writes, cluster lookups) can
 * be bounded. Without a timeout, one hanging call leaves the agent's tool
 * pending forever → the user gets a blank reply / endless spinner. On timeout
 * we REJECT with a labelled error so the caller's try/catch can report a clear,
 * actionable failure instead of stalling.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
