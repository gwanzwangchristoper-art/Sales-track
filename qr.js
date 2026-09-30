// Loaded on demand so the app starts fast and still works if a plugin is missing.
export async function qrDataUrl(text) { return (await import('qrcode')).default.toDataURL(text, { margin: 1, width: 240 }); }
export async function scanQr() { // reads any barcode or QR code; works offline

  const { BarcodeScanner } = await import('@capacitor-mlkit/barcode-scanning');
  const { barcodes } = await BarcodeScanner.scan();
  return barcodes[0]?.rawValue || '';
}
export const scanBarcode = scanQr;
