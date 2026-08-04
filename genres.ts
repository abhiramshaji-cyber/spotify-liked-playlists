/**
 * Resolves artist genres, which is the only genre source the Web API exposes.
 * Cached on disk because the batch endpoint is gone and each artist costs one request.
 */
import { api, RateLimited } from "./spotify";

const CACHE_FILE = new URL(".cache/artists.json", import.meta.url).pathname;

export type ArtistEntry = { name: string; genres: string[] };
export type ArtistCache = Record<string, ArtistEntry>;

export async function loadCache(): Promise<ArtistCache> {
  const file = Bun.file(CACHE_FILE);
  return (await file.exists()) ? file.json() : {};
}

export async function saveCache(cache: ArtistCache) {
  await Bun.write(CACHE_FILE, JSON.stringify(cache, null, 0));
}

/**
 * Fills the cache for every id given, most frequent first so a rate limit stop
 * still leaves the artists that matter most resolved.
 * Returns how many remain unresolved; a RateLimited stop is not an error here.
 */
export async function resolveArtists(
  ids: string[],
  cache: ArtistCache,
): Promise<{ fetched: number; remaining: number; limited: RateLimited | null }> {
  const todo = ids.filter((id) => !(id in cache));
  let fetched = 0;

  for (const id of todo) {
    try {
      // GET /artists?ids= (batch) returns 403 since the March 2026 migration.
      const a = await api<{ name: string; genres?: string[] }>(`/artists/${id}`);
      cache[id] = { name: a.name, genres: a.genres ?? [] };
      fetched++;
    } catch (e) {
      if (e instanceof RateLimited) {
        await saveCache(cache);
        return { fetched, remaining: todo.length - fetched, limited: e };
      }
      throw e;
    }
    if (fetched % 25 === 0) {
      await saveCache(cache);
      console.log(`  resolved ${fetched}/${todo.length} artists`);
    }
  }

  await saveCache(cache);
  return { fetched, remaining: 0, limited: null };
}

/**
 * The track's most prominent genre: the first genre of its first artist that has any.
 * Spotify orders an artist's genres by relevance, so index 0 is the prominent one.
 */
export function primaryGenre(artistIds: string[], cache: ArtistCache): string | null {
  for (const id of artistIds) {
    const g = cache[id]?.genres?.[0];
    if (g) return g;
  }
  return null;
}
