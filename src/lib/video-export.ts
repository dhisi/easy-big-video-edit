import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type ConversionVideoOptions,
} from "mediabunny";

export type ExportQuality = "original" | "1080p";

export type ExportOptions = {
  videoFile: File;
  audioFile: File | null;
  keepOriginalAudio: boolean;
  trimStart: number;
  trimEnd: number;
  quality: ExportQuality;
  onProgress?: (progress: number) => void;
};

export type ExportHandle = {
  done: Promise<{ savedToDisk: boolean; fileName: string }>;
  cancel: () => void;
};

type SavePicker = (opts: unknown) => Promise<FileSystemFileHandle>;

function suggestedName(name: string) {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base}-edited.mp4`;
}

export function supportsStreamingSave() {
  return typeof window !== "undefined" && "showSaveFilePicker" in window;
}

/** Reads media lazily and writes the result straight to disk, so file size is not limited by memory. */
export async function startExport(options: ExportOptions): Promise<ExportHandle> {
  const fileName = suggestedName(options.videoFile.name);

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
          async write(chunk: { data: Uint8Array; position: number }) {
            await writable!.write({ type: "write", position: chunk.position, data: chunk.data });
          },
        }),
        { chunked: true },
      )
    : new BufferTarget();

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: writable ? false : "in-memory" }),
    target,
  });

  const videoInput = new Input({
    source: new BlobSource(options.videoFile),
    formats: ALL_FORMATS,
  });

  const video: ConversionVideoOptions = options.quality === "1080p" ? { height: 1080 } : {};
  const clipDuration = Math.max(0.05, options.trimEnd - options.trimStart);

  const videoConversion = await Conversion.init({
    input: videoInput,
    output,
    video,
    audio: { discard: Boolean(options.audioFile) || !options.keepOriginalAudio },
    trim: { start: options.trimStart, end: options.trimEnd },
    composable: true,
  });

  let audioConversion: Conversion | null = null;
  if (options.audioFile) {
    const audioInput = new Input({
      source: new BlobSource(options.audioFile),
      formats: ALL_FORMATS,
    });
    const audioDuration = await audioInput.computeDuration();
    audioConversion = await Conversion.init({
      input: audioInput,
      output,
      video: { discard: true },
      trim: { start: 0, end: Math.min(audioDuration, clipDuration) },
      composable: true,
    });
  }

  let videoProgress = 0;
  let audioProgress = 0;
  const report = () => {
    const total = audioConversion ? (videoProgress * 0.9 + audioProgress * 0.1) : videoProgress;
    options.onProgress?.(Math.min(1, total));
  };
  videoConversion.onProgress = (p) => {
    videoProgress = p;
    report();
  };
  if (audioConversion) {
    audioConversion.onProgress = (p) => {
      audioProgress = p;
      report();
    };
  }

  let canceled = false;

  const done = (async () => {
    try {
      await output.start();
      await Promise.all([
        videoConversion.execute(),
        audioConversion ? audioConversion.execute() : Promise.resolve(),
      ]);
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
      void videoConversion.cancel();
      void audioConversion?.cancel();
    },
  };
}

export async function readVideoInfo(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const duration = await input.computeDuration();
  const track = await input.getPrimaryVideoTrack();
  return {
    duration,
    width: track?.displayWidth ?? 0,
    height: track?.displayHeight ?? 0,
  };
}
