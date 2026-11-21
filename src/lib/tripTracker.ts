/**
 * Trip tracking core used by useTrip. Plain TypeScript (no React/Expo), so it
 * can be tested from a terminal. One `tick()` = one poll: fetch trains,
 * pick/follow the rider's train, fire onArrive, return a Snapshot.
 * The picking rules are documented at the top of src/hooks/useTrip.ts.
 */
import { getArrivals, getRedLineTrains, getTripPredictions, type Train } from '@/api/mbta';
import { STATION_COORDS } from '@/data/redLineMap';
import { stationById } from '@/data/stations';
import { distanceMeters, stationsBefore, trainReaches, trainServesTrip, type TripPlan } from '@/lib/redLine';

const GPS_MAX_AGE_MS = 2 * 60_000;
const GPS_MAX_DISTANCE_M = 600;
const MAX_MISSED_POLLS = 3; // ~20 s without the locked train → pick again

export type TripSource = 'gps' | 'prediction' | 'nearest' | 'demo' | 'none';

/** Tracking state for one trip, kept between polls (useTrip holds it in a ref). */
export type Memory = {
  key: string;
  lockedId?: string;
  lockedSource: TripSource;
  lastTrain?: Train;    // last sighting of the locked train that had a station
  missed: number;
  fired: Set<string>;
  passedAt: Record<string, Date>; // when we saw the train reach each station
  arrived: boolean;
};

export type GpsFix = { lat: number; lng: number; timestamp: number };

export type Snapshot = {
  train?: Train;
  source: TripSource;
  nextStopId?: string;
  nextStopTime?: Date;
  destinationTime?: Date;
  /** Per-stop times: actual for stations passed, predicted for upcoming ones. */
  stopTimes: Record<string, Date>;
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

/**
 * Choose the rider's train (see "HOW THE TRAIN IS PICKED" at the top).
 * `candidates` = right direction, approaching `from` or already on the trip.
 * `approaching` = the subset that hasn't reached `from` yet (or is boarding there).
 */
async function pickTrain(
  plan: TripPlan,
  candidates: Train[],
  approaching: Train[],
  gps: GpsFix | null,
): Promise<{ train: Train; source: TripSource } | undefined> {
  if (candidates.length === 0) return undefined;
  // Among approaching trains, prefer ones that actually reach `to`, but only
  // within that group, so a short-turn that's coming beats nothing at all.
  const serving = approaching.filter((t) => trainServesTrip(t, plan));
  const boardable = serving.length ? serving : approaching;

  // 1. GPS: nearest train of any candidate (the rider may already be on one).
  if (gps && Date.now() - gps.timestamp < GPS_MAX_AGE_MS) {
    const best = nearest(candidates, gps.lat, gps.lng);
    if (best && best.dist <= GPS_MAX_DISTANCE_M) return { train: best.train, source: 'gps' };
  }

  // 2. First train predicted at `from`, going our way.
  const arrivals = await getArrivals(plan.from);
  for (const a of arrivals) {
    if (a.direction !== plan.direction || !a.vehicleId) continue;
    const t = boardable.find((x) => x.vehicleId === a.vehicleId);
    if (t) return { train: t, source: 'prediction' };
  }

  // 3. No usable prediction: the approaching train physically closest to `from`.
  const here = STATION_COORDS[plan.from];
  const best = here ? nearest(boardable, here.latitude, here.longitude) : undefined;
  return best ? { train: best.train, source: 'nearest' } : undefined;
}

function nearest(trains: Train[], lat: number, lng: number): { train: Train; dist: number } | undefined {
  let best: { train: Train; dist: number } | undefined;
  for (const t of trains) {
    const dist = distanceMeters(lat, lng, t.lat, t.lng);
    if (!best || dist < best.dist) best = { train: t, dist };
  }
  return best;
}

/** One poll: fetch trains, pick/follow the rider's train, fire arrivals. */
export async function tick(plan: TripPlan, mem: Memory, gps: GpsFix | null, listeners: Set<(id: string) => void>): Promise<Snapshot> {
  const trains = await getRedLineTrains();
  const before = stationsBefore(plan.from, plan.direction);
  const last = plan.stops.length - 1;

  const candidates = trains.filter(
    (t) => t.direction === plan.direction && !!t.stationId && (plan.stops.includes(t.stationId) || before.has(t.stationId)),
  );
  // Still to come at `from`, and actually going to stop there (not a short-turn that ends first).
  const approaching = candidates.filter(
    (t) => (before.has(t.stationId!) || t.stationId === plan.from) && trainReaches(t, plan.from),
  );

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
    const picked = await pickTrain(plan, candidates, approaching, gps);
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

  // Tell the rider about things the countdown alone can't explain.
  let notice: string | undefined;
  if (train && !mem.arrived) {
    const pos0 = locate(train, plan, before);
    if (!trainServesTrip(train, plan)) {
      notice = `This train ends at ${train.headsign ?? 'an earlier stop'}. Check alerts for shuttle buses to ${stationById(plan.to)?.name ?? plan.to}.`;
    } else if (pos0 && pos0.reachedIdx === -1 && train.status === 'STOPPED_AT') {
      // Trains waiting at a terminal keep getting their departure pushed back,
      // so the countdown can jump up. Say so instead of looking broken.
      notice = `Train is waiting at ${stationById(train.stationId ?? '')?.name ?? 'a station'}. Times may shift until it leaves.`;
    }
  }

  if (!train) {
    return {
      source: 'none',
      stopTimes: { ...mem.passedAt },
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
      mem.passedAt[id] = new Date();
      for (const cb of listeners) {
        try {
          cb(id);
        } catch (e) {
          console.warn('[useTrip] onArrive callback failed', e);
        }
      }
    }
  }

  if (mem.arrived) return { train, source, stopsLeft: 0, arrived: true, stopTimes: { ...mem.passedAt } };

  const nextStopId = plan.stops[pos.nextIdx];
  let nextStopTime: Date | undefined;
  let destinationTime: Date | undefined;
  const stopTimes: Record<string, Date> = { ...mem.passedAt };
  if (train.tripId) {
    try {
      const etas = await getTripPredictions(train.tripId);
      for (const e of etas) {
        if (e.arrivalTime && plan.stops.includes(e.stationId) && !mem.passedAt[e.stationId]) stopTimes[e.stationId] = e.arrivalTime;
      }
      nextStopTime = etas.find((e) => e.stationId === nextStopId)?.arrivalTime ?? undefined;
      destinationTime = etas.find((e) => e.stationId === plan.to)?.arrivalTime ?? undefined;
    } catch {
      // ETAs are nice-to-have; keep tracking without them.
    }
  }

  return { train, source, nextStopId, nextStopTime, destinationTime, stopTimes, stopsLeft: pos.stopsLeft, arrived: false, notice };
}

/** Fresh tracking state for a trip. */
export function newMemory(key: string): Memory {
  return { key, lockedSource: 'none', missed: 0, fired: new Set(), passedAt: {}, arrived: false };
}
