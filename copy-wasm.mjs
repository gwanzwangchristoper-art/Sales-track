// Copies the SQLite WebAssembly file next to the app so the browser build can load it (the phone build does not need it).
import fs from 'node:fs';
const src = 'node_modules/sql.js/dist/sql-wasm.wasm';
if (!fs.existsSync(src)) { console.warn('sql-wasm.wasm not found; run npm install first. (Only the browser build needs it.)'); process.exit(0); }
fs.mkdirSync('public/assets', { recursive: true });
fs.copyFileSync(src, 'public/assets/sql-wasm.wasm');
console.log('Copied sql-wasm.wasm');
