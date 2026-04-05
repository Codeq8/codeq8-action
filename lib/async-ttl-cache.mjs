function normalizeTtlMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

/**
 * @param {{
 *   ttlMs?: number;
 *   now?: () => number;
 * }} [options]
 */
export function createAsyncTtlCache({
  ttlMs = 15_000,
  now = () => Date.now(),
} = {}) {
  const normalizedTtlMs = normalizeTtlMs(ttlMs, 15_000);
  const entries = new Map();

  return {
    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T> | T} load
     * @param {{
     *   shouldCache?: (value: T) => boolean;
     *   ttlMs?: number;
     *   resolveTtlMs?: (value: T, fallbackTtlMs: number) => number;
     * }} [options]
     * @returns {Promise<T>}
     */
    async getOrLoad(
      key,
      load,
      {
        shouldCache = () => true,
        ttlMs: overrideTtlMs,
        resolveTtlMs = null,
      } = {},
    ) {
      const normalizedKey = String(key ?? "").trim();
      if (!normalizedKey) {
        return await Promise.resolve().then(load);
      }

      const effectiveTtlMs = normalizeTtlMs(overrideTtlMs, normalizedTtlMs);
      const existing = entries.get(normalizedKey);
      const nowMs = now();
      if (existing?.value !== undefined && existing.expiresAt > nowMs) {
        return existing.value;
      }
      if (existing?.promise) {
        return await existing.promise;
      }

      const promise = Promise.resolve()
        .then(load)
        .then((value) => {
          if (shouldCache(value)) {
            const resolvedTtlMs = normalizeTtlMs(
              typeof resolveTtlMs === "function"
                ? resolveTtlMs(value, effectiveTtlMs)
                : effectiveTtlMs,
              effectiveTtlMs,
            );
            entries.set(normalizedKey, {
              value,
              expiresAt: now() + resolvedTtlMs,
              promise: null,
            });
          } else {
            entries.delete(normalizedKey);
          }
          return value;
        })
        .catch((error) => {
          entries.delete(normalizedKey);
          throw error;
        });

      entries.set(normalizedKey, {
        value: undefined,
        expiresAt: 0,
        promise,
      });
      return await promise;
    },

    clear(key) {
      if (key === undefined) {
        entries.clear();
        return;
      }
      entries.delete(String(key ?? "").trim());
    },
  };
}
