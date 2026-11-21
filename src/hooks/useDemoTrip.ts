/**
 * useDemoTrip(from, to) — fake ride for demos (EXPO_PUBLIC_DEMO_MODE=1).
 *
 * Same return shape as the live useTrip, so screens don't know the difference.
 * No network, no GPS: a pretend train starts at `from` and reaches the next
 * stop every STEP_MS (20 s), firing onArrive at each one, until `to`.
 * Changing `from`/`to` restarts the ride.
 *
 * Don't import this directly — use `useTrip` from '@/hooks/useTrip', which
 * picks demo or live based on the env flag.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TripResult } from '@/hooks/useTrip';
import { planTrip } from '@/lib/redLine';

const STEP_MS = 20_000;

type DemoState = {
  key: string;              // which trip this state belongs to
  reachedIdx: number;       // index in stops of the last station reached
  secondsToNextStop?: number;
};

export function useDemoTrip(from: string, to: string): TripResult {
  const plan = useMemo(() => planTrip(from, to), [from, to]);
  const stops = 'error' in plan ? null : plan.stops;
  const key = `${from}>${to}`;

  const [demo, setDemo] = useState<DemoState | null>(null);
  const listenersRef = useRef(new Set<(stationId: string) => void>());

  // Run the fake train. All setState calls happen inside timer callbacks.
  useEffect(() => {
    if (!stops) return;
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
      setDemo({ key, reachedIdx, secondsToNextStop });
      if (reachedIdx >= last) clearInterval(interval);
    };

    const interval = setInterval(update, 1000);
    const first = setTimeout(update, 0);
    return () => {
      clearInterval(interval);
      clearTimeout(first);
    };
  }, [key, stops]);

  const onArrive = useCallback((cb: (stationId: string) => void) => {
    const listeners = listenersRef.current;
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  if ('error' in plan) {
    return { from, to, direction: 'south', stops: [], stopsLeft: 0, arrived: false, source: 'demo', loading: false, error: plan.error, onArrive };
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
    nextStopId: arrived ? undefined : plan.stops[reachedIdx + 1],
    secondsToNextStop: arrived ? undefined : cur?.secondsToNextStop ?? STEP_MS / 1000,
    secondsToDestination: arrived ? 0 : Math.max(0, (last - reachedIdx - 1) * (STEP_MS / 1000) + (cur?.secondsToNextStop ?? STEP_MS / 1000)),
    stopsLeft: last - reachedIdx,
    arrived,
    source: 'demo',
    loading: false,
    notice: 'Demo ride: a pretend train moves one stop every 20 s.',
    onArrive,
  };
}
