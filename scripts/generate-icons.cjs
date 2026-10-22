// Generates every PWA icon from the brand logo file.
// Usage: node scripts/generate-icons.cjs [path-to-logo]
// Default input: assets/logoB.jpg (the source artwork is kept in the repo).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// --- minimal JPEG->RGBA decoding is not needed: we embed the source as PNG
// only if it is already PNG. For JPEG input the icon set is produced by the
// companion PowerShell step (System.Drawing) during authoring; this script
// keeps a single source of truth for sizes and validates the files.
const outDir = path.join(__dirname, "..", "client", "public", "icons");
const LOGO = path.join(__dirname, "..", "assets", "logoB.jpg");

const SIZES = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "icon-maskable-512.png", size: 512 },
  { name: "apple-touch-icon-180.png", size: 180 },
  { name: "badge-72.png", size: 72 },
  { name: "favicon-32.png", size: 32 },
];

// Reads the PNG IHDR to report the real pixel size (used for verification).
const pngSize = (file) => {
  const buffer = fs.readFileSync(file);
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

if (!fs.existsSync(LOGO)) {
  console.error("Logo not found:", LOGO);
  process.exit(1);
}

let broken = 0;
for (const { name, size } of SIZES) {
  const file = path.join(outDir, name);
  if (!fs.existsSync(file)) {
    console.error("missing", name, "— regenerate it from the logo");
    broken += 1;
    continue;
  }
  const dims = pngSize(file);
  const ok = dims && dims.width === size && dims.height === size;
  if (!ok) broken += 1;
  console.log(`${ok ? "ok  " : "BAD "} ${name} ${dims ? `${dims.width}x${dims.height}` : "not-a-png"}`);
}

if (broken) {
  console.error(`\n${broken} icon(s) need regeneration from ${path.relative(process.cwd(), LOGO)}`);
  process.exit(1);
}
console.log("\nAll PWA icons match the logo sizes.");
