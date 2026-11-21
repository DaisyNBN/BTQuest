import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as Speech from 'expo-speech';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';

import { askGemini } from '@/api/gemini';
import { BottomSheet } from '@/components/BottomSheet';
import { PullModal } from '@/components/PullModal';
import { RecenterButton, RideMap } from '@/components/RideMap';
import { TripPicker } from '@/components/TripPicker';
import { Kicker, T } from '@/components/ui';
import { stationById } from '@/data/stations';
import { useNow } from '@/hooks/useNow';
import { useRedLineAlerts } from '@/hooks/useRedLineAlerts';
import { useRedLineTrains } from '@/hooks/useRedLineTrains';
import { DEMO_MODE, useTrip } from '@/hooks/useTrip';
import { useGame, type OwnedCard } from '@/state/game';
import { font } from '@/theme/colors';
import { useAppTheme } from '@/theme/ThemeContext';

// RIDE tab: full-screen live map + draggable trip sheet.
//   Map:   your trip on the real track, your train, other live trains, mascot bubble.
//   Sheet: line + direction, minutes to next stop, next-stop card with
//          Text / Voice / Buzz announcements, and the stop timeline.
// Arriving at each station opens a stamp pack (pull). EXPO_PUBLIC_DEMO_MODE=1
// drives the same screen with a pretend train.

type Pulled = { card: OwnedCard; isNew: boolean };

const commas = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const clock = (d?: Date) => (d ? `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}` : '');

/** "toward …" text for the sheet header. */
function towardText(direction: 'south' | 'north', to: string) {
  if (direction === 'north') return 'Alewife';
  const branch = stationById(to)?.branch;
  return branch === 'ashmont' ? 'Ashmont' : branch === 'braintree' ? 'Braintree' : 'Ashmont / Braintree';
}

export default function Ride() {
  const { c, toggle, isDark } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [[from, to], setTrip] = useState<[string, string]>(['DAV', 'SST']);
  const [picking, setPicking] = useState(false);
  const trip = useTrip(from, to);
  const { trains } = useRedLineTrains();
  const { alerts } = useRedLineAlerts();
  const { pull, artFound, cards, points } = useGame();
  const now = useNow(1000);

  // Layout: measure the screen area so the sheet can size itself.
  const [areaH, setAreaH] = useState(0);
  const peek = Math.round(areaH * 0.5);
  const [fitSignal, setFitSignal] = useState(0);

  // ── Announcements: Text (banner) / Voice / Buzz ──
  const [announce, setAnnounce] = useState({ text: true, voice: true, buzz: true });
  const nextId = trip.arrived ? undefined : trip.nextStopId;
  const next = nextId ? stationById(nextId) : undefined;

  // Banner when the next stop changes ("adjust state when a value changes" pattern).
  const [prevNext, setPrevNext] = useState(nextId);
  const [banner, setBanner] = useState<{ text: string; until: number } | null>(null);
  if (nextId !== prevNext) {
    setPrevNext(nextId);
    if (nextId && announce.text) setBanner({ text: `Next stop: ${stationById(nextId)?.name}`, until: now + 5000 });
  }

  // Voice + buzz when the next stop changes. Settings via a ref so toggling
  // them doesn't re-announce.
  const announceRef = useRef(announce);
  useEffect(() => {
    announceRef.current = announce;
  });
  useEffect(() => {
    if (!nextId) return;
    const name = stationById(nextId)?.name;
    if (announceRef.current.voice) Speech.speak(`Next stop, ${name}.`);
    if (announceRef.current.buzz) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [nextId]);

  const speakNow = () => {
    if (!next) return;
    Speech.stop();
    Speech.speak(`Next stop, ${next.name}. ${next.mascot} is waiting for you.`);
  };

  // ── Arrivals → stamp packs (queued: several can arrive at once after backgrounding) ──
  const [queue, setQueue] = useState<Pulled[]>([]);
  const { onArrive } = trip;
  useEffect(
    () =>
      onArrive((stationId) => {
        const result = pull(stationId);
        setQueue((q) => [...q, result]);
      }),
    [onArrive, pull],
  );
  const pulled = queue[0] ?? null;

  // ── Gemini mascot greeting (tap the bubble on the map, or "Ask") ──
  const mascotId = trip.arrived ? to : nextId ?? from;
  const mascot = stationById(mascotId)!;
  const [greeting, setGreeting] = useState<{ id: string; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  async function askMascot() {
    if (asking) return;
    setAsking(true);
    const id = mascotId;
    try {
      const text = await askGemini(
        `You are ${mascot.mascot}, the cheerful mascot of ${mascot.name} station on the Boston Red Line. ` +
          'A rider is arriving. Greet them in 2 short, friendly sentences and mention one thing about the area.',
      );
      setGreeting({ id, text });
    } catch (e) {
      setGreeting({ id, text: 'Error: ' + String(e) });
    }
    setAsking(false);
  }

  // ── Derived trip numbers ──
  const last = trip.stops.length - 1;
  const reachedIdx = last - trip.stopsLeft; // stopsLeft counts stations still to reach
  const minsToNext = trip.secondsToNextStop != null ? Math.max(0, Math.round(trip.secondsToNextStop / 60)) : undefined;
  const bigAlert = alerts.find((a) => a.severity >= 5);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }} onLayout={(e) => setAreaH(e.nativeEvent.layout.height)}>
      <RideMap
        stops={trip.stops}
        reachedIdx={reachedIdx}
        nextStopId={nextId}
        riderTrain={trip.train}
        trains={DEMO_MODE ? [] : trains}
        callout={
          trip.arrived
            ? { stationId: to, title: `${mascot.mascot} says hi!`, subtitle: 'You made it · +10', onPress: askMascot }
            : next
              ? { stationId: next.id, title: `${next.mascot} is waiting`, subtitle: `+10 · ${minsToNext != null ? `${minsToNext} min` : 'soon'}`, onPress: askMascot }
              : undefined
        }
        topInset={insets.top}
        bottomInset={peek}
        fitSignal={fitSignal}
        showUserLocation={!DEMO_MODE}
      />

      {/* Top bar: trip, points, theme */}
      <View style={{ position: 'absolute', top: insets.top + 8, left: 14, right: 14, gap: 8 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change trip"
            onPress={() => setPicking(true)}
            style={[pillStyle(c), { flex: 1, gap: 8 }]}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.red }} />
            <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.black, fontSize: 16, color: c.text }}>
              {stationById(from)?.name} → {stationById(to)?.name}
            </Text>
          </Pressable>
          <Pressable
            accessibilityLabel={`${points} points`}
            style={[pillStyle(c), { gap: 6 }]}>
            <Text style={{ fontSize: 15, color: c.gold }}>★</Text>
            <Text style={{ fontFamily: font.black, fontSize: 16, color: c.goldInk }}>{commas(points)}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Switch light or dark mode" onPress={toggle} style={[pillStyle(c), { width: 48, paddingHorizontal: 0, justifyContent: 'center' }]}>
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={c.muted} strokeWidth={2.4} strokeLinecap="round">
              {isDark ? <><Circle cx={12} cy={12} r={4} /><Path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></> : <Path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />}
            </Svg>
          </Pressable>
        </View>
        {DEMO_MODE ? (
          <View style={{ alignSelf: 'flex-start', backgroundColor: c.goldTint, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ fontFamily: font.black, fontSize: 11, letterSpacing: 1, color: c.goldInk }}>DEMO RIDE</Text>
          </View>
        ) : null}
        {banner && now < banner.until ? (
          <View accessibilityLiveRegion="polite" style={{ alignSelf: 'center', backgroundColor: c.text, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 10 }}>
            <Text style={{ fontFamily: font.black, fontSize: 18, color: c.bg }}>{banner.text}</Text>
          </View>
        ) : null}
      </View>

      {areaH > 0 ? (
        <>
          <RecenterButton onPress={() => setFitSignal((n) => n + 1)} style={{ position: 'absolute', right: 14, bottom: peek + 14 }} />
          <BottomSheet
            key={areaH}
            peekHeight={peek}
            maxHeight={Math.round(areaH * 0.88)}
            header={
              <View style={{ paddingHorizontal: 18, paddingBottom: 12, gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: c.red, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontFamily: font.black, fontSize: 17, color: '#fff' }}>RL</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <T size={22} weight="black">Red Line</T>
                    <T size={14} color={c.muted}>
                      {trip.arrived ? 'You’ve arrived' : `toward ${towardText(trip.direction, to)} · ${trip.stopsLeft} stops left`}
                    </T>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ fontFamily: font.black, fontSize: 40, lineHeight: 44, color: c.red }}>
                      {trip.arrived ? '✓' : minsToNext == null ? '-' : minsToNext === 0 ? 'Now' : minsToNext}
                    </Text>
                    <T size={12} color={c.muted}>{trip.arrived ? 'arrived' : minsToNext === 0 ? 'arriving' : 'min to next'}</T>
                  </View>
                </View>
                {trip.error ? <T size={13} color={c.redInk}>{trip.error}</T> : null}
                {trip.notice ? <T size={13} color={c.muted}>{trip.notice}</T> : null}
              </View>
            }>
            {/* Next stop */}
            <View style={{ backgroundColor: c.blueTint, borderRadius: 22, padding: 16, gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Kicker color={c.blueInk}>{trip.arrived ? 'You’ve arrived' : 'Next stop'}</Kicker>
                  <T size={26} weight="black">{trip.arrived ? stationById(to)?.name : next?.name ?? '-'}</T>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Read the next stop aloud"
                  onPress={speakNow}
                  style={({ pressed }) => ({
                    width: 60, height: 60, borderRadius: 18, backgroundColor: c.blueBtn, alignItems: 'center', justifyContent: 'center',
                    borderBottomWidth: pressed ? 2 : 5, borderBottomColor: c.blueDeep,
                  })}>
                  <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <Path d="M4 9v6h4l5 4V5L8 9H4z" />
                    <Path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
                  </Svg>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(['text', 'voice', 'buzz'] as const).map((k) => {
                  const on = announce[k];
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: on }}
                      onPress={() => setAnnounce((a) => ({ ...a, [k]: !a[k] }))}
                      style={{ backgroundColor: on ? c.card : 'transparent', borderWidth: 2, borderColor: on ? c.card : c.line, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 5 }}>
                      <Text style={{ fontFamily: font.black, fontSize: 13, color: on ? c.text : c.muted }}>
                        {on ? '✓ ' : ''}{k === 'text' ? 'Text' : k === 'voice' ? 'Voice' : 'Buzz'}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {greeting?.id === mascotId ? <T size={15} style={{ lineHeight: 22 }}>{greeting.text}</T> : null}
              <Pressable accessibilityRole="button" onPress={askMascot} disabled={asking}>
                <Text style={{ fontFamily: font.black, fontSize: 14, color: c.blueInk }}>
                  {asking ? `Asking ${mascot.mascot}…` : `Say hi to ${mascot.mascot} →`}
                </Text>
              </Pressable>
            </View>

            {bigAlert ? (
              <View style={{ backgroundColor: c.goldTint, borderRadius: 18, padding: 14, gap: 4 }}>
                <Kicker color={c.goldInk}>Service alert</Kicker>
                <T size={14}>{bigAlert.header}</T>
              </View>
            ) : null}

            {/* Stop timeline */}
            <View>
              {trip.stops.map((id, i) => {
                const s = stationById(id)!;
                const passed = i <= reachedIdx;
                const isNext = id === nextId;
                const stamped = passed && cards.some((card) => card.stationId === id);
                const artToFind = !!s.art && !artFound[id];
                return (
                  <View key={id} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52 }}>
                    {/* rail + dot */}
                    <View style={{ width: 28, alignSelf: 'stretch', alignItems: 'center' }}>
                      <View style={{ position: 'absolute', top: i === 0 ? 26 : 0, bottom: i === last ? 26 : 0, width: 5, backgroundColor: passed ? c.red : c.red + '66' }} />
                      <View style={{ marginTop: isNext ? 15 : 18, width: isNext ? 22 : 16, height: isNext ? 22 : 16, borderRadius: 11, borderWidth: isNext ? 5 : 4, borderColor: c.red, backgroundColor: passed ? c.red : c.card }} />
                    </View>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, alignSelf: 'stretch', borderBottomWidth: i === last ? 0 : 1, borderBottomColor: c.line }}>
                      <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.black, fontSize: isNext ? 18 : 16, color: passed ? c.muted : c.text }}>{s.name}</Text>
                      {stamped ? <Tag label="Stamped" bg={c.redTint} fg={c.redInk} /> : null}
                      {artToFind ? <Tag label="Art ★" bg={c.goldTint} fg={c.goldInk} /> : null}
                      <Text style={{ width: 44, textAlign: 'right', fontFamily: font.heavy, fontSize: 14, color: c.muted }}>{clock(trip.stopTimes[id])}</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </BottomSheet>
        </>
      ) : null}

      <TripPicker
        visible={picking}
        onClose={() => setPicking(false)}
        onPick={(a, b) => {
          setTrip([a, b]);
          setPicking(false);
          setGreeting(null);
        }}
      />

      <PullModal
        card={pulled?.card ?? null}
        isNew={pulled?.isNew ?? false}
        canHunt={!!pulled && !!stationById(pulled.card.stationId)?.art && !artFound[pulled.card.stationId]}
        onHunt={() => { setQueue([]); router.navigate('/scan'); }}
        onClose={() => setQueue((q) => q.slice(1))}
      />
    </View>
  );
}

function Tag({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <View style={{ backgroundColor: bg, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 }}>
      <Text style={{ fontFamily: font.black, fontSize: 12, color: fg }}>{label}</Text>
    </View>
  );
}

function pillStyle(c: { card: string; line: string }) {
  return {
    flexDirection: 'row' as const, alignItems: 'center' as const, height: 48, paddingHorizontal: 14,
    borderRadius: 16, backgroundColor: c.card, borderWidth: 2, borderColor: c.line, borderBottomWidth: 4,
  };
}
