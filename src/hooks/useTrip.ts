/**
 * useTrip(from, to): live tracker for "my ride" on the Red Line.
 *
 *   const trip = useTrip('DAV', 'SST');
 *   useEffect(() => trip.onArrive((stationId) => setPulled(pull(stationId))), [trip.onArrive]);
 *
 * Returns everything the Ride screen needs:
 *   from, to, direction, stops: the plan (handles the Ashmont/Braintree branches)
 *   trainId, train: the train we think the rider is on
 *   nextStopId, secondsToNextStop: counts down every second
 *   secondsToDestination
 *   stopTimes: per-stop clock times (actual if passed, predicted if not)
 *   stopsLeft, arrived
 *   source: how the train was picked ('gps' | 'prediction' | 'nearest' | 'demo' | 'none')
 *   loading, error, notice: error = can't plan/fetch; notice = info for the rider
 *   onArrive(cb): subscribe; returns an unsubscribe function
 *
 * HOW THE TRAIN IS PICKED (best guess, since we can't know which train someone boarded):
 *   Only trains going the right way that are either on the trip's stops or
 *   still heading toward `from` count.
 *   1. GPS: if we have a fix from the last 2 minutes, take the nearest such
 *      train within 600 m. A rider on a train moves with it, so this follows them.
 *   2. Fallback: the first train predicted to arrive at `from`.
 *   3. Last resort (no prediction matches): the approaching train closest to `from`.
 *   In 2 and 3, trains that reach `to` win over short-turns, but a short-turn
 *   that's coming beats "no train" (we show a notice).
 *   Until the chosen train reaches `from`, we re-pick every poll (the rider
 *   might take a later train). Once it's at/after `from`, we lock onto it.
 *   If the locked train disappears from the feed for ~20 s, we pick again.
 *
 * onArrive(stationId) fires once per station after `from` when the locked
 * train is STOPPED_AT it. Stations passed while polling was paused (app in
 * background) fire when the app comes back, in order. Stations already
 * passed when we first lock on don't fire (no free cards for opening the
 * app mid-ride).
 *
 * Polls every 7 s while the screen is focused and the app is in the foreground.
 *
 * DEMO MODE: with EXPO_PUBLIC_DEMO_MODE=1 in .env, useTrip is the fake
 * useDemoTrip instead (pretend train, one stop every 20 s, no network/GPS).
 * Restart the dev server with `npx expo start -c` after changing .env.
 */
import { useIsFocused } from 'expo-router';
import * as Location from 'expo-location';
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

import type { Direction, Train } from '@/api/mbta';
import { useDemoTrip } from '@/hooks/useDemoTrip';
import { useNow } from '@/hooks/useNow';
import { usePolling } from '@/hooks/usePolling';
import { planTrip } from '@/lib/redLine';
import { newMemory, tick, type GpsFix, type Memory, type Snapshot, type TripSource } from '@/lib/tripTracker';

export type { TripSource } from '@/lib/tripTracker';

const POLL_MS = 7_000;

/**
 * True when EXPO_PUBLIC_DEMO_MODE=1. Must be written as the full
 * `process.env.EXPO_PUBLIC_…` expression, because Expo inlines it at build time.
 */
export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === '1';


export type Trip = {
  from: string;
  to: string;
  direction: Direction;
  stops: string[];
  trainId?: string;
  nextStopId?: string;
  secondsToNextStop?: number;
  stopsLeft: number;
  arrived: boolean;
};

export type TripResult = Trip & {
  train?: Train;
  secondsToDestination?: number;
  /** Per-stop times: actual for stations passed, predicted for upcoming ones. */
  stopTimes: Record<string, Date>;
  source: TripSource;
  loading: boolean;
  error?: string;
  notice?: string;
  onArrive: (cb: (stationId: string) => void) => () => void;
};

// ─── GPS ─────────────────────────────────────────────────────────────────────

/**
 * Latest GPS fix in a ref (read inside the poll, so updates don't re-render).
 * Asks for foreground location permission once; if denied we fall back to
 * predictions. Underground GPS is weak, so fixes older than 2 min are ignored.
 */
function useGpsRef(active: boolean): RefObject<GpsFix | null> {
  const ref = useRef<GpsFix | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let sub: Location.LocationSubscription | undefined;
    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted || cancelled) return;
      const s = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 25, timeInterval: 5_000 },
        (p) => {
          ref.current = { lat: p.coords.latitude, lng: p.coords.longitude, timestamp: p.timestamp };
        },
      );
      if (cancelled) s.remove();
      else sub = s;
    })().catch((e) => console.warn('[useTrip] location unavailable, using predictions', e));
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [active]);
  return ref;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

function useLiveTrip(from: string, to: string): TripResult {
  const plan = useMemo(() => planTrip(from, to), [from, to]);
  const planError = 'error' in plan ? plan.error : undefined;
  const key = `${from}>${to}`;

  const isFocused = useIsFocused();
  const gpsRef = useGpsRef(isFocused && !planError);
  const memRef = useRef<Memory | null>(null);
  const listenersRef = useRef(new Set<(stationId: string) => void>());

  const fetcher = useCallback(async (): Promise<Snapshot | null> => {
    if ('error' in plan) return null;
    if (!memRef.current || memRef.current.key !== key) {
      memRef.current = newMemory(key);
    }
    return tick(plan, memRef.current, gpsRef.current, listenersRef.current);
  }, [plan, key, gpsRef]);

  const { data, loading, error } = usePolling(fetcher, POLL_MS, key);
  const now = useNow(1000);

  const onArrive = useCallback((cb: (stationId: string) => void) => {
    const listeners = listenersRef.current;
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  if ('error' in plan) {
    return { from, to, direction: 'south', stops: [], stopsLeft: 0, arrived: false, stopTimes: {}, source: 'none', loading: false, error: plan.error, onArrive };
  }

  const secondsUntil = (d?: Date) => (d ? Math.max(0, Math.round((d.getTime() - now) / 1000)) : undefined);
  return {
    from,
    to,
    direction: plan.direction,
    stops: plan.stops,
    trainId: data?.train?.vehicleId,
    train: data?.train,
    nextStopId: data?.nextStopId,
    secondsToNextStop: secondsUntil(data?.nextStopTime),
    secondsToDestination: secondsUntil(data?.destinationTime),
    stopTimes: data?.stopTimes ?? {},
    stopsLeft: data?.stopsLeft ?? plan.stops.length - 1,
    arrived: data?.arrived ?? false,
    source: data?.source ?? 'none',
    loading,
    error,
    notice: data?.notice,
    onArrive,
  };
}

/**
 * The hook screens use. Picking the implementation once at module load is
 * safe for the rules of hooks: DEMO_MODE is a build-time constant, so every
 * render of every component always calls the same hook.
 */
export const useTrip: (from: string, to: string) => TripResult = DEMO_MODE ? useDemoTrip : useLiveTrip;
