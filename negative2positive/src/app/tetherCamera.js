// A tethered camera in the live loupe (docs/tethered-capture.md). The native
// shell hands the camera's live view over one JPEG at a time (`tether_frame`);
// this draws each onto a canvas whose captured stream is the loupe's video, so
// the loupe converts a camera on USB exactly as it converts a webcam.

export const TETHER_PREFIX = 'tether:';

export function isTetherDevice(deviceId) {
  return typeof deviceId === 'string' && deviceId.startsWith(TETHER_PREFIX);
}

// The native side answers with these words; anything else is the camera's own
// refusal and shows as a general failure.
const ERROR_KEYS = Object.freeze({
  'unsupported-camera': 'loupeTetherUnsupported',
  'unsupported-platform': 'loupeTetherUnsupported',
  'no-folder': 'loupeTetherFolder',
  'sony-pc-remote': 'loupeTetherSonyMode',
  'fuji-tether-mode': 'loupeTetherFujiMode',
  'camera-busy': 'loupeTetherBusy'
});

export function tetherErrorKey(error) {
  return ERROR_KEYS[String(error?.message ?? error)] ?? 'loupeTetherFailed';
}

const NOT_READY = 'not-ready';

// Pulls frames until stopped. "not-ready" is the camera between frames or
// taking a picture: wait and ask again. Other failures, or a camera that stays
// not ready, end the feed through onError once they persist.
export function createTetherFeed({
  invoke, canvas,
  decode = (bytes) => createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onError = () => {},
  maxFailures = 20, maxNotReady = 150
}) {
  const context = canvas.getContext('2d');
  let running = true;
  let frames = 0;
  let failures = 0;
  let notReady = 0;
  const done = (async () => {
    while (running) {
      try {
        const bytes = await invoke('tether_frame');
        if (!running) break;
        const bitmap = await decode(bytes);
        if (!running) { bitmap.close?.(); break; }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        frames++;
        failures = 0;
        notReady = 0;
      } catch (error) {
        if (!running) break;
        const waiting = String(error?.message ?? error) === NOT_READY;
        if (waiting ? ++notReady >= maxNotReady : ++failures >= maxFailures) {
          running = false;
          onError(error);
          break;
        }
        await wait(waiting ? 60 : 150);
      }
    }
  })();
  return {
    done,
    get frames() { return frames; },
    stop() { running = false; return done; }
  };
}

// How the frame on the copy stand is exposed, from the camera's own live view
// (before conversion): 'over' when more than 1 % of the sampled pixels clip in
// a channel, 'under' when even the brightest part (the 99th percentile of the
// brightest channel, the film base of a negative) stays below 60 % of the
// range, otherwise 'ok'. `step` samples every step-th pixel.
export function exposureVerdict(data, step = 8) {
  const histogram = new Uint32Array(256);
  let samples = 0;
  let clipped = 0;
  for (let i = 0; i + 2 < data.length; i += 4 * step) {
    const peak = Math.max(data[i], data[i + 1], data[i + 2]);
    histogram[peak]++;
    if (peak >= 252) clipped++;
    samples++;
  }
  if (!samples) return 'ok';
  if (clipped / samples > 0.01) return 'over';
  let above = 0;
  let bright = 255;
  while (bright > 0 && (above += histogram[bright]) < samples * 0.01) bright--;
  return bright < 153 ? 'under' : 'ok';
}

// Exposure settings as a Leica reports them (docs/tethered-capture.md).
// Shutter speed is 256 x log2(1 / seconds); SHUTTER_AUTO is the dial on A.
export const SHUTTER_AUTO = 0x3FFF;
const SHUTTER_DENOMINATORS = [2, 3, 4, 6, 8, 12, 15, 24, 30, 45, 60, 90, 125, 180, 250, 360, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 16000];
const SHUTTER_SECONDS = [0.7, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 45, 60];

const nearest = (list, value) => list.reduce((best, entry) => (Math.abs(Math.log(entry / value)) < Math.abs(Math.log(best / value)) ? entry : best));

// "1/125", "2s", or null for the automatic speed. Speeds are shown as the
// conventional number nearest to the value, as on the camera's dial.
export function shutterLabel(value) {
  if (value === SHUTTER_AUTO || !Number.isFinite(value)) return null;
  const seconds = 2 ** (-value / 256);
  if (seconds >= 0.6) return `${nearest(SHUTTER_SECONDS, seconds)}s`;
  return `1/${nearest(SHUTTER_DENOMINATORS, 1 / seconds)}`;
}

// The speeds offered when the camera takes any value: half stops from 8 s to 1/4000.
export function shutterChoices() {
  const choices = [];
  for (let value = -3 * 256; value <= 12 * 256; value += 128) choices.push(value);
  return choices;
}

// Thousandths of a stop: "+1", "−0.3", "0".
export function compensationLabel(value) {
  const stops = Math.round(value / 100) / 10;
  if (!stops) return '0';
  return `${stops > 0 ? '+' : '\u2212'}${Math.abs(stops)}`;
}
