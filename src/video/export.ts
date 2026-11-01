import { AudioBufferSource, BufferTarget, CanvasSource, canEncodeAudio, canEncodeVideo, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import type { AudioCodec, VideoCodec } from 'mediabunny';
import { renderMusic, scheduleMusic } from '../recap/music.js';
import type { RecapTimeline } from '../recap/timeline.js';
import { recapCredits, renderFrame, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH } from './render.js';
import type { RenderAssets } from './render.js';

const BITRATE = 2_500_000;
const MEMORY_LIMIT = 64 * 1024 * 1024;
export interface ExportProgress { readonly phase: 'encoding' | 'recording' | 'finishing'; readonly completed: number; readonly total: number }
export interface ExportResult { readonly blob: Blob; readonly extension: 'mp4' | 'webm'; readonly release: () => Promise<void> }
export interface CodecProfile { readonly video: VideoCodec; readonly audio: AudioCodec; readonly extension: 'mp4' | 'webm'; readonly mime: string }

const PROFILES: readonly CodecProfile[] = [
  { video: 'avc', audio: 'aac', extension: 'mp4', mime: 'video/mp4' },
  { video: 'vp9', audio: 'opus', extension: 'webm', mime: 'video/webm' },
  { video: 'vp8', audio: 'opus', extension: 'webm', mime: 'video/webm' },
];

function check(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Export stopped.', 'AbortError'); }

export async function selectCodec(music: boolean): Promise<CodecProfile | null> {
  if (!globalThis.isSecureContext || typeof VideoEncoder === 'undefined') return null;
  for (const profile of PROFILES) {
    try {
      const [video, audio] = await Promise.all([
        canEncodeVideo(profile.video, { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, bitrate: BITRATE, frameRate: VIDEO_FPS }),
        music ? canEncodeAudio(profile.audio, { sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 }) : true,
      ]);
      if (video && audio) return profile;
    } catch { /* Try the next concrete audio/video combination. */ }
  }
  return null;
}

interface OutputSink {
  readonly target: BufferTarget | StreamTarget;
  readonly finish: (mime: string) => Promise<Blob>;
  readonly release: () => Promise<void>;
  readonly abort: () => Promise<void>;
}

async function createSink(duration: number): Promise<OutputSink> {
  let directory: FileSystemDirectoryHandle | null = null;
  let name: string | null = null;
  let writable: FileSystemWritableFileStream | null = null;
  try {
    directory = await navigator.storage.getDirectory();
    name = `chess-recap-${crypto.randomUUID()}.tmp`;
    const handle = await directory.getFileHandle(name, { create: true });
    writable = await handle.createWritable();
    const destination = writable;
    let closed = false;
    const remove = async () => { if (name) await directory?.removeEntry(name).catch(() => undefined); };
    const target = new StreamTarget(new WritableStream({
      write: chunk => destination.write({ type: 'write', position: chunk.position, data: chunk.data }),
      close: async () => { await destination.close(); closed = true; },
      abort: async () => { await destination.abort().catch(() => undefined); closed = true; },
    }));
    return {
      target,
      finish: async mime => { if (!closed) { await destination.close(); closed = true; } const file = await handle.getFile(); return file.slice(0, file.size, mime); },
      release: remove,
      abort: async () => { if (!closed) await destination.abort().catch(() => undefined); await remove(); },
    };
  } catch {
    await writable?.abort().catch(() => undefined);
    if (name) await directory?.removeEntry(name).catch(() => undefined);
  }
  if (duration * (BITRATE + 128_000) / 8 > MEMORY_LIMIT * 0.8) throw new Error('Storage is unavailable for this length. Choose Highlights and retry.');
  const target = new BufferTarget();
  return { target, finish: async mime => {
    if (!target.buffer || target.buffer.byteLength > MEMORY_LIMIT) throw new Error('The video exceeded available memory. Choose Highlights and retry.');
    return new Blob([target.buffer], { type: mime });
  }, release: async () => undefined, abort: async () => undefined };
}

function format(profile: CodecProfile) { return profile.extension === 'mp4' ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(); }

/** A real short encode catches resource/configuration failures before allocating the output file. */
async function probe(profile: CodecProfile, canvas: HTMLCanvasElement, timeline: RecapTimeline, volume: number, signal: AbortSignal): Promise<void> {
  const output = new Output({ target: new BufferTarget(), format: format(profile) });
  const video = new CanvasSource(canvas, { codec: profile.video, bitrate: BITRATE });
  const audio = volume > 0 ? new AudioBufferSource({ codec: profile.audio, bitrate: 128_000 }) : null;
  output.addVideoTrack(video, { frameRate: VIDEO_FPS });
  if (audio) output.addAudioTrack(audio);
  try {
    check(signal); await output.start();
    // Supply audio before the few video frames to avoid unmatched-track buffering.
    if (audio) { await audio.add(await renderMusic(timeline, 0, 0.1, volume)); audio.close(); }
    for (let i = 0; i < 3; i++) { check(signal); await video.add(i / VIDEO_FPS, 1 / VIDEO_FPS); }
    video.close(); await output.finalize(); check(signal);
  } catch (error) { await output.cancel().catch(() => undefined); throw error; }
}

async function encode(timeline: RecapTimeline, assets: RenderAssets, orientation: 'white' | 'black', volume: number,
  profile: CodecProfile, canvas: HTMLCanvasElement, signal: AbortSignal, progress: (value: ExportProgress) => void): Promise<ExportResult> {
  const sink = await createSink(timeline.duration);
  const output = new Output({ target: sink.target, format: format(profile) });
  const video = new CanvasSource(canvas, { codec: profile.video, bitrate: BITRATE, keyFrameInterval: 2 });
  const audio = volume > 0 ? new AudioBufferSource({ codec: profile.audio, bitrate: 128_000 }) : null;
  output.addVideoTrack(video, { frameRate: VIDEO_FPS });
  if (audio) output.addAudioTrack(audio);
  output.setMetadataTags({ title: 'kamkm chess recap', comment: recapCredits(assets), description: `Reviewed by ${timeline.review.engineId}.` });
  const cancel = () => { void output.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    check(signal); await output.start();
    const frames = Math.round(timeline.duration * VIDEO_FPS);
    for (let first = 0; first < frames; first += VIDEO_FPS * 2) {
      check(signal);
      const last = Math.min(frames, first + VIDEO_FPS * 2);
      if (audio) {
        const buffer = await renderMusic(timeline, first / VIDEO_FPS, (last - first) / VIDEO_FPS, volume);
        check(signal); await audio.add(buffer);
      }
      for (let frame = first; frame < last; frame++) {
        check(signal);
        renderFrame(canvas, timeline, frame / VIDEO_FPS, assets, orientation);
        await video.add(frame / VIDEO_FPS, 1 / VIDEO_FPS);
        if (frame % 15 === 0) progress({ phase: 'encoding', completed: frame + 1, total: frames });
        if (frame % 30 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    audio?.close(); video.close();
    progress({ phase: 'finishing', completed: frames, total: frames });
    await output.finalize(); check(signal);
    const blob = await sink.finish(profile.mime);
    check(signal);
    return { blob, extension: profile.extension, release: sink.release };
  } catch (error) { await output.cancel().catch(() => undefined); await sink.abort(); throw error; }
  finally { signal.removeEventListener('abort', cancel); }
}

function recorderMime(music: boolean): string | null {
  const candidates = music ? ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']
    : ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8'];
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) ?? null;
}

async function record(timeline: RecapTimeline, assets: RenderAssets, orientation: 'white' | 'black', volume: number,
  canvas: HTMLCanvasElement, audio: AudioContext | null, signal: AbortSignal, progress: (value: ExportProgress) => void): Promise<ExportResult> {
  if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') throw new Error('Video export is unavailable in this browser. Try a current desktop browser.');
  const mime = recorderMime(volume > 0);
  if (!mime) throw new Error('This browser cannot export the selected video and music. Try another browser.');
  if (document.hidden) throw new Error('Keep this tab visible while recording.');
  check(signal);
  if (volume > 0 && (!audio || audio.state !== 'running')) throw new Error('Audio could not start. Click Export again, or mute the music.');
  const stream = canvas.captureStream(VIDEO_FPS);
  let destination: MediaStreamAudioDestinationNode | null = null;
  if (volume > 0 && audio) {
    destination = audio.createMediaStreamDestination();
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  }
  try {
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE, audioBitsPerSecond: 128_000 });
    return await new Promise<ExportResult>((resolve, reject) => {
      const chunks: Blob[] = [];
      let bytes = 0, frame = 0, finished = false, failure: Error | null = null;
      const started = performance.now();
      const audioStart = audio?.currentTime ?? 0;
      const cleanup = () => {
        cancelAnimationFrame(frame); clearInterval(watchdog);
        document.removeEventListener('visibilitychange', visibility);
        signal.removeEventListener('abort', abort); audio?.removeEventListener('statechange', audioState);
      };
      const stop = (error: Error | null) => {
        if (finished) return;
        finished = true; failure = error; cleanup();
        if (recorder.state !== 'inactive') recorder.stop();
        else reject(error ?? new Error('Recording stopped before it finished.'));
      };
      const abort = () => stop(new DOMException('Export stopped.', 'AbortError'));
      const visibility = () => { if (document.hidden) stop(new Error('Recording was interrupted. Keep the tab visible and retry.')); };
      const audioState = () => { if (volume > 0 && audio?.state !== 'running') stop(new Error('Audio was interrupted. Keep this device awake and retry.')); };
      let lastTick = started;
      const watchdog = setInterval(() => {
        if (performance.now() - lastTick > 2000) stop(new Error('Recording was interrupted. Keep this device awake and retry.'));
      }, 1000);
      recorder.ondataavailable = event => {
        bytes += event.data.size;
        if (bytes > MEMORY_LIMIT) { failure = new Error('The recording is too large. Choose Highlights and retry.'); stop(failure); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => stop(new Error('The browser could not record this video. Retry or try another browser.'));
      recorder.onstop = () => {
        cleanup();
        if (failure || signal.aborted) { reject(failure ?? new DOMException('Export stopped.', 'AbortError')); return; }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (!blob.size) { reject(new Error('The browser returned an empty recording. Retry the export.')); return; }
        resolve({ blob, extension: recorder.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm', release: async () => undefined });
      };
      const draw = () => {
        if (finished) return;
        const now = performance.now();
        if (now - lastTick > 1500) { stop(new Error('Recording paused unexpectedly. Keep this device awake and retry.')); return; }
        lastTick = now;
        const elapsed = volume > 0 && audio ? audio.currentTime - audioStart : (now - started) / 1000;
        renderFrame(canvas, timeline, Math.min(elapsed, timeline.duration), assets, orientation);
        progress({ phase: 'recording', completed: Math.min(elapsed, timeline.duration), total: timeline.duration });
        if (elapsed >= timeline.duration) { stop(null); return; }
        frame = requestAnimationFrame(draw);
      };
      signal.addEventListener('abort', abort, { once: true });
      document.addEventListener('visibilitychange', visibility);
      audio?.addEventListener('statechange', audioState);
      try {
        renderFrame(canvas, timeline, 0, assets, orientation);
        recorder.start(1000);
        if (destination && audio) scheduleMusic(audio, destination, timeline, { offset: 0, at: audioStart, duration: timeline.duration, volume });
        frame = requestAnimationFrame(draw);
      } catch (error) { stop(error instanceof Error ? error : new Error('Recording could not start.')); }
    });
  } finally { for (const track of stream.getTracks()) track.stop(); }
}

export async function exportRecap(timeline: RecapTimeline, assets: RenderAssets, orientation: 'white' | 'black', volume: number,
  signal: AbortSignal, progress: (value: ExportProgress) => void): Promise<ExportResult> {
  // Start a silent audio context during the initiating click for the live fallback.
  let audio: AudioContext | null = null;
  if (volume > 0 && typeof AudioContext !== 'undefined') {
    try { audio = new AudioContext(); void audio.resume().catch(() => undefined); } catch { /* Offline encoding can still succeed. */ }
  }
  const canvas = document.createElement('canvas'); canvas.width = VIDEO_WIDTH; canvas.height = VIDEO_HEIGHT;
  let wake: WakeLockSentinel | null = null;
  try {
    check(signal);
    if (navigator.wakeLock && !document.hidden) wake = await navigator.wakeLock.request('screen').catch(() => null);
    renderFrame(canvas, timeline, 0, assets, orientation);
    const profile = await selectCodec(volume > 0);
    if (profile) {
      try { await probe(profile, canvas, timeline, volume, signal); }
      catch (error) { check(signal); if (!(error instanceof Error)) throw error; return await record(timeline, assets, orientation, volume, canvas, audio, signal, progress); }
      return await encode(timeline, assets, orientation, volume, profile, canvas, signal, progress);
    }
    return await record(timeline, assets, orientation, volume, canvas, audio, signal, progress);
  } finally { await audio?.close().catch(() => undefined); await wake?.release().catch(() => undefined); canvas.width = 0; canvas.height = 0; }
}
