import { EQ_BANDS } from "@/lib/store/playback-settings";

/**
 * The WebAudio chain behind the player's <audio> elements:
 *
 *   element(s) -> head -> 9 x BiquadFilter -> mono -> [compressor] -> destination
 *
 * Built lazily by the audio engine the first time the equaliser, mono,
 * normalisation or a non-default output device is switched on. Once an
 * element is attached through `createMediaElementSource` it can never be
 * detached, so the graph is a one-way door: everything after that plays
 * through here, and every stage is transparent while its setting is off.
 *
 * The elements must load their stream with `crossOrigin="anonymous"` and
 * the stream server must answer with CORS headers (it does, through the
 * permissive `CorsLayer` on the axum router); a tainted element does not
 * throw here, it just yields silence.
 */

/** `setSinkId` is missing from the DOM lib on AudioContext. */
type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

const dbToGain = (db: number) => 10 ** (db / 20);

export class AudioGraph {
  readonly ctx: AudioContext;
  private readonly head: GainNode;
  private readonly filters: BiquadFilterNode[];
  private readonly mono: GainNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly tail: GainNode;
  private normalize = false;
  private readonly sources = new WeakSet<HTMLMediaElement>();

  constructor() {
    const ctx = new AudioContext({ latencyHint: "playback" });
    this.ctx = ctx;
    this.head = ctx.createGain();
    this.tail = ctx.createGain();

    // Outer bands are shelves so a bass or treble boost lifts everything
    // beyond the band rather than a single hump; the rest are peaks about
    // an octave wide, matching the one-octave spacing of the bands.
    this.filters = EQ_BANDS.map((hz, i) => {
      const f = ctx.createBiquadFilter();
      f.frequency.value = hz;
      if (i === 0) f.type = "lowshelf";
      else if (i === EQ_BANDS.length - 1) f.type = "highshelf";
      else {
        f.type = "peaking";
        f.Q.value = 1.2;
      }
      f.gain.value = 0;
      return f;
    });

    // Mono is a plain gain node forced to one channel: with an explicit
    // channel count of 1 the mixer folds L+R down on the way in, and the
    // destination spreads the single channel back to both speakers.
    this.mono = ctx.createGain();
    this.setMono(false);

    // Loudness levelling, approximated: a fairly firm compressor with
    // the automatic make-up gain WebAudio applies. Without per-track
    // loudness metadata this is what evens quiet and loud tracks out.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 30;
    this.compressor.ratio.value = 12;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    let node: AudioNode = this.head;
    for (const f of this.filters) {
      node.connect(f);
      node = f;
    }
    node.connect(this.mono);
    this.mono.connect(this.tail);
    this.tail.connect(ctx.destination);
  }

  /** Route an element through the graph. Idempotent per element. */
  attach(el: HTMLMediaElement): void {
    if (this.sources.has(el)) return;
    this.sources.add(el);
    this.ctx.createMediaElementSource(el).connect(this.head);
  }

  /** Autoplay policy can leave the context suspended; call around play(). */
  resume(): void {
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Apply a curve, or flatten it when the equaliser is off. Boosts are
   * paid for with a matching pre-attenuation so a +10 dB band cannot push
   * a full-scale track into clipping.
   */
  setEq(enabled: boolean, gains: number[]): void {
    const t = this.ctx.currentTime;
    let maxBoost = 0;
    this.filters.forEach((f, i) => {
      const g = enabled ? (gains[i] ?? 0) : 0;
      maxBoost = Math.max(maxBoost, g);
      f.gain.setTargetAtTime(g, t, 0.02);
    });
    this.head.gain.setTargetAtTime(dbToGain(-maxBoost), t, 0.02);
  }

  setMono(on: boolean): void {
    this.mono.channelCount = on ? 1 : 2;
    this.mono.channelCountMode = on ? "explicit" : "max";
  }

  setNormalize(on: boolean): void {
    if (on === this.normalize) return;
    this.normalize = on;
    this.mono.disconnect();
    this.compressor.disconnect();
    if (on) {
      this.mono.connect(this.compressor);
      this.compressor.connect(this.tail);
    } else {
      this.mono.connect(this.tail);
    }
  }

  /** Move the whole context to an output device; "" is the default. */
  setSinkId(deviceId: string): Promise<void> {
    const ctx = this.ctx as unknown as SinkCapable;
    if (!ctx.setSinkId) return Promise.resolve();
    return ctx.setSinkId(deviceId);
  }
}

/** Whether this webview can pick an output device at all. */
export function canSelectOutputDevice(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}
