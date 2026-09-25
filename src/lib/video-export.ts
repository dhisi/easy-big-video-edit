import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  VideoSampleSink,
  type InputVideoTrack,
  type VideoCodec,
} from "mediabunny";

export type ExportQuality = "original" | "1080p";

export type VideoClipSpec = { file: File; inPoint: number; outPoint: number };
export type AudioClipSpec = { file: File; offset: number; inPoint: number; outPoint: number };

export type ExportOptions = {
  videos: VideoClipSpec[];
  audios: AudioClipSpec[];
  keepOriginalAudio: boolean;
  quality: ExportQuality;
  onProgress?: (progress: number) => void;
};

export type ExportHandle = {
  done: Promise<{ savedToDisk: boolean; fileName: string }>;
  cancel: () => void;
};

type SavePicker = (opts: unknown) => Promise<FileSystemFileHandle>;

const RATE = 48000;

export function supportsStreamingSave() {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

const inputCache = new WeakMap<File, Input>();
function inputFor(file: File) {
  let input = inputCache.get(file);
  if (!input) {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    inputCache.set(file, input);
  }
  return input;
}

export async function readVideoInfo(file: File) {
  const input = inputFor(file);
  const duration = await input.computeDuration();
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  return { duration, width: track.displayWidth, height: track.displayHeight };
}

export async function readMediaDuration(file: File) {
  return inputFor(file).computeDuration();
}

/**
 * Joins clips into one MP4. Media is read lazily in small pieces and written straight to disk,
 * so file size is not limited by memory.
 */
export async function startExport(options: ExportOptions): Promise<ExportHandle> {
  if (!options.videos.length) throw new Error("Add a video clip first.");
  const fileName = `${options.videos[0].file.name.replace(/\.[^.]+$/, "")}-edited.mp4`;

  let writable: FileSystemWritableFileStream | null = null;
  if (supportsStreamingSave()) {
    const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
    const handle = await picker({
      suggestedName: fileName,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
    writable = await handle.createWritable();
  }

  const target = writable
    ? new StreamTarget(
        new WritableStream({
          async write(chunk: { data: Uint8Array<ArrayBuffer>; position: number }) {
            await writable!.write({ type: "write", position: chunk.position, data: chunk.data as unknown as BufferSource });
          },
        }),
        { chunked: true },
      )
    : new BufferTarget();

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: writable ? false : "in-memory" }),
    target,
  });

  // ---- Inspect video clips
  const tracks: InputVideoTrack[] = [];
  const codecStrings: (string | null)[] = [];
  for (const clip of options.videos) {
    const track = await inputFor(clip.file).getPrimaryVideoTrack();
    if (!track) throw new Error(`${clip.file.name} has no video.`);
    tracks.push(track);
    codecStrings.push(await track.getCodecParameterString());
  }
  const first = tracks[0];
  const canCopy =
    options.quality === "original" &&
    first.codec !== null &&
    tracks.every(
      (t, i) =>
        t.codec === first.codec &&
        codecStrings[i] === codecStrings[0] &&
        t.codedWidth === first.codedWidth &&
        t.codedHeight === first.codedHeight &&
        t.rotation === first.rotation,
    );

  // In copy mode a clip can only start on a key frame; snap starts so audio stays aligned.
  const sinks = tracks.map((t) => new EncodedPacketSink(t));
  const effIn: number[] = [];
  for (let i = 0; i < options.videos.length; i++) {
    const clip = options.videos[i];
    if (canCopy) {
      const key = (await sinks[i].getKeyPacket(clip.inPoint, { verifyKeyPackets: true })) ?? (await sinks[i].getFirstPacket());
      effIn.push(key ? Math.min(key.timestamp, clip.inPoint) : clip.inPoint);
    } else {
      effIn.push(clip.inPoint);
    }
  }
  const lengths = options.videos.map((c, i) => Math.max(0, c.outPoint - effIn[i]));
  const starts: number[] = [];
  lengths.reduce((acc, len, i) => ((starts[i] = acc), acc + len), 0);
  const total = lengths.reduce((a, b) => a + b, 0);

  // ---- Video track
  let videoSource: EncodedVideoPacketSource | CanvasSource;
  let canvas: OffscreenCanvas | null = null;
  if (canCopy) {
    videoSource = new EncodedVideoPacketSource(first.codec as VideoCodec);
    output.addVideoTrack(videoSource, { rotation: first.rotation });
  } else {
    const aspect = first.displayWidth / first.displayHeight || 16 / 9;
    const height = options.quality === "1080p" ? 1080 : first.displayHeight;
    const width = options.quality === "1080p" ? Math.round((1080 * aspect) / 2) * 2 : first.displayWidth;
    canvas = new OffscreenCanvas(width - (width % 2), height - (height % 2));
    videoSource = new CanvasSource(canvas, { codec: "avc", bitrate: QUALITY_HIGH });
    output.addVideoTrack(videoSource);
  }

  // ---- Audio plan: added clips win; gaps use the original sound of the video.
  type Segment = { file: File; srcStart: number; srcEnd: number; outStart: number };
  const segments: Segment[] = [];
  const music = options.audios
    .map((a) => ({ ...a, s: a.offset, e: a.offset + (a.outPoint - a.inPoint) }))
    .filter((a) => a.e > a.s)
    .sort((a, b) => a.s - b.s);
  let pos = 0;
  const fillOriginal = (from: number, to: number) => {
    if (!options.keepOriginalAudio) return;
    options.videos.forEach((clip, i) => {
      const cs = starts[i];
      const ce = cs + lengths[i];
      const a = Math.max(from, cs);
      const b = Math.min(to, ce);
      if (b - a > 0.01) segments.push({ file: clip.file, srcStart: effIn[i] + (a - cs), srcEnd: effIn[i] + (b - cs), outStart: a });
    });
  };
  for (let i = 0; i < music.length; i++) {
    const m = music[i];
    const s = Math.max(m.s, pos);
    const e = Math.min(m.e, total, music[i + 1]?.s ?? Infinity);
    if (e - s <= 0.01) continue;
    if (s > pos) fillOriginal(pos, s);
    segments.push({ file: m.file, srcStart: m.inPoint + (s - m.offset), srcEnd: m.inPoint + (e - m.offset), outStart: s });
    pos = e;
  }
  if (pos < total) fillOriginal(pos, total);

  const audioSegments: (Segment & { sink: AudioSampleSink })[] = [];
  for (const seg of segments) {
    const track = await inputFor(seg.file).getPrimaryAudioTrack();
    if (track) audioSegments.push({ ...seg, sink: new AudioSampleSink(track) });
  }
  const audioSource = audioSegments.length ? new AudioSampleSource({ codec: "aac", bitrate: QUALITY_HIGH }) : null;
  if (audioSource) output.addAudioTrack(audioSource);

  // ---- Progress + cancel
  let canceled = false;
  let videoDone = 0;
  let audioDone = 0;
  const report = () => {
    if (total <= 0) return;
    const p = audioSource ? (videoDone / total) * 0.85 + (audioDone / total) * 0.15 : videoDone / total;
    options.onProgress?.(Math.min(0.999, p));
  };
  const check = () => {
    if (canceled) throw new Error("canceled");
  };

  const runVideo = async () => {
    let firstPacket = true;
    for (let i = 0; i < options.videos.length; i++) {
      const clip = options.videos[i];
      const base = effIn[i];
      const offset = starts[i];
      if (canCopy) {
        const sink = sinks[i];
        const key = (await sink.getKeyPacket(clip.inPoint, { verifyKeyPackets: true })) ?? (await sink.getFirstPacket());
        if (!key) continue;
        const meta = firstPacket ? { decoderConfig: (await first.getDecoderConfig()) ?? undefined } : undefined;
        for await (const packet of sink.packets(key)) {
          check();
          if (packet.timestamp > clip.outPoint + 2) break;
          if (packet.timestamp < base || packet.timestamp >= clip.outPoint) continue;
          await (videoSource as EncodedVideoPacketSource).add(
            packet.clone({ timestamp: offset + packet.timestamp - base }),
            firstPacket ? meta : undefined,
          );
          firstPacket = false;
          videoDone = offset + packet.timestamp - base;
          report();
        }
      } else {
        const ctx = canvas!.getContext("2d")!;
        const sink = new VideoSampleSink(tracks[i]);
        for await (const sample of sink.samples(clip.inPoint, clip.outPoint)) {
          try {
            check();
            const ts = offset + (sample.timestamp - base);
            if (ts < offset - 0.001) continue;
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, canvas!.width, canvas!.height);
            sample.drawWithFit(ctx, { fit: "contain" });
            const dur = Math.min(sample.duration || 1 / 30, offset + lengths[i] - ts);
            if (dur <= 0) continue;
            await (videoSource as CanvasSource).add(ts, dur);
            videoDone = ts;
            report();
          } finally {
            sample.close();
          }
        }
      }
    }
    videoSource.close();
  };

  const runAudio = async () => {
    if (!audioSource) return;
    let written = 0; // frames at 48 kHz
    const endFrame = Math.floor(total * RATE);
    const addSilence = async (untilFrame: number) => {
      while (written < untilFrame) {
        check();
        const n = Math.min(RATE, untilFrame - written);
        const s = new AudioSample({ data: new Float32Array(n * 2), format: "f32-planar", numberOfChannels: 2, sampleRate: RATE, timestamp: written / RATE });
        await audioSource.add(s);
        s.close();
        written += n;
      }
    };
    for (const seg of audioSegments) {
      const segEndOut = seg.outStart + (seg.srcEnd - seg.srcStart);
      await addSilence(Math.floor(seg.outStart * RATE));
      for await (const sample of seg.sink.samples(seg.srcStart, seg.srcEnd)) {
        try {
          check();
          const sr = sample.sampleRate;
          const n = sample.numberOfFrames;
          const ch = sample.numberOfChannels;
          const t0 = seg.outStart + (sample.timestamp - seg.srcStart);
          const k0 = Math.max(written, Math.ceil(Math.max(t0, seg.outStart) * RATE));
          const k1 = Math.min(endFrame, Math.floor(Math.min(t0 + n / sr, segEndOut) * RATE));
          if (k1 <= k0) continue;
          const planes: Float32Array[] = [];
          for (let c = 0; c < Math.min(ch, 2); c++) {
            const buf = new Float32Array(n);
            sample.copyTo(buf, { planeIndex: c, format: "f32-planar" });
            planes.push(buf);
          }
          if (planes.length === 1) planes.push(planes[0]);
          const len = k1 - k0;
          const out = new Float32Array(len * 2);
          for (let k = 0; k < len; k++) {
            const p = ((k0 + k) / RATE - t0) * sr;
            const i = Math.min(n - 1, Math.max(0, Math.floor(p)));
            const j = Math.min(n - 1, i + 1);
            const f = Math.min(1, Math.max(0, p - i));
            out[k] = planes[0][i] + (planes[0][j] - planes[0][i]) * f;
            out[len + k] = planes[1][i] + (planes[1][j] - planes[1][i]) * f;
          }
          const s = new AudioSample({ data: out, format: "f32-planar", numberOfChannels: 2, sampleRate: RATE, timestamp: k0 / RATE });
          await audioSource.add(s);
          s.close();
          written = k1;
          audioDone = k1 / RATE;
          report();
        } finally {
          sample.close();
        }
      }
    }
    await addSilence(endFrame);
    audioSource.close();
  };

  const done = (async () => {
    try {
      await output.start();
      await Promise.all([runVideo(), runAudio()]);
      await output.finalize();
      if (writable) {
        await writable.close();
      } else {
        const buffer = (output.target as BufferTarget).buffer;
        if (!buffer) throw new Error("Export produced no data");
        const url = URL.createObjectURL(new Blob([buffer], { type: "video/mp4" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      options.onProgress?.(1);
      return { savedToDisk: Boolean(writable), fileName };
    } catch (error) {
      try {
        await output.cancel();
      } catch {
        /* ignore */
      }
      try {
        await writable?.abort();
      } catch {
        /* ignore */
      }
      if (canceled) throw new Error("canceled");
      throw error;
    }
  })();

  return {
    done,
    cancel: () => {
      canceled = true;
    },
  };
}
