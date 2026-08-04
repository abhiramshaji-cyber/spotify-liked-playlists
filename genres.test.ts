import { assignGenres, UNKNOWN, OTHER } from "./genres";

const cache = {
  a: { name: "A", genres: ["pop"] },
  b: { name: "B", genres: ["melodic dubstep", "edm"] },
  c: { name: "C", genres: ["edm"] },
  d: { name: "D", genres: ["throat singing"] },
  e: { name: "E", genres: [] },
};
const t = (uri: string, ids: string[]) => ({ uri, artistIds: ids });
const tracks = [
  ...Array.from({ length: 5 }, (_, i) => t(`pop${i}`, ["a"])),
  ...Array.from({ length: 3 }, (_, i) => t(`edm${i}`, ["c"])),
  t("dub1", ["b"]),          // rare primary, has a popular sibling
  t("throat1", ["d"]),       // rare primary, no popular sibling
  t("none1", ["e"]),         // artist has no genres
  t("noartist", []),         // no artists at all
];

let pass = 0, fail = 0;
const check = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${JSON.stringify(got)}${ok ? "" : ` want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

const flat = assignGenres(tracks, cache, 0);
check("min=0 keeps rare genre verbatim", flat.get("dub1"), "melodic dubstep");
check("min=0 distinct buckets", new Set(flat.values()).size, 5);

const col = assignGenres(tracks, cache, 3);
check("rare collapses to popular sibling", col.get("dub1"), "edm");
check("rare with no sibling -> other", col.get("throat1"), OTHER);
check("no genres -> unknown", col.get("none1"), UNKNOWN);
check("no artists -> unknown", col.get("noartist"), UNKNOWN);
check("popular genre untouched", col.get("pop0"), "pop");
check("edm bucket grew by the refiled track", [...col.values()].filter(v => v === "edm").length, 4);
check("every track assigned", col.size, tracks.length);
check("collapsed bucket count", new Set(col.values()).size, 4);

// threshold above everything must not silently drop tracks
const brutal = assignGenres(tracks, cache, 999);
check("min=999 assigns all tracks", brutal.size, tracks.length);
check("min=999 -> other/unknown only", [...new Set(brutal.values())].sort(), [OTHER, UNKNOWN]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
