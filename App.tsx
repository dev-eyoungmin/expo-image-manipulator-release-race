import { Asset } from 'expo-asset';
import {
  ImageManipulator,
  SaveFormat,
  useImageManipulator,
} from 'expo-image-manipulator';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

const ROUNDS = 10;

/**
 * How long a round waits after calling `renderAsync()` before the context is
 * released. It only has to be short enough for the native render to still be in
 * flight — phase A prints the render duration so you can check that it is.
 */
const RELEASE_DELAY_MS = 20;

/**
 * A pipeline that takes long enough for the release in phases B and C to land
 * while the render is still running. Rotating a 4000x3000 bitmap is the slow part.
 */
function addTransformers(context: ReturnType<typeof ImageManipulator.manipulate>) {
  context.resize({ width: 2400 });
  context.rotate(90);
  context.rotate(90);
  context.rotate(90);
  context.resize({ width: 1500 });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type PhaseResult = {
  key: string;
  title: string;
  detail: string;
  failed: number;
  total: number;
  firstError?: string;
  renderMs?: number;
};

/**
 * Phase A — the control.
 *
 * The context is released only after the render has been awaited, so it is
 * reachable for the whole call. This is the shape that works today and it has
 * to keep working.
 */
async function controlRound(uri: string): Promise<number> {
  const context = ImageManipulator.manipulate(uri);
  addTransformers(context);

  let rendered: Awaited<ReturnType<typeof context.renderAsync>> | null = null;
  const startedAt = Date.now();
  try {
    rendered = await context.renderAsync();
    const renderMs = Date.now() - startedAt;
    await rendered.saveAsync({ compress: 0.9, format: SaveFormat.JPEG });
    return renderMs;
  } finally {
    rendered?.release();
    context.release();
  }
}

/**
 * Phase B — release while a render is pending.
 *
 * `release()` is called after the native render has started and while the
 * returned promise is still pending. This is what `useImageManipulator` does
 * for the app when the component unmounts (phase C), written out by hand.
 */
async function releaseWhilePendingRound(uri: string): Promise<void> {
  const context = ImageManipulator.manipulate(uri);
  addTransformers(context);

  const pending = context.renderAsync();
  await sleep(RELEASE_DELAY_MS);
  context.release();

  const rendered = await pending;
  rendered.release();
}

/**
 * Phase C — the documented API doing it for you.
 *
 * `useImageManipulator` is backed by `useReleasingSharedObject`, which calls
 * `release()` on unmount. Nothing in this component releases anything.
 */
function HookProbe({
  uri,
  onSettled,
}: {
  uri: string;
  onSettled: (error: unknown) => void;
}) {
  const context = useImageManipulator(uri);

  useEffect(() => {
    addTransformers(context);
    context.renderAsync().then(
      (image) => {
        image.release();
        onSettled(null);
      },
      (error) => onSettled(error)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  return null;
}

export default function App() {
  const [status, setStatus] = useState('Preparing the 4000x3000 test image…');
  const [results, setResults] = useState<PhaseResult[]>([]);
  const [probeRound, setProbeRound] = useState<number | null>(null);
  const [uri, setUri] = useState<string | null>(null);

  const settleRef = useRef<((error: unknown) => void) | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    (async () => {
      const asset = Asset.fromModule(require('./assets/large.jpg'));
      await asset.downloadAsync();
      const localUri = asset.localUri ?? asset.uri;
      setUri(localUri);

      const collected: PhaseResult[] = [];
      const publish = (result: PhaseResult) => {
        collected.push(result);
        setResults([...collected]);
        console.log(
          `REPRO ${result.key}: ${result.failed}/${result.total} failed` +
            (result.firstError ? ` | ${result.firstError}` : '')
        );
      };

      // Phase A
      setStatus('Phase A — render, then release after the await…');
      let failedA = 0;
      let firstErrorA: string | undefined;
      let renderMs: number | undefined;
      for (let round = 0; round < ROUNDS; round++) {
        try {
          const ms = await controlRound(localUri);
          renderMs = renderMs === undefined ? ms : Math.round((renderMs + ms) / 2);
        } catch (error) {
          failedA += 1;
          firstErrorA = firstErrorA ?? describe(error);
        }
      }
      publish({
        key: 'A',
        title: 'A · control — release after the await',
        detail: 'The context is still referenced after `await`. Must never fail.',
        failed: failedA,
        total: ROUNDS,
        firstError: firstErrorA,
        renderMs,
      });

      // Phase B
      setStatus('Phase B — release while the render is pending…');
      let failedB = 0;
      let firstErrorB: string | undefined;
      for (let round = 0; round < ROUNDS; round++) {
        try {
          await releaseWhilePendingRound(localUri);
        } catch (error) {
          failedB += 1;
          firstErrorB = firstErrorB ?? describe(error);
        }
      }
      publish({
        key: 'B',
        title: `B · release() ${RELEASE_DELAY_MS}ms into the render`,
        detail: 'The promise from `renderAsync()` is still pending when the context is released.',
        failed: failedB,
        total: ROUNDS,
        firstError: firstErrorB,
      });

      // Phase C
      setStatus('Phase C — useImageManipulator, unmounted mid-render…');
      let failedC = 0;
      let firstErrorC: string | undefined;
      for (let round = 0; round < ROUNDS; round++) {
        const settled = new Promise<unknown>((resolve) => {
          settleRef.current = resolve;
        });
        setProbeRound(round);
        await sleep(RELEASE_DELAY_MS);
        setProbeRound(null);

        const error = await settled;
        if (error) {
          failedC += 1;
          firstErrorC = firstErrorC ?? describe(error);
        }
      }
      publish({
        key: 'C',
        title: 'C · useImageManipulator, component unmounted mid-render',
        detail: 'No release() in app code — the hook releases the context on unmount.',
        failed: failedC,
        total: ROUNDS,
        firstError: firstErrorC,
      });

      setStatus('Done.');
    })().catch((error) => setStatus(`Harness error: ${describe(error)}`));
  }, []);

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>expo-image-manipulator · release race</Text>
        <Text style={styles.meta}>
          {Platform.OS} · expo-image-manipulator {require('expo-image-manipulator/package.json').version}
        </Text>
        <Text style={styles.status}>{status}</Text>

        {results.map((result) => (
          <View
            key={result.key}
            style={[styles.card, result.failed > 0 ? styles.cardFail : styles.cardPass]}>
            <Text style={styles.cardTitle}>{result.title}</Text>
            <Text style={styles.cardDetail}>{result.detail}</Text>
            <Text style={styles.cardResult}>
              {result.failed} / {result.total} failed
              {result.renderMs !== undefined ? ` · render ≈ ${result.renderMs}ms` : ''}
            </Text>
            {result.firstError ? (
              <Text style={styles.cardError}>{result.firstError}</Text>
            ) : null}
          </View>
        ))}
      </ScrollView>

      {probeRound !== null && uri ? (
        <HookProbe
          key={probeRound}
          uri={uri}
          onSettled={(error) => settleRef.current?.(error)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0d10' },
  content: { padding: 20, paddingTop: 72, gap: 12 },
  heading: { color: '#f4f6f8', fontSize: 18, fontWeight: '700' },
  meta: { color: '#7d8894', fontSize: 12 },
  status: { color: '#c3ccd6', fontSize: 13, marginTop: 4, marginBottom: 4 },
  card: { borderRadius: 10, borderWidth: 1, padding: 12, gap: 4 },
  cardPass: { borderColor: '#1f6f43', backgroundColor: '#0f1d15' },
  cardFail: { borderColor: '#8d2b2b', backgroundColor: '#1d0f0f' },
  cardTitle: { color: '#f4f6f8', fontSize: 14, fontWeight: '600' },
  cardDetail: { color: '#8b96a2', fontSize: 12 },
  cardResult: { color: '#f4f6f8', fontSize: 15, fontWeight: '700', marginTop: 2 },
  cardError: { color: '#ff9c9c', fontSize: 11, marginTop: 2 },
});
