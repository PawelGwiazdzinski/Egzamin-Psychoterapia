// Kopiuje biblioteki do www/vendor (bez bundlera).
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("www/vendor", { recursive: true });
cpSync("node_modules/pdfjs-dist/build/pdf.min.mjs", "www/vendor/pdf.min.mjs");
cpSync("node_modules/pdfjs-dist/build/pdf.worker.min.mjs", "www/vendor/pdf.worker.min.mjs");
cpSync("node_modules/pdfjs-dist/cmaps", "www/vendor/cmaps", { recursive: true });
cpSync("node_modules/pdfjs-dist/standard_fonts", "www/vendor/standard_fonts", { recursive: true });
cpSync("node_modules/pdfjs-dist/wasm", "www/vendor/wasm", { recursive: true });
cpSync("node_modules/pdfjs-dist/iccs", "www/vendor/iccs", { recursive: true });
console.log("vendor ok");
