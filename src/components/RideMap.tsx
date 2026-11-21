// Full-screen live Red Line map for the Ride tab. Needs no API key in Expo Go.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, type LatLng, type MapStyleElement } from 'react-native-maps';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import type { Train } from '@/api/mbta';
import { Mascot } from '@/components/Mascot';
import { RED_LINE_SHAPE, STATION_COORDS } from '@/data/redLineMap';
import { STATIONS } from '@/data/stations';
import { font, type Palette } from '@/theme/colors';
import { useAppTheme } from '@/theme/ThemeContext';

type Callout = { stationId: string; title: string; subtitle: string; onPress?: () => void };

type Props = {
  stops: string[];
  reachedIdx: number;
  nextStopId?: string;
  riderTrain?: Train;
  trains?: Train[];
  callout?: Callout;
  topInset?: number;
  bottomInset?: number;
  fitSignal?: number;
  showUserLocation?: boolean;
};

const LABEL_W = 150;

export function RideMap({
  stops, reachedIdx, nextStopId, riderTrain, trains = [], callout,
  topInset = 0, bottomInset = 0, fitSignal = 0, showUserLocation = false,
}: Props) {
  const { c, isDark } = useAppTheme();
  const mapRef = useRef<MapView>(null);

  const tripCoords = useMemo(() => stops.map((id) => STATION_COORDS[id]).filter(Boolean), [stops]);
  const tripLine = useMemo(() => tripShape(stops), [stops]);
  const initialRegion = useMemo(() => regionAround(tripCoords.length ? tripCoords : Object.values(STATION_COORDS)), [tripCoords]);
  const mapStyle = useMemo(() => androidMapStyle(c), [c]);

  const progress: LatLng | undefined = riderTrain
    ? { latitude: riderTrain.lat, longitude: riderTrain.lng }
    : STATION_COORDS[stops[Math.max(0, reachedIdx)]];
  const splitAt = progress ? nearestIndex(tripLine, progress) : 0;
  const travelled = tripLine.slice(0, splitAt + 1);
  const toGo = tripLine.slice(splitAt);

  const fit = useCallback(() => {
    if (!tripCoords.length) return;
    mapRef.current?.fitToCoordinates(tripCoords, {
      edgePadding: { top: topInset + 70, right: 60, bottom: bottomInset + 30, left: 40 },
      animated: true,
    });
  }, [tripCoords, topInset, bottomInset]);

  useEffect(() => {
    fit();
  }, [fit, fitSignal]);

  const otherTrains = trains.filter((t) => t.vehicleId !== riderTrain?.vehicleId);
  const calloutCoord = callout ? STATION_COORDS[callout.stationId] : undefined;

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      initialRegion={initialRegion}
      onMapReady={fit}
      userInterfaceStyle={isDark ? 'dark' : 'light'}
      customMapStyle={Platform.OS === 'android' ? mapStyle : undefined}
      showsUserLocation={showUserLocation}
      showsMyLocationButton={false}
      showsPointsOfInterests={false}
      showsCompass={false}
      pitchEnabled={false}
      toolbarEnabled={false}>
      {[RED_LINE_SHAPE.trunk, RED_LINE_SHAPE.ashmont, RED_LINE_SHAPE.braintree].map((pts, i) => (
        <Polyline key={i} coordinates={pts} strokeColor={c.red + '55'} strokeWidth={5} lineCap="round" zIndex={1} />
      ))}
      <Polyline coordinates={toGo} strokeColor={c.red + 'AA'} strokeWidth={8} lineCap="round" zIndex={2} />
      <Polyline coordinates={travelled} strokeColor={c.red} strokeWidth={10} lineCap="round" zIndex={3} />

      {STATIONS.map((s) => {
        const coord = STATION_COORDS[s.id];
        if (!coord) return null;
        const i = stops.indexOf(s.id);
        const kind = s.id === nextStopId ? 'next' : i === -1 ? 'off' : i <= reachedIdx ? 'passed' : 'trip';
        return (
          <Marker
            // Remount when the look changes, since tracksViewChanges is off.
            key={`${s.id}-${kind}`}
            coordinate={coord}
            anchor={{ x: kind === 'off' ? 0.5 : 9 / LABEL_W, y: 0.5 }}
            tracksViewChanges={false}
            zIndex={kind === 'next' ? 8 : kind === 'off' ? 4 : 5}>
            {kind === 'off' ? (
              <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: c.red + '99', backgroundColor: c.card }} />
            ) : (
              <StationLabel name={s.name} kind={kind} c={c} />
            )}
          </Marker>
        );
      })}

      {otherTrains.map((t) => (
        <Marker key={t.vehicleId} coordinate={{ latitude: t.lat, longitude: t.lng }} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={6} title={t.headsign}>
          <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: c.redBtn, borderWidth: 2, borderColor: c.card, opacity: 0.8 }} />
        </Marker>
      ))}

      {riderTrain ? (
        <Marker
          key="rider"
          coordinate={{ latitude: riderTrain.lat, longitude: riderTrain.lng }}
          anchor={{ x: 0.5, y: 0.5 }}
          // Svg can render blank on Android with tracking off.
          tracksViewChanges
          zIndex={20}
          title="Your train">
          <TrainBadge c={c} />
        </Marker>
      ) : null}

      {callout && calloutCoord ? (
        <Marker
          key="callout"
          coordinate={calloutCoord}
          anchor={{ x: 0, y: 1 }}
          tracksViewChanges
          zIndex={30}
          onPress={callout.onPress}>
          <CalloutBubble callout={callout} c={c} />
        </Marker>
      ) : null}
    </MapView>
  );
}

function StationLabel({ name, kind, c }: { name: string; kind: 'next' | 'passed' | 'trip'; c: Palette }) {
  const size = kind === 'next' ? 18 : 14;
  return (
    <View style={{ width: LABEL_W, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View
        style={{
          width: size, height: size, borderRadius: size / 2, marginLeft: 9 - size / 2,
          backgroundColor: kind === 'passed' ? c.red : c.card,
          borderWidth: kind === 'next' ? 4 : 3,
          borderColor: c.red,
        }}
      />
      <Text
        numberOfLines={1}
        style={{
          flexShrink: 1,
          fontFamily: font.black,
          fontSize: kind === 'next' ? 13 : 12,
          color: kind === 'next' ? c.redInk : c.mapLabel,
          textShadowColor: c.bg,
          textShadowRadius: 4,
        }}>
        {name}
      </Text>
    </View>
  );
}

function TrainBadge({ c }: { c: Palette }) {
  return (
    <View style={{ width: 32, height: 32, borderRadius: 9, backgroundColor: c.redBtn, borderWidth: 3, borderColor: c.card, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <Rect x={5} y={3} width={14} height={14} rx={3} />
        <Path d="M5 11h14M9 21l-2-4M15 21l2-4" />
        <Circle cx={9} cy={14} r={0.6} fill="#fff" />
        <Circle cx={15} cy={14} r={0.6} fill="#fff" />
      </Svg>
    </View>
  );
}

function CalloutBubble({ callout, c }: { callout: Callout; c: Palette }) {
  return (
    <View style={{ paddingLeft: 16, paddingBottom: 16 }}>
      <View
        style={{
          flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 10,
          borderRadius: 16, backgroundColor: c.card, borderWidth: 2, borderColor: c.line, borderBottomWidth: 4,
        }}>
        <Mascot stationId={callout.stationId} size={36} />
        <View>
          <Text style={{ fontFamily: font.black, fontSize: 14, color: c.text }}>{callout.title}</Text>
          <Text style={{ fontFamily: font.heavy, fontSize: 12, color: c.redInk }}>{callout.subtitle}</Text>
        </View>
      </View>
    </View>
  );
}

export function RecenterButton({ onPress, style }: { onPress: () => void; style?: object }) {
  const { c } = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Recenter map on your trip"
      onPress={onPress}
      style={[{ width: 48, height: 48, borderRadius: 24, backgroundColor: c.card, borderWidth: 2, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }, style]}>
      <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={c.blueBtn} strokeWidth={2.4} strokeLinecap="round">
        <Circle cx={12} cy={12} r={5} />
        <Path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </Svg>
    </Pressable>
  );
}

function tripShape(stops: string[]): LatLng[] {
  if (stops.length < 2) return [];
  const branch = STATIONS.find((s) => stops.includes(s.id) && s.branch)?.branch ?? 'ashmont';
  // Branch arrays repeat the trunk's last point.
  const path = [...RED_LINE_SHAPE.trunk, ...RED_LINE_SHAPE[branch].slice(1)];
  const a = nearestIndex(path, STATION_COORDS[stops[0]]);
  const b = nearestIndex(path, STATION_COORDS[stops[stops.length - 1]]);
  const slice = path.slice(Math.min(a, b), Math.max(a, b) + 1);
  return a <= b ? slice : slice.reverse();
}

function nearestIndex(path: LatLng[], p: LatLng | undefined): number {
  if (!p) return 0;
  let best = 0;
  let bestD = Infinity;
  path.forEach((q, i) => {
    const d = (q.latitude - p.latitude) ** 2 + (q.longitude - p.longitude) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function regionAround(points: LatLng[]) {
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max(0.02, (maxLat - minLat) * 1.4),
    longitudeDelta: Math.max(0.02, (maxLng - minLng) * 1.4),
  };
}

function androidMapStyle(c: Palette): MapStyleElement[] {
  return [
    { elementType: 'geometry', stylers: [{ color: c.land }] },
    { elementType: 'labels.text.fill', stylers: [{ color: c.mapLabel }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: c.land }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: c.street }] },
    { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: c.water }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi.park', stylers: [{ visibility: 'on' }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: c.park }] },
    { featureType: 'poi.park', elementType: 'labels', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  ];
}
