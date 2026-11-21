/**
 * useDemoTrip(from, to): fake ride for demos (EXPO_PUBLIC_DEMO_MODE=1).
 *
 * Same return shape as the live useTrip, so screens don't know the difference.
 * No network, no GPS: a pretend train starts at `from` and reaches the next
 * stop every STEP_MS (20 s), firing onArrive at each one, until `to`.
 * Changing `from`/`to` restarts the ride. The fake `train` glides between
 * station coordinates so the map has something to show.
 *
 * Don't import this directly. Use `useTrip` from '@/hooks/useTrip', which
 * picks demo or live based on the env flag.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Train } from '@/api/mbta';
import { STATION_COORDS } from '@/data/redLineMap';
import type { TripResult } from '@/hooks/useTrip';
import { planTrip } from '@/lib/redLine';

const STEP_MS = 20_000;

type DemoState = {
  key: string;              // which trip this state belongs to
  reachedIdx: number;       // index in stops of the last station reached
  secondsToNextStop?: number;
  train?: Train;            // fake position for the map
  startedAt: number;        // ms; stop i is reached at startedAt + i * STEP_MS
};

/** Fake train between stops[i] and stops[i+1], `t` = 0…1 of the way there. */
function demoTrain(stops: string[], i: number, t: number, direction: Train['direction']): Train | undefined {
  const a = STATION_COORDS[stops[i]];
  const b = STATION_COORDS[stops[Math.min(i + 1, stops.length - 1)]];
  if (!a || !b) return undefined;
  const atStation = i >= stops.length - 1 || t < 0.15; // dwell for the first ~3 s at each stop
  const k = atStation ? 0 : (t - 0.15) / 0.85;
  const bearing = (Math.atan2(b.longitude - a.longitude, b.latitude - a.latitude) * 180) / Math.PI;
  return {
    vehicleId: 'DEMO',
    lat: a.latitude + (b.latitude - a.latitude) * k,
    lng: a.longitude + (b.longitude - a.longitude) * k,
    bearing: (bearing + 360) % 360,
    direction,
    status: atStation ? 'STOPPED_AT' : 'IN_TRANSIT_TO',
    stationId: atStation ? stops[i] : stops[i + 1],
    headsign: 'Demo',
  };
}

export function useDemoTrip(from: string, to: string): TripResult {
  const plan = useMemo(() => planTrip(from, to), [from, to]);
  const stops = 'error' in plan ? null : plan.stops;
  const key = `${from}>${to}`;

  const [demo, setDemo] = useState<DemoState | null>(null);
  const listenersRef = useRef(new Set<(stationId: string) => void>());

  // Run the fake train. All setState calls happen inside timer callbacks.
  useEffect(() => {
    if (!stops || 'error' in plan) return;
    const direction = plan.direction;
    const last = stops.length - 1;
    const startedAt = Date.now();
    const fired = new Set<string>();

    const update = () => {
      const elapsed = Date.now() - startedAt;
      const reachedIdx = Math.min(last, Math.floor(elapsed / STEP_MS));

      // Fire once per station after `from`, in order.
      for (let i = 1; i <= reachedIdx; i++) {
        const id = stops[i];
        if (fired.has(id)) continue;
        fired.add(id);
        for (const cb of listenersRef.current) {
          try {
            cb(id);
          } catch (e) {
            console.warn('[useDemoTrip] onArrive callback failed', e);
          }
        }
      }

      const secondsToNextStop =
        reachedIdx >= last ? undefined : Math.max(0, Math.ceil(((reachedIdx + 1) * STEP_MS - elapsed) / 1000));
      const train = demoTrain(stops, reachedIdx, (elapsed % STEP_MS) / STEP_MS, direction);
      setDemo({ key, reachedIdx, secondsToNextStop, train, startedAt });
      if (reachedIdx >= last) clearInterval(interval);
    };

    const interval = setInterval(update, 1000);
    const first = setTimeout(update, 0);
    return () => {
      clearInterval(interval);
      clearTimeout(first);
    };
  }, [key, stops, plan]);

  const onArrive = useCallback((cb: (stationId: string) => void) => {
    const listeners = listenersRef.current;
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  if ('error' in plan) {
    return { from, to, direction: 'south', stops: [], stopsLeft: 0, arrived: false, stopTimes: {}, source: 'demo', loading: false, error: plan.error, onArrive };
  }

  // Ignore state left over from a previous trip until the new one ticks.
  const cur = demo?.key === key ? demo : null;
  const reachedIdx = cur?.reachedIdx ?? 0;
  const last = plan.stops.length - 1;
  const arrived = reachedIdx >= last;

  return {
    from,
    to,
    direction: plan.direction,
    stops: plan.stops,
    trainId: 'DEMO',
    train: cur?.train,
    nextStopId: arrived ? undefined : plan.stops[reachedIdx + 1],
    secondsToNextStop: arrived ? undefined : cur?.secondsToNextStop ?? STEP_MS / 1000,
    secondsToDestination: arrived ? 0 : Math.max(0, (last - reachedIdx - 1) * (STEP_MS / 1000) + (cur?.secondsToNextStop ?? STEP_MS / 1000)),
    // The fake schedule is exact, so passed and upcoming times come from the same formula.
    stopTimes: cur ? Object.fromEntries(plan.stops.map((id, i) => [id, new Date(cur.startedAt + i * STEP_MS)])) : {},
    stopsLeft: last - reachedIdx,
    arrived,
    source: 'demo',
    loading: false,
    notice: 'Demo ride: a pretend train moves one stop every 20 s.',
    onArrive,
  };
}
