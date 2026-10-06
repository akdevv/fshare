import { useRef } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { baseName, CANCELLABLE, type Job } from '../hooks/use-transfers';
import { eta, fileIcon, fmt, haptic, rate, useStyles, type Theme } from '../theme';
import { ENTER, EXIT, LAYOUT } from './motion';
import { Bar, Pop, Press, Ring } from './ui';

const MAX_LIVE = 4; // more than this collapses into "+N more"

// The card for files on the move: overall speed and progress, then each file with its controls.
export function TransferPanel({
  live,
  speed,
  onPause,
  onResume,
  onCancel,
  onPauseAll,
  onResumeAll,
  onCancelAll,
}: {
  live: Job[];
  speed: number;
  onPause: (key: string) => void;
  onResume: (key: string) => void;
  onCancel: (key: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onCancelAll: () => void;
}) {
  const [st, t] = useStyles(styles);
  const total = live.reduce((n, j) => n + j.total, 0);
  const done = live.reduce((n, j) => n + j.done, 0);
  const allPaused = live.every((j) => j.state === 'paused');

  // speed and time left are noise for the first moments; they show once the rate settles
  const since = useRef(0);
  if (allPaused) since.current = 0;
  else if (!since.current) since.current = Date.now();
  const settled = !allPaused && speed > 2e5 && Date.now() - since.current > 1500;

  return (
    <Animated.View style={st.panel} entering={ENTER} exiting={EXIT} layout={LAYOUT}>
      <View style={st.between}>
        <Pop id={panelTitle(live)} fade>
          <Text style={st.panelTitle}>{panelTitle(live)}</Text>
        </Pop>
        <Text style={[st.meta, st.num]}>{settled ? eta((total - done) / speed) : ''}</Text>
      </View>
      <View style={st.speedRow}>
        <Text style={[st.speed, !settled && { color: t.faint }]}>{settled ? (speed / 1e6).toFixed(1) : '0.0'}</Text>
        <Text style={st.unit}>MB/s</Text>
      </View>
      <Bar f={total ? done / total : 0} color={allPaused ? t.faint : t.accent} track={t.surface3} />
      <View style={st.liveList}>
        {live.slice(0, MAX_LIVE).map((job) => (
          <LiveRow
            key={job.key}
            job={job}
            onCancel={() => {
              haptic.reject();
              onCancel(job.key);
            }}
            onPause={() => {
              haptic.toggle(false);
              onPause(job.key);
            }}
            onResume={() => {
              haptic.toggle(true);
              onResume(job.key);
            }}
          />
        ))}
        {live.length > MAX_LIVE && (
          <Animated.Text style={[st.meta, { paddingLeft: 42 }]} layout={LAYOUT}>
            +{live.length - MAX_LIVE} more
          </Animated.Text>
        )}
      </View>
      <View style={[st.between, st.panelFoot]}>
        <Text style={[st.meta, st.num, { flex: 1 }]} numberOfLines={1}>
          {fmt(done)} of {fmt(total)}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(allPaused || live.some((j) => j.state === 'active')) && (
            <Press
              style={st.pill}
              onPress={() => {
                haptic.toggle(allPaused);
                if (allPaused) onResumeAll();
                else onPauseAll();
              }}
              accessibilityRole="button"
              accessibilityLabel={allPaused ? 'Resume all' : 'Pause all'}
            >
              <Ionicons name={allPaused ? 'play' : 'pause'} size={13} color={t.text} />
              <Text style={st.pillText}>{allPaused ? 'Resume' : 'Pause'}</Text>
            </Press>
          )}
          <Press
            style={[st.pill, { backgroundColor: t.redSoft }]}
            onPress={() => {
              haptic.reject();
              onCancelAll();
            }}
            accessibilityRole="button"
          >
            <Text style={[st.pillText, { color: t.red }]}>Cancel</Text>
          </Press>
        </View>
      </View>
    </Animated.View>
  );
}

export function panelTitle(live: Job[]) {
  if (live.every((j) => j.state === 'paused')) return 'Paused';
  if (!live.some((j) => j.state !== 'queued' && j.state !== 'preparing')) return 'Preparing…';
  const dirs = new Set(live.map((j) => j.dir));
  const verb = dirs.size > 1 ? 'Transferring' : dirs.has('up') ? 'Sending' : 'Receiving';
  return `${verb} ${live.length} ${live.length === 1 ? 'file' : 'files'}`;
}

// Finished transfers. Received files open on tap, failed ones retry, and a long press selects.
export function TransferList({
  jobs,
  picked,
  onSelect,
  onSelectAll,
  onClear,
  onToggle,
  onOpen,
}: {
  jobs: Job[];
  picked: Set<string> | null;
  onSelect: (key?: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onToggle: (key: string) => void;
  onOpen: (job: Job) => void;
}) {
  const [st] = useStyles(styles);
  const selecting = picked !== null;
  const allPicked = selecting && jobs.every((j) => picked.has(j.key));
  return (
    <Animated.View entering={ENTER} exiting={EXIT} layout={LAYOUT}>
      <View style={st.sectionHead}>
        <Text style={st.sectionTitle}>Transfers</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {selecting ? (
            <TextButton label={allPicked ? 'Deselect all' : 'Select all'} onPress={onSelectAll} />
          ) : (
            <>
              <TextButton label="Select" onPress={() => onSelect()} />
              <TextButton
                label="Clear"
                onPress={() => {
                  haptic.select();
                  onClear();
                }}
              />
            </>
          )}
        </View>
      </View>
      <View style={st.group}>
        {jobs.map((job, i) => (
          <Animated.View key={job.key} entering={ENTER} exiting={EXIT} layout={LAYOUT}>
            <JobRow
              job={job}
              first={i === 0}
              selecting={selecting}
              selected={!!picked?.has(job.key)}
              onPress={() => (selecting ? onToggle(job.key) : job.state === 'done' && job.file ? onOpen(job) : job.retry?.())}
              onLongPress={() => (selecting ? onToggle(job.key) : onSelect(job.key))}
            />
          </Animated.View>
        ))}
      </View>
    </Animated.View>
  );
}

function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  const [st] = useStyles(styles);
  return (
    <Press style={st.textBtn} onPress={onPress} hitSlop={8} accessibilityRole="button">
      <Text style={st.textBtnLabel}>{label}</Text>
    </Press>
  );
}

function LiveRow({ job, onCancel, onPause, onResume }: { job: Job; onCancel: () => void; onPause: () => void; onResume: () => void }) {
  const [st, t] = useStyles(styles);
  const f = job.total ? job.done / job.total : 0;
  const pct = `${Math.floor(f * 100)}%`;
  const status =
    job.state === 'active'
      ? job.rate
        ? `${pct} · ${rate(job.rate)}`
        : pct
      : job.state === 'paused'
        ? `Paused · ${pct}`
        : job.state === 'saving'
          ? 'Saving…'
          : job.state === 'preparing'
            ? 'Preparing…'
            : 'Waiting';
  const paused = job.state === 'paused';
  return (
    <Animated.View
      style={st.liveRow}
      entering={ENTER}
      exiting={EXIT}
      layout={LAYOUT}
      accessible
      accessibilityLabel={`${baseName(job.name)}, ${status}`}
    >
      <View style={st.mini}>
        <Ring f={job.state === 'saving' ? 1 : f} size={32} stroke={2.5} color={paused ? t.faint : t.accent} track={t.surface3} />
        <Ionicons name={paused ? 'pause' : job.dir === 'up' ? 'arrow-up' : 'arrow-down'} size={14} color={paused ? t.dim : t.text} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={st.liveName} numberOfLines={1}>
          {baseName(job.name)}
        </Text>
        <Text style={[st.meta, st.num, { fontSize: 12 }]} numberOfLines={1}>
          {status}
        </Text>
      </View>
      {job.state === 'active' && job.done > 0 && !job.incoming && <IconButton icon="pause" onPress={onPause} label={`Pause ${job.name}`} />}
      {paused && !job.incoming && <IconButton icon="play" filled onPress={onResume} label={`Resume ${job.name}`} />}
      {CANCELLABLE.includes(job.state) && <IconButton icon="close" onPress={onCancel} label={`Cancel ${job.name}`} />}
    </Animated.View>
  );
}

function JobRow({
  job,
  first,
  selecting,
  selected,
  onPress,
  onLongPress,
}: {
  job: Job;
  first: boolean;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const [st, t] = useStyles(styles);
  const name = baseName(job.name);
  const failed = job.state === 'error' || job.state === 'cancelled';
  const opens = job.state === 'done' && job.dir === 'down' && !!job.file;
  const savedTo = Platform.OS === 'ios' ? 'Saved to Files' : 'Saved to Downloads';
  const status = failed
    ? `${job.state === 'error' ? 'Failed' : 'Cancelled'}${job.retry ? ' · Tap to retry' : ''}`
    : job.dir === 'up'
      ? `Sent to ${job.peer ?? 'laptop'} · ${fmt(job.total)}`
      : `${job.peer ? `From ${job.peer}` : savedTo} · ${fmt(job.total)}`;
  const thumb = failed
    ? {
        bg: job.state === 'error' ? t.redSoft : t.surface2,
        fg: job.state === 'error' ? t.red : t.dim,
        icon: job.retry ? ('refresh' as const) : ('close' as const),
      }
    : job.dir === 'up'
      ? { bg: t.surface2, fg: t.dim, icon: 'arrow-up' as const }
      : { bg: t.accentSoft, fg: t.onAccentSoft, icon: fileIcon(name) };
  return (
    <Press
      style={[st.cell, selected && { backgroundColor: t.surface2 }]}
      highlight={t.surface2}
      onPress={selecting || opens || (failed && job.retry) ? onPress : undefined}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityState={selecting ? { selected } : undefined}
      accessibilityLabel={`${name}, ${status}`}
      accessibilityHint={selecting ? undefined : opens ? 'Opens the file. Long press to select' : 'Long press to select'}
    >
      {!first && <View style={st.sep} />}
      <View style={[st.thumb, { backgroundColor: thumb.bg }]}>
        <Ionicons name={thumb.icon} size={19} color={thumb.fg} />
      </View>
      <View style={st.cellText}>
        <Text style={st.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[st.meta, st.num, job.state === 'error' && { color: t.red }]} numberOfLines={1}>
          {status}
        </Text>
      </View>
      {selecting && <Check on={selected} />}
    </Press>
  );
}

function Check({ on }: { on: boolean }) {
  const [st, t] = useStyles(styles);
  return (
    <Animated.View
      style={[
        st.check,
        {
          backgroundColor: on ? t.accent : 'transparent',
          borderColor: on ? t.accent : t.faint,
          transitionProperty: ['backgroundColor', 'borderColor'],
          transitionDuration: 150,
        },
      ]}
    >
      {on && (
        <Pop id="on">
          <Ionicons name="checkmark" size={16} color={t.onAccent} />
        </Pop>
      )}
    </Animated.View>
  );
}

function IconButton({
  icon,
  filled,
  onPress,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  filled?: boolean;
  onPress: () => void;
  label: string;
}) {
  const [st, t] = useStyles(styles);
  return (
    <Press
      style={[st.iconBtn, { backgroundColor: filled ? t.accent : t.surface3 }]}
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={14} color={filled ? t.onAccent : t.text} />
    </Press>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
    meta: { color: t.dim, fontSize: 13 },
    num: { fontVariant: ['tabular-nums'] },
    name: { color: t.text, fontSize: 15, fontWeight: '600' },

    panel: { padding: 18, borderRadius: 24, borderCurve: 'continuous', backgroundColor: t.surface },
    panelTitle: { color: t.text, fontSize: 15, fontWeight: '600' },
    panelFoot: { marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line },
    speedRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6, marginBottom: 14 },
    speed: { color: t.text, fontSize: 44, fontWeight: '700', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
    unit: { color: t.dim, fontSize: 16, fontWeight: '600' },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height: 34,
      paddingHorizontal: 14,
      borderRadius: 17,
      backgroundColor: t.surface3,
    },
    pillText: { color: t.text, fontSize: 13, fontWeight: '600' },
    liveList: { gap: 12, marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line },
    liveRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    liveName: { color: t.text, fontSize: 14, fontWeight: '600' },
    mini: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    iconBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },

    sectionHead: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: 16,
      paddingBottom: 10,
      paddingHorizontal: 4,
    },
    sectionTitle: { color: t.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
    textBtn: { paddingHorizontal: 12, height: 30, borderRadius: 15, justifyContent: 'center', backgroundColor: t.surface2 },
    textBtnLabel: { color: t.text, fontSize: 13, fontWeight: '600' },
    group: { backgroundColor: t.surface, borderRadius: 22, borderCurve: 'continuous', overflow: 'hidden' },
    cell: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 68,
      backgroundColor: t.surface,
    },
    sep: { position: 'absolute', top: 0, left: 70, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: t.line },
    cellText: { flex: 1, gap: 3 },
    thumb: { width: 44, height: 44, borderRadius: 13, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
    check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginRight: 5 },
  });
