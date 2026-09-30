// Run once after `npx cap add android`:  npm run android:patch
// Hardens the generated Android project: camera permission, no cloud backup of app data, no plain-http traffic,
// and hides the app contents from screenshots and the recent-apps screen.
import fs from 'node:fs';
import path from 'node:path';

export function patchManifest(xml) {
  let x = xml;
  if (!x.includes('android.permission.CAMERA'))
    x = x.replace('</manifest>', '    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>');
  const setAttr = (name, value) => {
    const re = new RegExp(`android:${name}="[^"]*"`);
    x = re.test(x) ? x.replace(re, `android:${name}="${value}"`) : x.replace('<application', `<application\n        android:${name}="${value}"`);
  };
  setAttr('allowBackup', 'false');          // the encrypted database must not be copied to Google Drive backups
  setAttr('usesCleartextTraffic', 'false'); // HTTPS only
  return x;
}

export function patchMainActivity(java, pkg = 'com.salestrack.calculator') {
  if (java.includes('FLAG_SECURE')) return java;
  return `package ${pkg};

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Blocks screenshots and blanks the app in the recent-apps list, so sales figures are not exposed.
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }
}
`;
}

if (process.argv[1] && path.basename(process.argv[1]) === 'patch-android.mjs') {
  const root = 'android/app/src/main', mf = `${root}/AndroidManifest.xml`, act = `${root}/java/com/salestrack/calculator/MainActivity.java`;
  if (!fs.existsSync(mf)) { console.error('Run "npx cap add android" first.'); process.exit(1); }
  fs.writeFileSync(mf, patchManifest(fs.readFileSync(mf, 'utf8')));
  if (fs.existsSync(act)) fs.writeFileSync(act, patchMainActivity(fs.readFileSync(act, 'utf8')));
  else console.warn('MainActivity.java not found where expected; add FLAG_SECURE by hand.');
  console.log('Android project patched.');
}
