/**
 * Buckets every liked song into playlists, either by the year you liked it
 * ("Liked 2019") or by its primary genre ("Genre: dance pop").
 * Safe to re-run: only missing tracks are appended, manual edits are preserved.
 *
 *   bun run sync.ts                    year mode
 *   bun run sync.ts --by=genre         genre mode, genres from Spotify
 *   bun run sync.ts --by=genre --source=musicbrainz   genres from MusicBrainz
 *   bun run sync.ts --dry-run          preview, writes nothing
 */
import { api, paginate, chunk, RateLimited, resumeHint } from "./spotify";
import { loadCache, resolveArtists, assignGenres, UNKNOWN, OTHER, type Source } from "./genres";

const DRY_RUN = process.argv.includes("--dry-run");
const MODE = process.argv.includes("--by=genre") ? "genre" : "year";
const SOURCE: Source = process.argv.includes("--source=musicbrainz") ? "musicbrainz" : "spotify";
const MIN_TRACKS = Number(process.argv.find((a) => a.startsWith("--min="))?.slice(6) ?? 0);

type SavedTrack = {
  added_at: string;
  track: {
    uri: string;
    name: string;
    is_local: boolean;
    artists: { id: string | null; name: string }[];
  } | null;
};

type Playlist = { id: string; name: string; owner: { id: string } };

type Liked = { uri: string; addedAt: string; artists: { id: string; name: string }[] };

async function collectLiked() {
  const rows: Liked[] = [];
  let total = 0;
  let skippedLocal = 0;
  let skippedNull = 0;

  for await (const item of paginate<SavedTrack>("/me/tracks?limit=50")) {
    total++;
    const t = item.track;
    if (!t) {
      skippedNull++;
      continue;
    }
    if (t.is_local || !t.uri?.startsWith("spotify:track:")) {
      skippedLocal++;
      continue;
    }
    rows.push({
      uri: t.uri,
      addedAt: item.added_at,
      artists: (t.artists ?? [])
        .filter((a): a is { id: string; name: string } => !!a?.id)
        .map((a) => ({ id: a.id, name: a.name })),
    });
    if (total % 500 === 0) console.log(`  read ${total} liked songs`);
  }

  return { rows, total, skippedLocal, skippedNull };
}

/** Playlist name per liked song, plus the description to give a newly created one. */
type Bucketing = { name: (t: Liked) => string; describe: (name: string) => string };

function yearBucketing(): Bucketing {
  return {
    name: (t) => `Liked ${t.addedAt.slice(0, 4)}`,
    describe: (name) => `Songs I liked in ${name.replace("Liked ", "")}. Generated automatically.`,
  };
}

async function genreBucketing(rows: Liked[]): Promise<Bucketing> {
  const cache = await loadCache(SOURCE);
  const counts = new Map<string, number>();
  const named = new Map<string, string>();
  for (const r of rows)
    for (const a of r.artists) {
      counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
      named.set(a.id, a.name);
    }
  const ids = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!);
  const artists = ids.map((id) => ({ id, name: named.get(id)! }));

  const already = ids.filter((id) => id in cache).length;
  console.log(`Genres via ${SOURCE}: ${already}/${ids.length} artists cached, resolving the rest...`);
  const { fetched, remaining, limited } = await resolveArtists(SOURCE, artists, cache);
  console.log(`Resolved ${fetched} artists this run, ${remaining} still unresolved.`);

  if (limited) {
    console.error(`\n${resumeHint(limited)}`);
    console.error(
      `Refusing to build genre playlists from ${remaining} unresolved artists, ` +
        `they would all land in "Genre: unknown" and pollute the result.`,
    );
    process.exit(2);
  }

  const withGenres = ids.filter((id) => cache[id]?.genres?.length).length;
  console.log(`${withGenres}/${ids.length} artists carry genre tags.\n`);

  const assign = assignGenres(
    rows.map((r) => ({ uri: r.uri, artistIds: r.artists.map((a) => a.id) })),
    cache,
    MIN_TRACKS,
  );

  return {
    name: (t) => `Genre: ${assign.get(t.uri) ?? UNKNOWN}`,
    describe: (name) =>
      name === `Genre: ${UNKNOWN}`
        ? "Liked songs whose artists carry no genre tags in either source."
        : name === `Genre: ${OTHER}`
        ? "Liked songs whose genre is too rare in this library to deserve its own playlist."
        : `Liked songs whose primary genre is ${name.replace("Genre: ", "")}. Generated automatically.`,
  };
}



async function findMyPlaylists(userId: string) {
  const mine = new Map<string, Playlist>();
  for await (const p of paginate<Playlist>("/me/playlists?limit=50")) {
    if (p?.owner?.id === userId) mine.set(p.name, p);
  }
  return mine;
}

/**
 * March 2026 migration: /playlists/{id}/tracks is gone and the wrapper field
 * `track` became `item`. The old path returns a bare 403 for Development Mode apps.
 */
async function existingUris(playlistId: string) {
  const uris = new Set<string>();
  const path = `/playlists/${playlistId}/items?limit=100&fields=items(item(uri)),next`;
  for await (const entry of paginate<{ item: { uri: string } | null }>(path)) {
    if (entry.item?.uri) uris.add(entry.item.uri);
  }
  return uris;
}

async function main() {
  const me = await api<{ id: string; display_name: string }>("/me");
  console.log(`Signed in as ${me.display_name ?? me.id} | mode: ${MODE}${MODE === "genre" ? ` via ${SOURCE}` : ""}\n`);

  console.log("Reading your liked songs...");
  const { rows, total, skippedLocal, skippedNull } = await collectLiked();
  console.log(`Read ${total} liked songs.`);
  if (skippedLocal) console.log(`Skipped ${skippedLocal} local files (no Spotify uri).`);
  if (skippedNull) console.log(`Skipped ${skippedNull} unavailable tracks.`);
  console.log();

  const bucketing = MODE === "genre" ? await genreBucketing(rows) : yearBucketing();

  const buckets = new Map<string, Liked[]>();
  for (const r of rows) {
    const name = bucketing.name(r);
    if (!buckets.has(name)) buckets.set(name, []);
    buckets.get(name)!.push(r);
  }
  for (const list of buckets.values()) list.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  console.log(`${buckets.size} playlists to sync, ${rows.length} songs total.\n`);

  console.log("Looking up your existing playlists...");
  const mine = await findMyPlaylists(me.id);
  console.log(`You own ${mine.size} playlists.\n`);

  const names = [...buckets.keys()].sort();
  const summary: { name: string; liked: number; added: number; already: number; failed: number }[] =
    [];

  for (const name of names) {
    const tracks = buckets.get(name)!;
    let playlist = mine.get(name);
    const preexisting = playlist !== undefined;

    if (!playlist) {
      if (DRY_RUN) {
        console.log(`${name}: would create, ${tracks.length} tracks to add`);
        summary.push({ name, liked: tracks.length, added: tracks.length, already: 0, failed: 0 });
        continue;
      }
      // POST /users/{id}/playlists also 403s post migration; /me/playlists is the live path.
      playlist = await api<Playlist>("/me/playlists", {
        method: "POST",
        body: JSON.stringify({ name, public: false, description: bucketing.describe(name) }),
      });
      console.log(`${name}: created`);
    }

    // The migrated playlist object no longer carries tracks.total, so always read back.
    const present = preexisting ? await existingUris(playlist.id) : new Set<string>();

    const seen = new Set<string>();
    const toAdd: string[] = [];
    for (const t of tracks) {
      if (present.has(t.uri) || seen.has(t.uri)) continue;
      seen.add(t.uri);
      toAdd.push(t.uri);
    }
    const already = tracks.length - toAdd.length;

    if (DRY_RUN) {
      console.log(`${name}: ${tracks.length} liked, would add ${toAdd.length}, ${already} already there`);
      summary.push({ name, liked: tracks.length, added: toAdd.length, already, failed: 0 });
      continue;
    }

    let added = 0;
    let failed = 0;
    for (const batch of chunk(toAdd, 100)) {
      try {
        await api(`/playlists/${playlist.id}/items`, {
          method: "POST",
          body: JSON.stringify({ uris: batch }),
        });
        added += batch.length;
      } catch (e) {
        failed += batch.length;
        console.error(`  ${name}: a batch of ${batch.length} failed: ${(e as Error).message}`);
      }
    }

    console.log(
      `${name}: ${tracks.length} liked, ${added} added, ${already} already there` +
        (failed ? `, ${failed} FAILED` : ""),
    );
    summary.push({ name, liked: tracks.length, added, already, failed });
  }

  console.log("\n" + (DRY_RUN ? "Dry run summary" : "Done"));
  const width = Math.max(...summary.map((s) => s.name.length), 8);
  console.log(`${"playlist".padEnd(width)}  liked  added  already`);
  for (const s of summary) {
    console.log(
      `${s.name.padEnd(width)} ${String(s.liked).padStart(6)} ${String(s.added).padStart(6)} ${String(s.already).padStart(8)}` +
        (s.failed ? `  ${s.failed} failed` : ""),
    );
  }

  const failedTotal = summary.reduce((n, s) => n + s.failed, 0);
  if (failedTotal) {
    console.log(`\n${failedTotal} tracks failed to add. Re-run to retry them.`);
    process.exit(1);
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof RateLimited) {
    console.error(`\n${e.message}\n${resumeHint(e)}`);
    process.exit(2);
  }
  throw e;
}
