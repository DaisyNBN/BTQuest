/**
 * Red Line geometry: stop order, direction and branches. Pure logic, no React or network.
 *
 * The Red Line is a "Y":
 *
 *   Alewife … JFK/UMass ─┬─ Savin Hill … Ashmont        (branch: 'ashmont')
 *       (trunk)          └─ North Quincy … Braintree    (branch: 'braintree')
 *
 * STATIONS in data/stations.ts lists the trunk north → south, then each
 * branch going outward from JFK/UMass. Southbound = toward the branches.
 */
import type { Direction, Train } from '@/api/mbta';
import { STATIONS, stationById } from '@/data/stations';

type Branch = 'ashmont' | 'braintree';

const TRUNK = STATIONS.filter((s) => !s.branch).map((s) => s.id);           // ALE … JFK
const BRANCH: Record<Branch, string[]> = {
  ashmont: STATIONS.filter((s) => s.branch === 'ashmont').map((s) => s.id),   // SAV … ASH
  braintree: STATIONS.filter((s) => s.branch === 'braintree').map((s) => s.id), // NQU … BRA
};

/** All stations from Alewife to the end of one branch, in southbound order. */
function southboundLine(branch: Branch): string[] {
  return [...TRUNK, ...BRANCH[branch]];
}

export type TripPlan = {
  from: string;
  to: string;
  direction: Direction;
  /** App station ids from `from` to `to` inclusive, in travel order. */
  stops: string[];
};

/**
 * Work out the stops between two stations.
 * Fails for the same station twice, unknown ids, and Ashmont-branch ↔
 * Braintree-branch trips (those need a change of train at JFK/UMass).
 */
export function planTrip(from: string, to: string): TripPlan | { error: string } {
  const a = stationById(from);
  const b = stationById(to);
  if (!a || !b) return { error: `Unknown station '${!a ? from : to}'` };
  if (a.id === b.id) return { error: 'Pick two different stations' };
  if (a.branch && b.branch && a.branch !== b.branch) {
    return { error: `${a.name} → ${b.name} needs a change of train at JFK/UMass` };
  }

  // Both on the trunk → either branch's line works for the slice.
  const line = southboundLine(a.branch ?? b.branch ?? 'ashmont');
  const ia = line.indexOf(a.id);
  const ib = line.indexOf(b.id);
  return ia < ib
    ? { from, to, direction: 'south', stops: line.slice(ia, ib + 1) }
    : { from, to, direction: 'north', stops: line.slice(ib, ia + 1).reverse() };
}

/**
 * Stations a train passes *before* reaching `from` when travelling in
 * `direction`. A train whose current/next station is in here is still
 * on its way to pick the rider up.
 */
export function stationsBefore(from: string, direction: Direction): Set<string> {
  const st = stationById(from);
  if (!st) return new Set();
  if (direction === 'south') {
    const line = southboundLine(st.branch ?? 'ashmont');
    return new Set(line.slice(0, line.indexOf(from)));
  }
  // Northbound: everything further south. From the trunk, that includes both branches.
  if (st.branch) {
    const br = BRANCH[st.branch];
    return new Set(br.slice(br.indexOf(from) + 1));
  }
  return new Set([...TRUNK.slice(TRUNK.indexOf(from) + 1), ...BRANCH.ashmont, ...BRANCH.braintree]);
}

/**
 * Will this train still stop at `stationId`? Uses the headsign (= the trip's
 * last stop): e.g. during a shuttle, a northbound 'JFK/UMass' train never
 * reaches South Station and a southbound 'Broadway' train never reaches Quincy.
 * Unknown/missing headsigns are assumed to be fine.
 */
export function trainReaches(train: Train, stationId: string): boolean {
  const terminal = STATIONS.find((s) => s.name === train.headsign);
  if (!terminal || terminal.id === stationId) return true;
  const rest = planTrip(stationId, terminal.id); // stationId → terminal must be in the train's direction
  return !('error' in rest) && rest.direction === train.direction;
}

/** Right direction, and the train gets all the way to the rider's destination. */
export function trainServesTrip(train: Train, plan: TripPlan): boolean {
  return train.direction === plan.direction && trainReaches(train, plan.to);
}

/** Straight-line distance in metres between two lat/lng points. */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
