/**
 * Resolves a genre per artist from one of two sources into one shared cache shape,
 * keyed by Spotify artist id, so the bucketing logic never needs to know which.
 */
import { api, RateLimited } from "./spotify";

export type Source = "spotify" | "musicbrainz";
export type Artist = { id: string; name: string };
export type ArtistEntry = { name: string; genres: string[] };
export type ArtistCache = Record<string, ArtistEntry>;

const cacheFile = (source: Source) => new URL(`.cache/${source}.json`, import.meta.url).pathname;

export async function loadCache(source: Source): Promise<ArtistCache> {
  const file = Bun.file(cacheFile(source));
  return (await file.exists()) ? file.json() : {};
}

export async function saveCache(source: Source, cache: ArtistCache) {
  await Bun.write(cacheFile(source), JSON.stringify(cache));
}

export type Progress = { fetched: number; remaining: number; limited: RateLimited | null };

/** Artists must arrive most frequent first so an early stop leaves the ones that matter resolved. */
export async function resolveArtists(
  source: Source,
  artists: Artist[],
  cache: ArtistCache,
): Promise<Progress> {
  const todo = artists.filter((a) => !(a.id in cache));
  return source === "spotify" ? viaSpotify(todo, cache) : viaMusicBrainz(todo, cache);
}

async function checkpoint(source: Source, cache: ArtistCache, n: number, total: number) {
  if (n === 0 || n % 10 !== 0) return;
  await saveCache(source, cache);
  console.log(`  resolved ${n}/${total} artists`);
}

async function viaSpotify(todo: Artist[], cache: ArtistCache): Promise<Progress> {
  let fetched = 0;
  for (const artist of todo) {
    try {
      // GET /artists?ids= (batch) returns 403 since the March 2026 migration.
      const a = await api<{ name: string; genres?: string[] }>(`/artists/${artist.id}`);
      cache[artist.id] = { name: a.name, genres: a.genres ?? [] };
      fetched++;
    } catch (e) {
      if (e instanceof RateLimited) {
        await saveCache("spotify", cache);
        return { fetched, remaining: todo.length - fetched, limited: e };
      }
      throw e;
    }
    await checkpoint("spotify", cache, fetched, todo.length);
  }
  await saveCache("spotify", cache);
  return { fetched, remaining: 0, limited: null };
}

const MB = "https://musicbrainz.org/ws/2";
const MB_UA =
  "spotify-liked-playlists/1.0 (https://github.com/abhiramshaji-cyber/spotify-liked-playlists)";
const MB_DELAY_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function mbFetch(path: string, attempt = 0): Promise<any> {
  const res = await fetch(`${MB}${path}`, { headers: { "User-Agent": MB_UA } });
  // MusicBrainz throttles with 503 rather than 429 and expects about 1 request per second.
  if (res.status >= 500 && attempt < 4) {
    await sleep(2000 * (attempt + 1));
    return mbFetch(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`MusicBrainz ${res.status} on ${path}`);
  return res.json();
}

/**
 * Two requests per artist: search by name, then read curated genres by MBID.
 * MusicBrainz `tags` are free text and contain junk like "english" or "actors",
 * so only the separate `genres` list is usable here.
 */
async function viaMusicBrainz(todo: Artist[], cache: ArtistCache): Promise<Progress> {
  let fetched = 0;
  let unmatched = 0;

  for (const artist of todo) {
    try {
      const q = encodeURIComponent(`"${artist.name.replace(/"/g, "")}"`);
      const found = await mbFetch(`/artist?query=artist:${q}&fmt=json&limit=5`);
      await sleep(MB_DELAY_MS);

      // MB returns score=100 for clearly wrong artists, so trust only an exact name match.
      const match = (found.artists ?? []).find(
        (a: any) => normalize(a.name ?? "") === normalize(artist.name),
      );
      if (!match) {
        cache[artist.id] = { name: artist.name, genres: [] };
        unmatched++;
        fetched++;
        await checkpoint("musicbrainz", cache, fetched, todo.length);
        continue;
      }

      const full = await mbFetch(`/artist/${match.id}?inc=genres&fmt=json`);
      await sleep(MB_DELAY_MS);
      cache[artist.id] = {
        name: artist.name,
        genres: (full.genres ?? [])
          .sort((a: any, b: any) => (b.count ?? 0) - (a.count ?? 0))
          .map((g: any) => g.name as string),
      };
      fetched++;
    } catch (e) {
      // Left uncached deliberately so the next run retries instead of locking in a miss.
      console.error(`  ${artist.name}: ${(e as Error).message}`);
    }
    await checkpoint("musicbrainz", cache, fetched, todo.length);
  }

  await saveCache("musicbrainz", cache);
  if (unmatched) console.log(`  ${unmatched} artists had no confident name match`);
  return { fetched, remaining: todo.length - fetched, limited: null };
}

/**
 * The track's most prominent genre: the first genre of its first artist that has any.
 * Both sources order genres by relevance, so index 0 is the prominent one.
 */
export function primaryGenre(artistIds: string[], cache: ArtistCache): string | null {
  for (const id of artistIds) {
    const g = cache[id]?.genres?.[0];
    if (g) return g;
  }
  return null;
}

/** Every genre a track could be filed under, best first, for collapsing rare buckets. */
export function candidateGenres(artistIds: string[], cache: ArtistCache): string[] {
  const seen = new Set<string>();
  for (const id of artistIds) for (const g of cache[id]?.genres ?? []) seen.add(g);
  return [...seen];
}

/** Reserved bucket labels; a genre with either name would be shadowed. */
export const UNKNOWN = "unknown";
export const OTHER = "other";

/**
 * Final genre bucket per track, keyed by uri. With minTracks > 1, a track whose primary
 * genre is claimed by fewer than that many tracks is refiled under its next genre that
 * clears the bar, so the long tail of one song playlists collapses.
 */
export function assignGenres(
  tracks: { uri: string; artistIds: string[] }[],
  cache: ArtistCache,
  minTracks: number,
): Map<string, string> {
  const primary = new Map<string, string | null>();
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const g = primaryGenre(t.artistIds, cache);
    primary.set(t.uri, g);
    if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  for (const t of tracks) {
    const g = primary.get(t.uri) ?? null;
    if (!g) {
      out.set(t.uri, UNKNOWN);
      continue;
    }
    // Counts stay fixed: refiling only ever moves tracks into already popular buckets.
    if (minTracks <= 1 || (counts.get(g) ?? 0) >= minTracks) {
      out.set(t.uri, g);
      continue;
    }
    const fallback = candidateGenres(t.artistIds, cache).find(
      (c) => (counts.get(c) ?? 0) >= minTracks,
    );
    out.set(t.uri, fallback ?? OTHER);
  }
  return out;
}
