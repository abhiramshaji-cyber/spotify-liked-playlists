# spotify-liked-playlists

Turns your Spotify **Liked Songs** into playlists, either by the year you liked each song
or by its primary genre. Written against the Spotify Web API as it behaves **after the
March 2026 migration**, which broke most of the endpoints the docs and every tutorial
still tell you to use.

Read the [API landmines](#api-landmines-post-march-2026) section before writing any new
Spotify code. That is the whole reason this repo exists.

## Setup

1. Create an app at <https://developer.spotify.com/dashboard>. Check **Web API** only.
2. Add `http://127.0.0.1:8888/callback` to **Redirect URIs**, click **Add**, then **Save**.
   It must be the literal loopback IP. Spotify rejects `localhost` outright.
3. Copy `.env.example` to `.env` and fill in your client id and secret.
4. Log in once:

```sh
bun install
bun run auth
```

That writes a refresh token to `.tokens.json`. You never log in again.

## Usage

```sh
bun run dry          # preview year mode, writes nothing
bun run sync         # create "Liked 2019", "Liked 2020", ...

bun run dry:genre    # preview genre mode, writes nothing
bun run sync:genre   # create "Genre: dance pop", "Genre: edm", ...
```

Always run the dry variant first. Genre mode can produce a lot of playlists because
Spotify's genre vocabulary is granular, and the dry run tells you exactly how many and
how big before anything is written to your account.

Both modes are **idempotent**. They read each playlist back, diff against your liked
songs, and append only what is missing, so re-running is safe and your manual edits to
those playlists survive.

## How it works

- `spotify.ts` API client. Owns token refresh, rate limit handling, pagination.
- `auth.ts` one time OAuth login on a loopback server.
- `genres.ts` resolves artist genres and caches them on disk.
- `sync.ts` reads Liked Songs, buckets them, upserts the playlists.

Songs are ordered oldest to newest within each playlist. Local files are skipped because
they have no Spotify uri the API can add.

**Genre resolution:** genres live on the *artist*, never on the track. A track's primary
genre is the first genre of its first artist that has any, falling back through the other
artists. Spotify orders an artist's genres by relevance, so index 0 is the prominent one.
Tracks whose artists carry no tags at all land in `Genre: unknown` rather than being
dropped.

## API landmines, post March 2026

Every one of these cost real debugging time. All symptoms are a bare
`403 {"error":{"status":403,"message":"Forbidden"}}` with **no indication of the cause**,
which is what makes them expensive.

| What the docs say | Reality | Use instead |
|---|---|---|
| `POST /v1/playlists/{id}/tracks` | 403, removed in the March 2026 migration | `POST /v1/playlists/{id}/items` |
| `GET /v1/playlists/{id}/tracks` | 403 | `GET /v1/playlists/{id}/items` |
| response wrapper field is `track` | renamed | `item` (so `fields=items(item(uri))`) |
| `POST /v1/users/{user_id}/playlists` | 403 | `POST /v1/me/playlists` |
| `GET /v1/artists?ids=` (batch, 50 at a time) | 403 | `GET /v1/artists/{id}`, one request each |
| playlist object has `tracks.total` | field is gone | read the items endpoint to count |

### A 403 here almost never means a missing scope

That is the intuitive assumption and it wastes hours. Confirm scopes are actually granted
by reading `scope` off the token refresh response before you suspect them. In this project
all four scopes were granted the whole time and the 403s were entirely about retired
endpoints.

Note how inconsistent it is: `PUT /playlists/{id}` (change details) and
`DELETE /playlists/{id}/followers` both work fine with the same token that gets 403 on
`/playlists/{id}/tracks`. Endpoint by endpoint, not scope by scope.

### Rate limits are per endpoint and brutal

Crawling a few hundred artists through the single artist endpoint earned a
`Retry-After` of **85368 seconds**, about 23.7 hours, on `/artists/{id}` specifically,
while `/me` kept working normally.

So: never sleep through `Retry-After` blindly. `spotify.ts` caps in process sleeps at 60
seconds and throws `RateLimited` beyond that, and `genres.ts` checkpoints its cache every
25 artists so a lockout costs you nothing but time. Re-run the same command after the
window and it resumes.

The artist cache in `.cache/artists.json` is what makes genre mode practical. Genres
change rarely, so after the first full crawl re-runs are nearly free. Delete the file to
force a refresh.

### `popularity` is always 0

The field is present on every track object and returns `0` for all of them. Do not build
anything on it.

### Development Mode

Apps start in Development Mode, capped at a small allowlist of users, which is fine for
personal use. Non allowlisted users get 403s, so if you share this, add them under **User
Management** in the dashboard.

### Playlists come out public and stay public

`public: false` on creation is accepted and ignored. A follow up
`PUT /playlists/{id}` with `{"public": false}` returns success and the value does not
change. There is no API path to fix this; set it in the Spotify client
(right click a playlist, **Make private**).

## Exit codes

- `0` success
- `1` some tracks failed to add, re-run to retry them
- `2` rate limited, the message tells you when to resume
