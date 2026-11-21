/**
 * useArrivals(stationId) — upcoming Red Line trains at one station.
 *
 *   const { arrivals, loading, error } = useArrivals('KEN');   // optional 2nd arg: route (default 'Red')
 *
 * - `arrivals`: both directions, soonest first (see `Arrival` in @/api/mbta).
 *   Empty late at night or when shuttle buses replace trains.
 * - Polls every 12 s (MBTA predictions update about that often).
 * - Pauses when the screen is unfocused or the app is in the background.
 */
import { useCallback } from 'react';

import { getArrivals, type Arrival, type RouteId } from '@/api/mbta';
import { useNow } from '@/hooks/useNow';
import { usePolling } from '@/hooks/usePolling';

const POLL_MS = 12_000;

export function useArrivals(stationId: string, route: RouteId = 'Red'): {
  arrivals: Arrival[];
  loading: boolean;
  error?: string;
  refresh: () => void;
} {
  const fetcher = useCallback(() => getArrivals(stationId, route), [stationId, route]);
  const { data, loading, error, refresh } = usePolling(fetcher, POLL_MS, `${route}:${stationId}`);

  // Count `secondsAway` down every second between polls so timers look live.
  const now = useNow(1000);
  const arrivals = (data ?? []).map((a) =>
    a.arrivalTime ? { ...a, secondsAway: Math.max(0, Math.round((a.arrivalTime.getTime() - now) / 1000)) } : a,
  );

  return { arrivals, loading, error, refresh };
}

