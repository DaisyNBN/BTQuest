/**
 * BottomSheet: a draggable sheet that snaps between "peek" and "expanded".
 *
 *   <BottomSheet key={h} peekHeight={h * 0.5} maxHeight={h * 0.9} header={<Header />}>
 *     …scrollable content…
 *   </BottomSheet>
 *
 * Drag the handle/header up or down (or tap the handle) to switch. Built on
 * React Native's Animated + PanResponder so it needs no extra libraries.
 * Render it inside a container whose height you measured (onLayout), and
 * give it a `key` that changes with the size so it re-measures.
 */
import { useState, type ReactNode } from 'react';
import { Animated, PanResponder, Pressable, ScrollView, View } from 'react-native';

import { useAppTheme } from '@/theme/ThemeContext';

type Props = {
  peekHeight: number;
  maxHeight: number;
  header: ReactNode;
  children: ReactNode;
};

export function BottomSheet({ peekHeight, maxHeight, header, children }: Props) {
  const { c } = useAppTheme();
  const collapsedY = Math.max(0, maxHeight - peekHeight); // translateY when peeking; 0 = expanded

  // Animated value + gesture handler, created once per mount. Sizes are fixed
  // for the sheet's lifetime, so give it a `key` that changes with the size.
  const [{ y, pan, toggle }] = useState(() => {
    const y = new Animated.Value(collapsedY);
    let pos = collapsedY; // where the sheet rests between drags
    const clamp = (v: number) => Math.min(collapsedY, Math.max(0, v));
    const snap = (to: number) => {
      pos = to;
      Animated.spring(y, { toValue: to, useNativeDriver: true, bounciness: 3 }).start();
    };
    const release = (dy: number, vy: number) => {
      const cur = clamp(pos + dy);
      if (vy > 0.5) snap(collapsedY);
      else if (vy < -0.5) snap(0);
      else snap(cur > collapsedY / 2 ? collapsedY : 0);
    };
    return {
      y,
      toggle: () => snap(pos === 0 ? collapsedY : 0),
      pan: PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_, g) => y.setValue(clamp(pos + g.dy)),
        onPanResponderRelease: (_, g) => release(g.dy, g.vy),
        onPanResponderTerminate: (_, g) => release(g.dy, g.vy),
      }),
    };
  });

  return (
    <Animated.View
      style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, height: maxHeight,
        transform: [{ translateY: y }],
        backgroundColor: c.card, borderTopLeftRadius: 28, borderTopRightRadius: 28,
        borderWidth: 2, borderBottomWidth: 0, borderColor: c.line,
        shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 12, shadowOffset: { width: 0, height: -2 }, elevation: 12,
      }}>
      <View {...pan.panHandlers}>
        <Pressable accessibilityRole="button" accessibilityLabel="Expand or collapse trip details" onPress={toggle} hitSlop={12} style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 6 }}>
          <View style={{ width: 44, height: 5, borderRadius: 3, backgroundColor: c.track }} />
        </Pressable>
        {header}
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 32, gap: 14 }}>
        {children}
      </ScrollView>
    </Animated.View>
  );
}
