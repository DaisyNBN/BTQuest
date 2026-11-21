/**
 * TripPicker: modal to choose a ride. Pick "From", then "To".
 * Only destinations reachable without changing trains are listed
 * (no Ashmont-branch ↔ Braintree-branch trips).
 */
import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { STATIONS, stationById } from '@/data/stations';
import { planTrip } from '@/lib/redLine';
import { font } from '@/theme/colors';
import { useAppTheme } from '@/theme/ThemeContext';

type Props = {
  visible: boolean;
  onPick: (from: string, to: string) => void;
  onClose: () => void;
};

export function TripPicker({ visible, onPick, onClose }: Props) {
  const { c } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [from, setFrom] = useState<string | null>(null);

  const close = () => {
    setFrom(null);
    onClose();
  };
  const choose = (id: string) => {
    if (!from) return setFrom(id);
    onPick(from, id);
    setFrom(null);
  };

  const options = from ? STATIONS.filter((s) => !('error' in planTrip(from, s.id))) : STATIONS;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: c.scrim, justifyContent: 'flex-end' }}>
        <View style={{ maxHeight: '85%', backgroundColor: c.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingTop: 18, paddingBottom: insets.bottom + 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, marginBottom: 8 }}>
            <View>
              <Text style={{ fontFamily: font.black, fontSize: 12, letterSpacing: 1.2, color: c.muted }}>{from ? 'STEP 2 OF 2' : 'STEP 1 OF 2'}</Text>
              <Text style={{ fontFamily: font.black, fontSize: 22, color: c.text }}>
                {from ? `From ${stationById(from)?.name} to…` : 'Where are you starting?'}
              </Text>
            </View>
            <Pressable accessibilityRole="button" onPress={from ? () => setFrom(null) : close} hitSlop={10}>
              <Text style={{ fontFamily: font.black, fontSize: 15, color: c.blueBtn }}>{from ? 'Back' : 'Close'}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 18 }}>
            {options.map((s) => (
              <Pressable
                key={s.id}
                accessibilityRole="button"
                onPress={() => choose(s.id)}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13,
                  borderBottomWidth: 1, borderBottomColor: c.line, opacity: pressed ? 0.6 : 1,
                })}>
                <View style={{ width: 14, height: 14, borderRadius: 7, borderWidth: 3, borderColor: c.red, backgroundColor: s.id === from ? c.red : c.card }} />
                <Text style={{ flex: 1, fontFamily: font.heavy, fontSize: 17, color: c.text }}>{s.name}</Text>
                {s.branch ? <Text style={{ fontFamily: font.bold, fontSize: 12, color: c.muted }}>{s.branch === 'ashmont' ? 'Ashmont branch' : 'Braintree branch'}</Text> : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
