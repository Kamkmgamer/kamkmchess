import type { RecapTimeline } from './timeline.js';

export interface MusicNote { readonly start: number; readonly duration: number; readonly hz: number; readonly gain: number; readonly voice: 'sine' | 'triangle' }

/** Authored chord patterns with seeded voicing; the soundtrack uses no external recordings. */
export function musicScore(timeline: RecapTimeline): readonly MusicNote[] {
  const notes: MusicNote[] = [];
  const beat = 60 / timeline.bpm;
  const chords = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]];
  const offset = timeline.seed % 4;
  const add = (midi: number, start: number, duration: number, gain: number, voice: MusicNote['voice']) => {
    if (start >= timeline.duration) return;
    notes.push({ start, duration: Math.min(duration, timeline.duration - start), hz: 440 * 2 ** ((midi - 69) / 12), gain, voice });
  };
  for (let b = 0; b * beat < timeline.duration; b++) {
    const chord = chords[(Math.floor(b / 8) + offset) % chords.length]!;
    if (b % 2 === 0) add(chord[0]! - 12, b * beat, beat * 1.7, 0.065, 'sine');
    if (b % 2 === 0) add(31, b * beat, 0.09, 0.06, 'sine');
    add(chord[(b + (timeline.seed % 3)) % 3]! + 12, b * beat, beat * 0.7, 0.028, 'triangle');
    if (b % 4 === 0) for (const midi of chord) add(midi, b * beat, beat * 3.7, 0.019, 'sine');
  }
  for (const scene of timeline.scenes) {
    if (scene.kind !== 'move') continue;
    const strong = scene.move?.grade === 'great' || scene.move?.grade === 'blunder' || scene.move?.san.endsWith('#');
    add(strong ? 81 : 76, scene.start + (scene.jump ? 0.65 : 0.3), 0.09, strong ? 0.04 : 0.018, 'triangle');
  }
  const end = timeline.scenes.at(-1)!.start;
  const ending = timeline.review.replay.result.winner === 'draw' ? [60, 64] : [60, 64, 67, 72];
  ending.forEach((midi, index) => add(midi, end + index * beat, 1.4, 0.045, 'triangle'));
  return notes;
}

/** The same graph powers preview and offline export, both scheduled on audio time. */
export function scheduleMusic(context: BaseAudioContext, destination: AudioNode, timeline: RecapTimeline,
  options: { offset: number; at: number; duration: number; volume: number }): void {
  const bus = context.createGain();
  const end = Math.min(timeline.duration, options.offset + options.duration);
  const length = end - options.offset;
  if (length <= 0) return;
  bus.gain.setValueAtTime(options.volume, options.at);
  const fade = Math.min(0.08, length / 4);
  bus.gain.setValueAtTime(0, options.at);
  bus.gain.linearRampToValueAtTime(options.volume, options.at + fade);
  const finalFade = end >= timeline.duration ? Math.min(1.5, length / 3) : fade;
  bus.gain.setValueAtTime(options.volume, options.at + length - finalFade);
  bus.gain.linearRampToValueAtTime(0, options.at + length);
  bus.connect(destination);
  for (const note of musicScore(timeline)) {
    const start = Math.max(note.start, options.offset);
    const stop = Math.min(note.start + note.duration, end);
    if (start >= stop) continue;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const at = options.at + start - options.offset;
    const duration = stop - start;
    oscillator.type = note.voice; oscillator.frequency.value = note.hz;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(note.gain, at + Math.min(0.012, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.00001, at + duration);
    oscillator.connect(gain).connect(bus);
    oscillator.start(at); oscillator.stop(at + duration);
  }
}

export async function renderMusic(timeline: RecapTimeline, offset: number, seconds: number, volume: number): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, Math.ceil(seconds * 48_000), 48_000);
  const buffer = context.createBuffer(2, context.length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  // Absolute note phase and envelopes keep independently rendered chunks continuous.
  for (const note of musicScore(timeline)) {
    const from = Math.max(0, Math.ceil((note.start - offset) * context.sampleRate));
    const to = Math.min(samples.length, Math.ceil((note.start + note.duration - offset) * context.sampleRate));
    const attack = Math.min(0.012, note.duration / 4);
    for (let i = from; i < to; i++) {
      const absolute = offset + i / context.sampleRate;
      const age = absolute - note.start;
      const envelope = age < attack ? Math.max(0, age / attack) : Math.exp(Math.log(0.00001 / note.gain) * (age - attack) / Math.max(0.001, note.duration - attack));
      const phase = 2 * Math.PI * note.hz * age;
      const wave = note.voice === 'triangle' ? 2 / Math.PI * Math.asin(Math.sin(phase)) : Math.sin(phase);
      const fade = Math.min(1, absolute / 0.08, Math.max(0, timeline.duration - absolute) / 1.5);
      samples[i] = Math.max(-0.98, Math.min(0.98, samples[i]! + wave * envelope * note.gain * volume * fade));
    }
  }
  buffer.copyToChannel(samples, 1);
  const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); source.start(0);
  return context.startRendering();
}
