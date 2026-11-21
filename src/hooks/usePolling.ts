/**
 * usePolling(fetcher, intervalMs, key): shared polling engine for the MBTA hooks.
 *
 * - Fetches right away, then again `intervalMs` after each request finishes
 *   (so slow responses never pile up).
 * - Pauses while the screen isn't focused (expo-router `useIsFocused`) or the
 *   app is in the background (`AppState`), and fetches fresh data as soon as
 *   it becomes active again. Saves battery and API quota.
 * - Keeps the last good data when a request fails, and reports `error`.
 * - Changing `key` (e.g. a different station) restarts polling and hides the
 *   previous key's data.
 *
 * `fetcher` must be stable (a module-level function or wrapped in useCallback),
 * otherwise polling restarts on every render.
 *
 * Returns { data, loading, error, refresh }. `loading` is true only until the
 * first response for the current key arrives.
 */
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export type PollingResult<T> = {
  data: T | undefined;
  loading: boolean;
  error?: string;
  refresh: () => void;
};

type Snapshot<T> = { key: string; data?: T; error?: string; settled: boolean };

export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, key = ''): PollingResult<T> {
  const isFocused = useIsFocused();
  const appState = useAppState();
  const active = isFocused && appState === 'active';

  // Results are tagged with the key they belong to, so a key change shows
  // "loading" immediately instead of the previous station's data.
  const [snap, setSnap] = useState<Snapshot<T>>({ key, settled: false });
  const [refreshCount, setRefreshCount] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const data = await fetcher();
        if (cancelled) return;
        setSnap({ key, data, settled: true });
      } catch (e) {
        if (cancelled) return;
        const error = e instanceof Error ? e.message : String(e);
        // Keep the last good data for this key.
        setSnap((prev) => ({ key, data: prev.key === key ? prev.data : undefined, error, settled: true }));
      }
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, fetcher, intervalMs, key, refreshCount]);

  const refresh = useCallback(() => setRefreshCount((n) => n + 1), []);
  const current = snap.key === key;
  return {
    data: current ? snap.data : undefined,
    loading: !current || !snap.settled,
    error: current ? snap.error : undefined,
    refresh,
  };
}

/** Current AppState ('active' | 'background' | 'inactive' …), kept up to date. */
function useAppState(): AppStateStatus {
  const [state, setState] = useState<AppStateStatus>((AppState.currentState ?? 'active') as AppStateStatus);
  useEffect(() => {
    const sub = AppState.addEventListener('change', setState);
    return () => sub.remove();
  }, []);
  return state;
}
