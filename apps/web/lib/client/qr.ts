'use client';

/**
 * Reading a QR code, without shipping a QR decoder.
 *
 * `BarcodeDetector` is in the browser already on Chrome, Edge and Android. It
 * is not in Safari or Firefox, and the honest way to handle that is to say so
 * rather than to add a decoding library to a page a phone has to load before it
 * can show anything — the same reasoning that kept the TOTP generator hand-
 * written next door.
 *
 * Where it is missing, pasting the `otpauth://` URI still works and always has.
 * That path is not a workaround bolted on for this feature; it is what the item
 * form already accepted, and it is what every setup screen offers under "can't
 * scan the code?".
 *
 * Nothing here uploads anything. The camera frame and the file both stay in the
 * page, are decoded in the page, and are dropped. A QR code of a 2FA secret is
 * a 2FA secret.
 */

interface DetectedBarcode {
  readonly rawValue: string;
}

interface BarcodeDetectorApi {
  detect: (source: CanvasImageSource | Blob) => Promise<DetectedBarcode[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): BarcodeDetectorApi;
      getSupportedFormats: () => Promise<string[]>;
    };
  }
}

/**
 * Whether this browser can actually decode a QR code.
 *
 * The obvious check is `typeof window.BarcodeDetector === 'function'`, and that
 * is what this was. It is wrong, and wrong in the worst direction: on Windows
 * and Linux desktop Chrome the constructor exists while the platform service
 * behind it does not, so the check passed, the buttons rendered, the camera
 * opened onto nothing and a chosen image reported "no QR code found" — which
 * reads as a bad photograph rather than a browser that was never going to
 * work.
 *
 * `getSupportedFormats` is the question actually worth asking, and it is a
 * promise, which is why the shortcut was tempting. The answer does not change
 * during a page's life, so it is asked once and remembered.
 */
let supported: Promise<boolean> | null = null;

export function qrScanningPossible(): Promise<boolean> {
  supported ??= (async () => {
    if (typeof window === 'undefined') return false;

    const Detector = window.BarcodeDetector;
    if (typeof Detector !== 'function') return false;

    try {
      const formats = await Detector.getSupportedFormats();
      return formats.includes('qr_code');
    } catch {
      // Present but unusable. Same answer as absent, from the point of view of
      // somebody holding a phone with a QR code on it.
      return false;
    }
  })();

  return supported;
}

function detector(): BarcodeDetectorApi {
  const Detector = window.BarcodeDetector;
  if (!Detector) throw new Error('this browser cannot read QR codes');
  return new Detector({ formats: ['qr_code'] });
}

export type FileScan =
  | { readonly status: 'found'; readonly value: string }
  | { readonly status: 'none' }
  | { readonly status: 'unsupported' };

/**
 * Read a QR code out of a chosen image.
 *
 * Three outcomes and not two. "Nothing in this image" and "this browser cannot
 * look" are different problems with different next steps, and collapsing them
 * into `null` sent people back to take a better photograph of a code their
 * browser was never going to read.
 */
export async function readQrFromFile(file: Blob): Promise<FileScan> {
  if (!(await qrScanningPossible())) return { status: 'unsupported' };

  try {
    const found = await detector().detect(file);
    const value = found[0]?.rawValue;
    return value === undefined ? { status: 'none' } : { status: 'found', value };
  } catch {
    return { status: 'unsupported' };
  }
}

export interface Scanner {
  /** The element to show. Already playing. */
  readonly video: HTMLVideoElement;
  readonly stop: () => void;
}

/**
 * Open the camera and watch for a code.
 *
 * The stream is stopped by `stop`, and calling it matters more than usual: a
 * camera left running behind a closed dialog is a camera light somebody notices
 * an hour later and cannot explain.
 */
export async function scanWithCamera(onFound: (value: string) => void): Promise<Scanner> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // The back camera where there is one, which is the one pointed at a screen
    // showing a code.
    video: { facingMode: 'environment' },
  });

  const video = document.createElement('video');
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  video.muted = true;
  await video.play();

  const read = detector();
  let running = true;

  const tick = async (): Promise<void> => {
    if (!running) return;

    try {
      const found = await read.detect(video);
      if (found[0]?.rawValue) {
        onFound(found[0].rawValue);
        return;
      }
    } catch {
      // A frame that will not decode is the normal case, several times a
      // second, while somebody lines the code up. Not worth reporting.
    }

    // Polled rather than run flat out: decoding every frame is a warm phone
    // and a flat battery for no extra chance of reading a code that is being
    // held still.
    setTimeout(() => void tick(), 250);
  };

  void tick();

  return {
    video,
    stop: () => {
      running = false;
      for (const track of stream.getTracks()) track.stop();
    },
  };
}
