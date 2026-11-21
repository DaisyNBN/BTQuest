/**
 * useTrip(from, to) — live tracker for "my ride" on the Red Line.
 *
 *   const trip = useTrip('DAV', 'SST');
 *   useEffect(() => trip.onArrive((stationId) => setPulled(pull(stationId))), [trip.onArrive]);
 *
 * Returns everything the Ride screen needs:
 *   from, to, direction, stops     – the plan (handles the Ashmont/Braintree branches)
 *   trainId, train                 – the train we think the rider is on
 *   nextStopId, secondsToNextStop  – counts down every second
 *   secondsToDestination
 *   stopsLeft, arrived
 *   source                         – how the train was picked: 'gps' | 'prediction' | 'none'
 *   loading, error, notice         – error = can't plan/fetch; notice = info for the rider
 *   onArrive(cb)                   – subscribe; returns an unsubscribe function
 *
 * HOW THE TRAIN IS PICKED (best guess — we can't know which train someone boarded):
 *   Only trains going the right way that are either on the trip's stops or
 *   still heading toward `from` count. Trains that don't reach `to` (e.g.
 *   short-turns to Broadway during a shuttle) are skipped when others exist.
 *   1. GPS: if we have a fix from the last 2 minutes, take the nearest such
 *      train within 600 m. A rider on a train moves with it, so this follows them.
 *   2. Fallback: the first train predicted to arrive at `from`.
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

import {
  getArrivals,
  getRedLineTrains,
  getTripPredictions,
  type Direction,
  type Train,
} from '@/api/mbta';
import { useDemoTrip } from '@/hooks/useDemoTrip';
import { useNow } from '@/hooks/useNow';
import { usePolling } from '@/hooks/usePolling';
import { distanceMeters, planTrip, stationsBefore, trainServesTrip, type TripPlan } from '@/lib/redLine';

const POLL_MS = 7_000;
const GPS_MAX_AGE_MS = 2 * 60_000;
const GPS_MAX_DISTANCE_M = 600;
const MAX_MISSED_POLLS = 3; // ~20 s without the locked train → pick again

/**
 * True when EXPO_PUBLIC_DEMO_MODE=1. Must be written as the full
 * `process.env.EXPO_PUBLIC_…` expression — Expo inlines it at build time.
 */
export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === '1';

export type TripSource = 'gps' | 'prediction' | 'demo' | 'none';

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
  source: TripSource;
  loading: boolean;
  error?: string;
  notice?: string;
  onArrive: (cb: (stationId: string) => void) => () => void;
};

// ─── Tracking state (per trip, kept in a ref between polls) ─────────────────

type Memory = {
  key: string;
  lockedId?: string;
  lockedSource: TripSource;
  lastTrain?: Train;    // last sighting of the locked train that had a station
  missed: number;
  fired: Set<string>;
  arrived: boolean;
};

type GpsFix = { lat: number; lng: number; timestamp: number };

type Snapshot = {
  train?: Train;
  source: TripSource;
  nextStopId?: string;
  nextStopTime?: Date;
  destinationTime?: Date;
  stopsLeft: number;
  arrived: boolean;
  notice?: string;
};

type Position = { reachedIdx: number; nextIdx: number; stopsLeft: number; past: boolean };

/**
 * Where a train is relative to the trip. `reachedIdx` = index in plan.stops of
 * the last station it has reached (-1 = hasn't reached `from` yet). Returns
 * null if the train isn't reporting a station.
 */
function locate(train: Train | undefined, plan: TripPlan, before: Set<string>): Position | null {
  if (!train?.stationId) return null;
  const last = plan.stops.length - 1;
  const k = plan.stops.indexOf(train.stationId);
  if (k === -1) {
    if (before.has(train.stationId)) return { reachedIdx: -1, nextIdx: 0, stopsLeft: last, past: false };
    // Not on the trip and not approaching → it has gone past the destination.
    return { reachedIdx: last, nextIdx: last, stopsLeft: 0, past: true };
  }
  if (train.status === 'STOPPED_AT') return { reachedIdx: k, nextIdx: k + 1, stopsLeft: last - k, past: false };
  // INCOMING_AT / IN_TRANSIT_TO station k: the stations before k are behind us.
  return { reachedIdx: k - 1, nextIdx: k, stopsLeft: Math.min(last, last - k + 1), past: false };
}

async function pickTrain(plan: TripPlan, pool: Train[], gps: GpsFix | null): Promise<{ train: Train; source: TripSource } | undefined> {
  if (pool.length === 0) return undefined;

  // 1. GPS — nearest train, if the fix is fresh and a train is close.
  if (gps && Date.now() - gps.timestamp < GPS_MAX_AGE_MS) {
    let best: Train | undefined;
    let bestDist = Infinity;
    for (const t of pool) {
      const d = distanceMeters(gps.lat, gps.lng, t.lat, t.lng);
      if (d < bestDist) { best = t; bestDist = d; }
    }
    if (best && bestDist <= GPS_MAX_DISTANCE_M) return { train: best, source: 'gps' };
  }

  // 2. Fallback — first train predicted at `from`, going our way.
  const arrivals = await getArrivals(plan.from);
  for (const a of arrivals) {
    if (a.direction !== plan.direction || !a.vehicleId) continue;
    const t = pool.find((x) => x.vehicleId === a.vehicleId);
    if (t) return { train: t, source: 'prediction' };
  }
  return undefined;
}

/** One poll: fetch trains, pick/follow the rider's train, fire arrivals. */
async function tick(plan: TripPlan, mem: Memory, gps: GpsFix | null, listeners: Set<(id: string) => void>): Promise<Snapshot> {
  const trains = await getRedLineTrains();
  const before = stationsBefore(plan.from, plan.direction);
  const last = plan.stops.length - 1;

  const candidates = trains.filter(
    (t) => t.direction === plan.direction && !!t.stationId && (plan.stops.includes(t.stationId) || before.has(t.stationId)),
  );
  const serving = candidates.filter((t) => trainServesTrip(t, plan));
  const pool = serving.length ? serving : candidates;

  let notice: string | undefined;
  if (candidates.length && !serving.length) {
    const ends = [...new Set(candidates.map((t) => t.headsign).filter(Boolean))].join(' / ');
    notice = `Trains are only running to ${ends || 'part of the line'} — check alerts for shuttle buses.`;
  }

  // Follow the locked train, tolerating a few missed polls.
  let train: Train | undefined;
  let source: TripSource = 'none';
  if (mem.lockedId) {
    train = trains.find((t) => t.vehicleId === mem.lockedId);
    if (train) {
      mem.missed = 0;
      if (train.stationId) mem.lastTrain = train;
    } else if (++mem.missed <= MAX_MISSED_POLLS) {
      train = mem.lastTrain;
    } else {
      mem.lockedId = undefined;
      mem.lastTrain = undefined;
    }
    if (train) source = mem.lockedSource;
  }

  if (!mem.lockedId) {
    const picked = await pickTrain(plan, pool, gps);
    train = picked?.train;
    source = picked?.source ?? 'none';
    const pos = locate(train, plan, before);
    if (train && pos) {
      const atOrAfterFrom = pos.reachedIdx >= 0 && !pos.past;
      if (atOrAfterFrom) {
        mem.lockedId = train.vehicleId;
        mem.lockedSource = source;
        mem.lastTrain = train;
        mem.missed = 0;
        // Don't award stations the train passed before we started tracking.
        for (let i = 1; i < (train.status === 'STOPPED_AT' ? pos.reachedIdx : pos.reachedIdx + 1); i++) {
          mem.fired.add(plan.stops[i]);
        }
      }
    }
  }

  if (!train) {
    return {
      source: 'none',
      stopsLeft: mem.arrived ? 0 : last,
      arrived: mem.arrived,
      notice: notice ?? (mem.arrived ? undefined : 'No trains heading your way right now.'),
    };
  }

  // If the train briefly reports no station, use its last known one.
  const pos: Position = locate(train, plan, before) ??
    locate(mem.lastTrain, plan, before) ?? { reachedIdx: -1, nextIdx: 0, stopsLeft: last, past: false };
  if (mem.lockedId && (pos.reachedIdx >= last || pos.past)) mem.arrived = true;

  // Fire onArrive for every newly reached station after `from`, in order.
  if (mem.lockedId) {
    const upTo = mem.arrived ? last : pos.reachedIdx;
    for (let i = 1; i <= upTo; i++) {
      const id = plan.stops[i];
      if (mem.fired.has(id)) continue;
      mem.fired.add(id);
      for (const cb of listeners) {
        try {
          cb(id);
        } catch (e) {
          console.warn('[useTrip] onArrive callback failed', e);
        }
      }
    }
  }

  if (mem.arrived) return { train, source, stopsLeft: 0, arrived: true };

  const nextStopId = plan.stops[pos.nextIdx];
  let nextStopTime: Date | undefined;
  let destinationTime: Date | undefined;
  if (train.tripId) {
    try {
      const etas = await getTripPredictions(train.tripId);
      nextStopTime = etas.find((e) => e.stationId === nextStopId)?.arrivalTime ?? undefined;
      destinationTime = etas.find((e) => e.stationId === plan.to)?.arrivalTime ?? undefined;
    } catch {
      // ETAs are nice-to-have; keep tracking without them.
    }
  }

  return { train, source, nextStopId, nextStopTime, destinationTime, stopsLeft: pos.stopsLeft, arrived: false, notice };
}

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
      memRef.current = { key, lockedSource: 'none', missed: 0, fired: new Set(), arrived: false };
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
    return { from, to, direction: 'south', stops: [], stopsLeft: 0, arrived: false, source: 'none', loading: false, error: plan.error, onArrive };
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
