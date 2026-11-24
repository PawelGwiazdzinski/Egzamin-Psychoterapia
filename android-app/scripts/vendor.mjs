// Kopiuje biblioteki do www/vendor (bez bundlera).
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("www/vendor", { recursive: true });
// Rdzeń Capacitora (registerPlugin, CapacitorHttp) – ładowany zwykłym <script> przed aplikacją.
cpSync("node_modules/@capacitor/core/dist/capacitor.js", "www/vendor/capacitor.js");
// pdf.js – wersja "legacy" (z polyfillami), żeby działała także na starszym WebView.
cpSync("node_modules/pdfjs-dist/legacy/build/pdf.min.mjs", "www/vendor/pdf.min.mjs");
cpSync("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs", "www/vendor/pdf.worker.min.mjs");
cpSync("node_modules/pdfjs-dist/cmaps", "www/vendor/cmaps", { recursive: true });
cpSync("node_modules/pdfjs-dist/standard_fonts", "www/vendor/standard_fonts", { recursive: true });
cpSync("node_modules/pdfjs-dist/wasm", "www/vendor/wasm", { recursive: true });
cpSync("node_modules/pdfjs-dist/iccs", "www/vendor/iccs", { recursive: true });
console.log("vendor ok");
