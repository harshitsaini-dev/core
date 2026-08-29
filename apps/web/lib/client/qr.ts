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
    BarcodeDetector?: new (options?: { formats?: string[] }) => BarcodeDetectorApi;
  }
}

export function qrScanningPossible(): boolean {
  return typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function';
}

function detector(): BarcodeDetectorApi {
  const Detector = window.BarcodeDetector;
  if (!Detector) throw new Error('this browser cannot read QR codes');
  return new Detector({ formats: ['qr_code'] });
}

/** Read a QR code out of a chosen image. */
export async function readQrFromFile(file: Blob): Promise<string | null> {
  try {
    const found = await detector().detect(file);
    return found[0]?.rawValue ?? null;
  } catch {
    return null;
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
