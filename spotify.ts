/**
 * Thin Spotify Web API client.
 * Owns credentials, token refresh, rate limit backoff and pagination.
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const TOKEN_FILE = new URL(".tokens.json", import.meta.url).pathname;

export const SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

export function credentials() {
  const clientId = Bun.env.SPOTIFY_CLIENT_ID;
  const clientSecret = Bun.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = Bun.env.SPOTIFY_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET or SPOTIFY_REDIRECT_URI in .env",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function basicAuth() {
  const { clientId, clientSecret } = credentials();
  return "Basic " + btoa(`${clientId}:${clientSecret}`);
}

type Tokens = {
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
};

async function readTokens(): Promise<Tokens> {
  const file = Bun.file(TOKEN_FILE);
  if (!(await file.exists())) {
    throw new Error("Not authorized yet. Run: bun run auth.ts");
  }
  return file.json();
}

async function writeTokens(tokens: Tokens) {
  await Bun.write(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

/** Exchanges an authorization code for tokens and persists the refresh token. */
export async function exchangeCode(code: string) {
  const { redirectUri } = credentials();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${JSON.stringify(body)}`);
  }
  await writeTokens({
    refresh_token: body.refresh_token,
    access_token: body.access_token,
    expires_at: Date.now() + body.expires_in * 1000,
  });
}

async function refresh(tokens: Tokens): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Token refresh failed: ${JSON.stringify(body)}. Delete .tokens.json and re-run auth.ts.`,
    );
  }
  const next: Tokens = {
    // Spotify may or may not rotate the refresh token. Keep the old one if it does not.
    refresh_token: body.refresh_token ?? tokens.refresh_token,
    access_token: body.access_token,
    expires_at: Date.now() + body.expires_in * 1000,
  };
  await writeTokens(next);
  return next.access_token!;
}

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(force = false): Promise<string> {
  if (!force && cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.token;
  }
  const tokens = await readTokens();
  if (!force && tokens.access_token && (tokens.expires_at ?? 0) - Date.now() > 60_000) {
    cached = { token: tokens.access_token, expiresAt: tokens.expires_at! };
    return cached.token;
  }
  const token = await refresh(tokens);
  cached = { token, expiresAt: Date.now() + 3_000_000 };
  return token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_SLEEP_SECONDS = 60;

/** Thrown when Retry-After exceeds what is reasonable to wait out in process. */
export class RateLimited extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    readonly url: string,
  ) {
    const hours = (retryAfterSeconds / 3600).toFixed(1);
    super(`Rate limited on ${url} for ${retryAfterSeconds}s (~${hours}h)`);
    this.name = "RateLimited";
  }
}

export function resumeHint(e: RateLimited): string {
  const at = new Date(Date.now() + e.retryAfterSeconds * 1000);
  return `Spotify rate limited this endpoint for ~${(e.retryAfterSeconds / 3600).toFixed(1)}h (until about ${at.toLocaleString()}).\nProgress is cached. Re-run the same command after that and it picks up where it stopped.`;
}

/**
 * Calls the Web API. Retries on 429 using Retry-After, refreshes once on 401,
 * and backs off on 5xx. Throws with the Spotify error body on anything else.
 */
export async function api<T = any>(
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<T> {
  const url = path.startsWith("http") ? path : API_BASE + path;
  const token = await accessToken();

  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After") ?? 2) + 1;
    // Spotify hands out multi-hour Retry-After values per endpoint. Sleeping through
    // one would hang the process for a day, so surface it and let the caller resume.
    if (wait > MAX_SLEEP_SECONDS) throw new RateLimited(wait, url);
    console.log(`  rate limited, waiting ${wait}s`);
    await sleep(wait * 1000);
    return api<T>(path, init, attempt + 1);
  }

  if (res.status === 401 && attempt === 0) {
    await accessToken(true);
    return api<T>(path, init, attempt + 1);
  }

  if (res.status >= 500 && attempt < 3) {
    await sleep(1000 * 2 ** attempt);
    return api<T>(path, init, attempt + 1);
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const detail = body?.error?.message ?? text;
    if (res.status === 403) {
      throw new Error(
        `403 from ${url}: ${detail}\n` +
          `This usually means a missing scope. Delete .tokens.json and re-run auth.ts.`,
      );
    }
    throw new Error(`${res.status} from ${url}: ${detail}`);
  }

  return body as T;
}

/** Walks a paged endpoint and yields every item. */
export async function* paginate<T>(path: string): AsyncGenerator<T> {
  let next: string | null = path;
  while (next) {
    const page: { items: T[]; next: string | null } = await api(next);
    for (const item of page.items) yield item;
    next = page.next;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
