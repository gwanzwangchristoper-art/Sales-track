# Sales Track Calculator

Offline-first POS calculator, inventory and sales recorder for Android (Capacitor + HTML/CSS/JavaScript, encrypted SQLite, Supabase sync).
Built in phases 1-8 and 10. Phase 9 (reports/export/Google Drive) was dropped on request.

## 1. Setup
```
npm install
npx cap add android
npm run android:patch     # camera permission, no cloud backup, HTTPS only, screenshots blocked
npm run sync              # build the web app and copy it into the Android project
npx cap open android      # run on a phone or emulator from Android Studio
```
Delete any earlier debug install first: the database key changed in Phase 10 (it is now generated per phone and kept in the Android Keystore).

## 1b. Try it in a browser (no Android needed)
```
npm install
npm run dev        # opens the app at http://localhost:5173
```
Same app and same database code as the phone, stored in the browser (IndexedDB). It is not encrypted, and camera scanning, OCR and fingerprint unlock only work in the Android build. Typing always works.

## 2. Cloud (needed only for more than one device)
1. Supabase: Authentication > Providers > enable **Anonymous sign-ins**; for the simplest setup turn off **Confirm email**.
2. In the SQL editor run, in order: `supabase/migrations/001_identity.sql`, `002_data_sync.sql`, `003_corrections_conflicts.sql`.
3. Put the project URL and anon key in `src/cloud/config.js`.
4. Admin phone: Accounts > Connect to the cloud. Then Add device shows a QR and a 10-character code (one use, 5 minutes).

## 3. Migrations
Local database changes live in `src/db/schema.js` as numbered entries (currently 1-8). They run automatically on start. Add a new number; never edit an applied one.

## 4. Tests
`npm test` runs 72 automated tests: the merge rules, the real migrations and sale/stock/invoice/report code on in-memory SQLite, two and three simulated phones syncing through a fake cloud, login security, Android patching, and a 10,000-product / 30,000-sale performance check.

| Your test case | Where it is covered |
|---|---|
| New admin registration, authentication | app.test, security.test |
| New user linking | sync.test (setup), security.test |
| Product creation; during a sale | app.test (domain); the tap-through is a device check |
| Ordinary calculation; sale; multi-product; stock reduction; low stock | app.test |
| Invoice OCR text reading; confirmation; new product from invoice | parser.test, app.test |
| Offline sale, reconnection, multi-device, simultaneous offline sales | sync.test |
| Device revocation | sync.test (phone side). The server function needs a device check |
| Audit correction | corrections.test, sync.test |
| Failed synchronization; duplicate prevention | sync.test |
| Database recovery (lost phone) | sync.test |

## 5. Security in this build
Encrypted database with a per-phone Keystore key; salted PBKDF2 password hashes; login slows after 5 failures; fingerprint/face unlock that stores no password; auto-lock (1-30 min) and lock on return from background; recent password needed to revoke devices, change permissions or enable fingerprint; server-side permission checks on every table; append-only history enforced in both databases; Content-Security-Policy; no Android backup; HTTPS only; screenshots and recent-apps preview blocked.

## 6. Must be checked on a real phone (not testable here)
1. Migration 8 (tamper-proofing triggers) runs on the SQLite plugin. If it fails, the plugin is splitting the trigger statements.
2. `setEncryptionSecret` / `isSecretStored` behave as coded in `src/db/capacitor.js`.
3. The OCR plugin (`@capacitor-community/image-to-text`) returns text with positions; only `src/ocr/ocr.js` touches it. Try your suppliers' real invoices.
4. Barcode/QR scanning (`@capacitor-mlkit/barcode-scanning`) may need Google's scanner module on some phones. Typing always works.
5. Fingerprint unlock (`capacitor-native-biometric`).
6. The three Supabase SQL files on a real project: create a business, link a second phone, revoke it, restrict a permission, then repeat the two-phone offline scenario.
7. The Content-Security-Policy in `index.html` does not block anything the app needs (watch the console on first run).

## 7. Known limits
- No export or Google Drive (Phase 9 dropped). The cloud copy is the backup.
- Notifications and settings do not sync between phones yet.
- A phone that is revoked keeps its local data (never silently deleted), but cannot sign in or sync.
- Admin-only rule: a wrongly created duplicate product SKU on two phones is not detected across devices.
- `_replaced_sync/` and `_replaced_phase8/` hold files from other attempts found in the folder. They are not used; delete them when you are happy.
