/**
 * useRedLineTrains() — every Red Line train with its live position.
 *
 *   const { trains, loading, error } = useRedLineTrains();   // optional arg: route (default 'Red')
 *
 * - `trains`: see `Train` in @/api/mbta (lat/lng, bearing, direction, status,
 *   current/next station). Empty when no trains are running.
 * - Polls every 7 s. Vehicle positions update more than once a second, but
 *   7 s is smooth enough for the map and light on battery/quota.
 * - Pauses when the screen is unfocused or the app is in the background.
 */
import { useCallback } from 'react';

import { getRedLineTrains, type RouteId, type Train } from '@/api/mbta';
import { usePolling } from '@/hooks/usePolling';

const POLL_MS = 7_000;

export function useRedLineTrains(route: RouteId = 'Red'): {
  trains: Train[];
  loading: boolean;
  error?: string;
  refresh: () => void;
} {
  const fetcher = useCallback(() => getRedLineTrains(route), [route]);
  const { data, loading, error, refresh } = usePolling(fetcher, POLL_MS, route);
  return { trains: data ?? [], loading, error, refresh };
}
