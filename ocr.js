// Camera + on-device OCR adapter. Everything plugin-specific lives here, so swapping the OCR
// plugin later means editing only recognize(). Works offline (ML Kit runs on the phone).
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { groupRows } from './parser.js';

export async function captureInvoice() {
  const photo = await Camera.getPhoto({ quality: 90, resultType: CameraResultType.Uri, source: CameraSource.Camera, saveToGallery: false });
  // Keep the original invoice image inside the app's private storage as the audit reference.
  const ref = `invoices/${crypto.randomUUID()}.jpg`;
  try {
    await Filesystem.mkdir({ path: 'invoices', directory: Directory.Data, recursive: true });
  } catch { /* already exists */ }
  await Filesystem.copy({ from: photo.path, to: ref, toDirectory: Directory.Data });
  return { imageRef: ref, path: photo.path };
}

export async function recognize(path) {
  const { Ocr } = await import('@capacitor-community/image-to-text');
  const { textDetections } = await Ocr.detectText({ filename: path });
  const rows = groupRows(textDetections || []);
  return { rows, text: rows.join('\n') };
}
