/**
 * Generates a cohesive cover per playlist and uploads it.
 * Only touches playlists still on Spotify's auto generated art, never a real upload.
 *
 *   bun run covers.ts --dry-run    write JPEGs to .cache/covers/ and stop
 *   bun run covers.ts              generate and upload
 */
import { api, paginate } from "./spotify";

const DRY_RUN = process.argv.includes("--dry-run");
const OUT_DIR = new URL(".cache/covers/", import.meta.url).pathname;

type Palette = { from: string; to: string };

/** Genre family palettes. Longest key wins so "electro house" beats "house". */
const FAMILIES: [string, Palette][] = [
  ["progressive house", { from: "#06243f", to: "#1e9be0" }],
  ["tropical house", { from: "#0a3b3f", to: "#2fd8c0" }],
  ["electro house", { from: "#0b1740", to: "#4a6bff" }],
  ["electropop", { from: "#2a0a3d", to: "#b44bff" }],
  ["dance-pop", { from: "#3d0a2c", to: "#ff4d97" }],
  ["electronic", { from: "#071b33", to: "#2b7fd4" }],
  ["reggaeton", { from: "#3d1204", to: "#ff8a2b" }],
  ["alternative rock", { from: "#340d12", to: "#c33d4b" }],
  ["indie folk", { from: "#12240f", to: "#6aa84f" }],
  ["indie pop", { from: "#0d2b2e", to: "#38b6a6" }],
  ["soft rock", { from: "#2b1508", to: "#c98a4b" }],
  ["pop rock", { from: "#33101f", to: "#d9506b" }],
  ["hip hop", { from: "#2b1c02", to: "#e0a52b" }],
  ["country", { from: "#241a08", to: "#b39152" }],
  ["latin", { from: "#3a1003", to: "#ff6b2b" }],
  ["house", { from: "#04202e", to: "#20a4c9" }],
  ["dance", { from: "#320a33", to: "#d34bd8" }],
  ["rock", { from: "#2e0d10", to: "#b03a44" }],
  ["r&b", { from: "#1d0a33", to: "#8b5bd6" }],
  ["edm", { from: "#0b1e3f", to: "#2b7fd4" }],
  ["pop", { from: "#3a0a30", to: "#ff4f9a" }],
];

const NEUTRAL: Palette = { from: "#1a1c20", to: "#5c636e" };

/** Year covers ramp through the hue wheel so the set reads chronologically. */
function yearPalette(year: number): Palette {
  const span = Math.min(Math.max(year, 2018), 2026) - 2018;
  const hue = (205 + span * 26) % 360;
  return { from: hsl(hue, 62, 13), to: hsl(hue, 72, 52) };
}

function hsl(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function paletteFor(name: string): Palette {
  const year = /^Liked (\d{4})$/.exec(name);
  if (year) return yearPalette(Number(year[1]));
  const genre = name.replace(/^Genre: /, "").toLowerCase();
  if (genre === "unknown" || genre === "other") return NEUTRAL;
  return FAMILIES.find(([key]) => genre.includes(key))?.[1] ?? NEUTRAL;
}

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MARGIN = 56;
const MAX_TEXT_WIDTH = 640 - MARGIN * 2;

/** Helvetica Bold caps run about 0.70em per glyph; deliberately conservative. */
const estWidth = (text: string, size: number) => text.length * size * 0.70;

/**
 * Wraps to at most two lines, then shrinks until the widest line fits.
 * Fitting by character count instead of width silently clipped "ELECTRO HOUSE".
 */
function fitTitle(title: string): { lines: string[]; size: number } {
  let best = { lines: [title], size: 0 };
  for (const lines of candidateLayouts(title.split(" "))) {
    const widest = Math.max(...lines.map((l) => l.length));
    // Largest type wins, so a bold two liner beats a shrunken single line.
    const size = Math.min(86, Math.floor(MAX_TEXT_WIDTH / (widest * 0.70)));
    if (size > best.size) best = { lines, size };
  }
  return { lines: best.lines, size: Math.max(40, Math.min(86, best.size)) };
}

function candidateLayouts(words: string[]): string[][] {
  if (words.length === 1) return [words];
  const layouts: string[][] = [[words.join(" ")]];
  for (let split = 1; split < words.length; split++) {
    layouts.push([words.slice(0, split).join(" "), words.slice(split).join(" ")]);
  }
  return layouts;
}

export function svgFor(name: string, count: number): string {
  const p = paletteFor(name);
  const title = name.replace(/^Genre: /, "").replace(/^Liked /, "");
  const kind = name.startsWith("Liked ") ? "LIKED IN" : "GENRE";
  const { lines, size } = fitTitle(title.toUpperCase());
  const baseY = lines.length > 1 ? 470 - size : 448;

  const bands = (y: number, dir: 1 | -1) =>
    Array.from({ length: 5 }, (_, i) => {
      const w = 128 - i * 18;
      const x = dir === 1 ? i * 128 : 640 - (i + 1) * 128;
      return `<rect x="${x}" y="${y}" width="${w}" height="26" fill="#ffffff" opacity="${(0.26 - i * 0.045).toFixed(3)}"/>`;
    }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${p.from}"/><stop offset="1" stop-color="${p.to}"/>
  </linearGradient></defs>
  <rect width="640" height="640" fill="url(#g)"/>
  ${bands(58, 1)}
  ${bands(556, -1)}
  <text x="${MARGIN}" y="150" font-family="Helvetica Neue, Helvetica, Arial" font-size="22" font-weight="600" letter-spacing="6" fill="#ffffff" opacity="0.6">${kind}</text>
${lines
  .map(
    (l, i) =>
      `  <text x="${MARGIN}" y="${baseY + i * (size + 6)}" font-family="Helvetica Neue, Helvetica, Arial" font-size="${size}" font-weight="700" fill="#ffffff">${escapeXml(l)}</text>`,
  )
  .join("\n")}
  <text x="${MARGIN}" y="${baseY + lines.length * (size + 6) + 14}" font-family="Helvetica Neue, Helvetica, Arial" font-size="27" fill="#ffffff" opacity="0.74">${count} song${count === 1 ? "" : "s"}</text>
</svg>`;
}

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd[0]} failed: ${await new Response(proc.stderr).text()}`);
  }
}

/** Spotify caps the base64 payload at 256 KB, so step quality down until it fits. */
async function renderJpeg(name: string, count: number): Promise<string> {
  const slug = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const svg = `${OUT_DIR}${slug}.svg`;
  const png = `${OUT_DIR}${slug}.png`;
  const jpg = `${OUT_DIR}${slug}.jpg`;
  await Bun.write(svg, svgFor(name, count));
  await run(["rsvg-convert", "-w", "640", "-h", "640", svg, "-o", png]);

  for (const quality of ["90", "80", "70", "55"]) {
    await run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", quality, png, "--out", jpg]);
    const bytes = await Bun.file(jpg).arrayBuffer();
    const b64 = Buffer.from(bytes).toString("base64");
    if (b64.length <= 256_000) return b64;
  }
  throw new Error(`${name}: cannot get under Spotify's 256 KB base64 cap`);
}

type Playlist = { id: string; name: string; owner: { id: string }; images: { url: string }[] | null };

/** mosaic.scdn.co means Spotify generated it; i.scdn.co on a playlist means single album art. */
function lacksRealCover(p: Playlist): boolean {
  const url = p.images?.[0]?.url;
  if (!url) return true;
  const host = new URL(url).host;
  return host === "mosaic.scdn.co" || host === "i.scdn.co";
}

async function main() {
  const me = await api<{ id: string }>("/me");
  const targets: { playlist: Playlist; count: number }[] = [];

  for await (const p of paginate<Playlist>("/me/playlists?limit=50")) {
    if (p?.owner?.id !== me.id) continue;
    // Only ours to restyle: the generated sets. Never overwrite a hand made cover.
    if (!/^(Genre: |Liked \d{4}$)/.test(p.name ?? "")) continue;
    if (!lacksRealCover(p)) {
      console.log(`${p.name}: already has a real cover, skipping`);
      continue;
    }
    let count = 0;
    for await (const _ of paginate(`/playlists/${p.id}/items?limit=100&fields=items(item(uri)),next`))
      count++;
    targets.push({ playlist: p, count });
  }

  console.log(`\n${targets.length} playlists need a cover\n`);

  let done = 0;
  let failed = 0;
  for (const { playlist, count } of targets) {
    try {
      const b64 = await renderJpeg(playlist.name, count);
      if (DRY_RUN) {
        console.log(`${playlist.name}: rendered (${Math.round(b64.length / 1024)} KB base64)`);
        done++;
        continue;
      }
      await api(`/playlists/${playlist.id}/images`, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: b64,
      });
      console.log(`${playlist.name}: uploaded`);
      done++;
    } catch (e) {
      failed++;
      console.error(`${playlist.name}: FAILED ${(e as Error).message}`);
    }
  }

  console.log(`\n${DRY_RUN ? "Rendered" : "Uploaded"} ${done}, failed ${failed}`);
  if (DRY_RUN) console.log(`JPEGs in ${OUT_DIR}`);
  if (failed) process.exit(1);
}

await main();
