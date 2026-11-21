/**
 * MBTA V3 API client (Red Line today, written to take any route).
 *
 * Everything that knows about the MBTA's JSON:API format lives in this file.
 * The rest of the app only sees the plain types exported below
 * (Arrival, Train, Alert) and app station ids like 'KEN'.
 *
 *   getArrivals('KEN')    → upcoming trains at a station, soonest first
 *   getRedLineTrains()    → every Red Line train with its position
 *   getRedLineAlerts()    → service alerts active right now
 *
 * Each function takes an optional `route` (default 'Red'). To add another
 * line later: add its stations to data/stations.ts and its direction ids to
 * ROUTE_DIRECTIONS below. Nothing else in this file is Red-specific.
 *
 * API key: EXPO_PUBLIC_MBTA_API_KEY in .env (sent as the `x-api-key` header).
 * With a key the limit is 1,000 requests/minute; without one it's 20/minute.
 *
 * Docs: https://api-v3.mbta.com/docs/swagger/index.html
 */
import { stationByMbtaId, stationById } from '@/data/stations';

const BASE_URL = 'https://api-v3.mbta.com';
const API_KEY = process.env.EXPO_PUBLIC_MBTA_API_KEY;
const TIMEOUT_MS = 10_000;

// ─── Public types ────────────────────────────────────────────────────────────

/** south = toward Ashmont/Braintree, north = toward Alewife (Red Line meaning). */
export type Direction = 'south' | 'north';

/** MBTA route id. Only 'Red' has app station data so far. */
export type RouteId = 'Red';
const DEFAULT_ROUTE: RouteId = 'Red';

export type Arrival = {
  stationId: string;        // app id, e.g. 'KEN'
  direction: Direction;
  headsign: string;         // where the train is going: 'Ashmont' | 'Braintree' | 'Alewife' (or a short-turn like 'Broadway')
  arrivalTime: Date | null;
  secondsAway: number | null;
  status?: string;          // MBTA free-text status if present, e.g. 'Stopped 1 stop away'
  vehicleId?: string;
};

export type TrainStatus = 'INCOMING_AT' | 'STOPPED_AT' | 'IN_TRANSIT_TO';

export type Train = {
  vehicleId: string;
  lat: number;
  lng: number;
  bearing: number;          // degrees, 0 = north, clockwise
  direction: Direction;
  status: TrainStatus;
  stationId?: string;       // app id of the current/next station (mapped from the platform id)
  headsign?: string;
};

export type Alert = {
  id: string;
  header: string;
  effect: string;           // e.g. 'SHUTTLE', 'DELAY', 'SUSPENSION', 'STATION_ISSUE'
  severity: number;         // 0 (minor) … 10 (severe)
};

export class MbtaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MbtaError';
  }
}

// ─── Low-level request ───────────────────────────────────────────────────────

let warnedNoKey = false;

/**
 * GET an MBTA endpoint. `params` are added as the query string
 * (e.g. { 'filter[route]': 'Red', include: 'trip' }).
 * Throws MbtaError with a readable message on network errors and non-200s.
 */
export async function mbtaGet<T = unknown>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}${query ? `?${query}` : ''}`;

  const headers: Record<string, string> = { Accept: 'application/vnd.api+json' };
  if (API_KEY) {
    headers['x-api-key'] = API_KEY;
  } else if (!warnedNoKey) {
    warnedNoKey = true;
    console.warn('[mbta] EXPO_PUBLIC_MBTA_API_KEY is not set — limited to 20 requests/minute.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'AbortError';
    throw new MbtaError(timedOut ? 'MBTA request timed out' : `Can't reach the MBTA (${String(e)})`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 429) throw new MbtaError('MBTA rate limit hit — try again in a minute', 429);
    if (res.status === 403) throw new MbtaError('MBTA API key was rejected — check EXPO_PUBLIC_MBTA_API_KEY', 403);
    let detail = '';
    try {
      const body = (await res.json()) as { errors?: { detail?: string; code?: string }[] };
      detail = body.errors?.[0]?.detail ?? body.errors?.[0]?.code ?? '';
    } catch {
      // body wasn't JSON — the status code is enough
    }
    throw new MbtaError(`MBTA request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, res.status);
  }

  return (await res.json()) as T;
}

// ─── JSON:API shapes (internal only) ─────────────────────────────────────────

type Ref = { id: string; type: string };
type Relationship = { data: Ref | Ref[] | null };
type Resource<A> = {
  id: string;
  type: string;
  attributes: A;
  relationships?: Record<string, Relationship>;
};
type Doc<A> = { data: Resource<A>[]; included?: Resource<Record<string, unknown>>[] };

type StopAttrs = { name: string; location_type: number };
type PredictionAttrs = {
  arrival_time: string | null;
  departure_time: string | null;
  direction_id: 0 | 1;
  schedule_relationship: string | null; // null = normal, 'ADDED', 'CANCELLED', 'SKIPPED', 'NO_DATA'
  status: string | null;
  trip_headsign?: string | null;
};
type VehicleAttrs = {
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  current_status: TrainStatus;
  direction_id: 0 | 1;
};
type AlertAttrs = { header: string; effect: string; severity: number };

/** Id of a single (to-one) relationship, or undefined. */
function relId(r: Resource<unknown>, name: string): string | undefined {
  const data = r.relationships?.[name]?.data;
  return data && !Array.isArray(data) ? data.id : undefined;
}

/**
 * What direction_id 0 and 1 mean on each route. Always confirm a new line with
 * GET /routes/<id> (direction_names / direction_destinations).
 * Red: direction_names = ["South", "North"],
 *      direction_destinations = ["Ashmont/Braintree", "Alewife"].
 */
const ROUTE_DIRECTIONS: Record<RouteId, [Direction, Direction]> = {
  Red: ['south', 'north'],
};

function toDirection(directionId: 0 | 1, route: RouteId): Direction {
  return ROUTE_DIRECTIONS[route][directionId];
}

/** Direction → the headsign to show when the API doesn't give one. */
function fallbackHeadsign(directionId: 0 | 1, route: RouteId): string {
  return ROUTE_DIRECTIONS[route][directionId] === 'south' ? 'Ashmont/Braintree' : 'Alewife';
}

/** Map trip id → headsign from a response's `included` trips. */
function headsignsByTrip(doc: Doc<unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of doc.included ?? []) {
    if (r.type === 'trip' && typeof r.attributes.headsign === 'string') map.set(r.id, r.attributes.headsign);
  }
  return map;
}

// ─── Platform id → station lookup ────────────────────────────────────────────
//
// Vehicles and predictions point at *platform* stop ids (e.g. '70071' =
// Kendall/MIT southbound), not the parent 'place-…' ids we store in
// stations.ts. We fetch every Red Line parent station with its child stops
// once, and cache a map of child id → app station id.

const lookupCache = new Map<RouteId, Promise<Map<string, string>>>();

async function loadStationLookup(route: RouteId): Promise<Map<string, string>> {
  const doc = await mbtaGet<Doc<StopAttrs>>('/stops', {
    'filter[route]': route,
    include: 'child_stops',
    'fields[stop]': 'name,location_type',
  });

  const lookup = new Map<string, string>();
  for (const parent of doc.data) {
    const station = stationByMbtaId(parent.id);
    if (!station) continue;
    lookup.set(parent.id, station.id);
    const children = parent.relationships?.child_stops?.data;
    if (Array.isArray(children)) {
      for (const child of children) lookup.set(child.id, station.id);
    }
  }
  return lookup;
}

/** Cached child-stop-id → app station id map. Retries on the next call if loading failed. */
export function getStationLookup(route: RouteId = DEFAULT_ROUTE): Promise<Map<string, string>> {
  let promise = lookupCache.get(route);
  if (!promise) {
    promise = loadStationLookup(route).catch((e) => {
      lookupCache.delete(route);
      throw e;
    });
    lookupCache.set(route, promise);
  }
  return promise;
}

/** App station id for any MBTA stop id (platform or parent), if it's a Red Line station. */
export async function stationIdForStop(stopId: string, route: RouteId = DEFAULT_ROUTE): Promise<string | undefined> {
  const lookup = await getStationLookup(route);
  return lookup.get(stopId) ?? stationByMbtaId(stopId)?.id;
}

// ─── Public functions ────────────────────────────────────────────────────────

/**
 * Upcoming Red Line trains at a station (both directions), soonest first.
 * Cancelled/skipped trips and trains that already left are removed.
 * Returns [] late at night or when shuttle buses replace trains.
 */
export async function getArrivals(stationId: string, route: RouteId = DEFAULT_ROUTE): Promise<Arrival[]> {
  const station = stationById(stationId);
  if (!station) throw new MbtaError(`Unknown station id '${stationId}'`);

  const doc = await mbtaGet<Doc<PredictionAttrs>>('/predictions', {
    'filter[stop]': station.mbtaId,
    'filter[route]': route,
    include: 'trip',
    sort: 'arrival_time',
  });
  const headsigns = headsignsByTrip(doc);
  const now = Date.now();

  const arrivals: Arrival[] = [];
  for (const p of doc.data) {
    const a = p.attributes;
    if (a.schedule_relationship === 'CANCELLED' || a.schedule_relationship === 'SKIPPED') continue;

    // At the first stop of a trip there's no arrival_time, only a departure_time.
    const timeStr = a.arrival_time ?? a.departure_time;
    if (!timeStr && !a.status) continue; // no time and no status → nothing useful to show

    // Drop trains that have already left the platform.
    if (a.departure_time && Date.parse(a.departure_time) < now) continue;

    const arrivalTime = timeStr ? new Date(timeStr) : null;
    const tripId = relId(p, 'trip');
    arrivals.push({
      stationId: station.id,
      direction: toDirection(a.direction_id, route),
      headsign: a.trip_headsign ?? (tripId ? headsigns.get(tripId) : undefined) ?? fallbackHeadsign(a.direction_id, route),
      arrivalTime,
      secondsAway: arrivalTime ? Math.max(0, Math.round((arrivalTime.getTime() - now) / 1000)) : null,
      status: a.status ?? undefined,
      vehicleId: relId(p, 'vehicle'),
    });
  }

  // The API sorts nulls first; put trains with a time first, soonest first.
  arrivals.sort((x, y) => (x.secondsAway ?? Infinity) - (y.secondsAway ?? Infinity));
  return arrivals;
}

/** Every train on the route currently reporting a position. Returns [] when none are running. */
export async function getRedLineTrains(route: RouteId = DEFAULT_ROUTE): Promise<Train[]> {
  const [doc, lookup] = await Promise.all([
    mbtaGet<Doc<VehicleAttrs>>('/vehicles', {
      'filter[route]': route,
      include: 'trip',
    }),
    getStationLookup(route),
  ]);
  const headsigns = headsignsByTrip(doc);

  const trains: Train[] = [];
  for (const v of doc.data) {
    const a = v.attributes;
    if (a.latitude == null || a.longitude == null) continue;
    const stopId = relId(v, 'stop');
    const tripId = relId(v, 'trip');
    trains.push({
      vehicleId: v.id,
      lat: a.latitude,
      lng: a.longitude,
      bearing: a.bearing ?? 0,
      direction: toDirection(a.direction_id, route),
      status: a.current_status,
      stationId: stopId ? lookup.get(stopId) ?? stationByMbtaId(stopId)?.id : undefined,
      headsign: tripId ? headsigns.get(tripId) : undefined,
    });
  }
  return trains;
}

/** Alerts active right now on the route, most severe first. */
export async function getRedLineAlerts(route: RouteId = DEFAULT_ROUTE): Promise<Alert[]> {
  const doc = await mbtaGet<Doc<AlertAttrs>>('/alerts', {
    'filter[route]': route,
    'filter[datetime]': 'NOW',
    'fields[alert]': 'header,effect,severity',
  });
  return doc.data
    .map((r) => ({ id: r.id, header: r.attributes.header, effect: r.attributes.effect, severity: r.attributes.severity }))
    .sort((x, y) => y.severity - x.severity);
}
