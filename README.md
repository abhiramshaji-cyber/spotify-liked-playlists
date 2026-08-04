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

bun run covers       # generate and upload playlist cover art
bun run covers:dry   # render covers to .cache/covers/ and stop

bun run dry:genre    # preview genre mode, writes nothing
bun run sync:genre   # create "Genre: pop", "Genre: electro house", ...
```

Genre mode defaults to **MusicBrainz** as the genre source, because Spotify's own genre
route gets you rate limited for a day (see below). To use Spotify's genres instead, drop
the flag: `bun run sync.ts --by=genre`.

Always run the dry variant first. Genre vocabulary is granular enough that a flat split
gets ugly fast: on a 1097 song library it produced **105 playlists, 57 of them holding one
or two songs**. Use `--min=N` to collapse that tail, and read the counts off the dry run
before writing:

| Threshold | Playlists | With <=2 songs | In `other` |
|---|---|---|---|
| flat | 105 | 57 | 0 |
| `--min=8` | 23 | 0 | 45 |
| `--min=12` | 13 | 0 | 66 |
| `--min=20` | 9 | 0 | 108 |

`bun run sync:genre` defaults to `--min=8`.

Changing the threshold later creates a **new** set of playlists and leaves the old ones
behind, because idempotency is keyed on playlist name. Delete the previous set yourself if
you switch.

Both modes are **idempotent**. They read each playlist back, diff against your liked
songs, and append only what is missing, so re-running is safe and your manual edits to
those playlists survive.

## How it works

- `spotify.ts` API client. Owns token refresh, rate limit handling, pagination.
- `auth.ts` one time OAuth login on a loopback server.
- `genres.ts` resolves artist genres and caches them on disk.
- `sync.ts` reads Liked Songs, buckets them, upserts the playlists.
- `covers.ts` generates a cover per playlist as SVG, renders it to JPEG, uploads it.

Songs are ordered oldest to newest within each playlist. Local files are skipped because
they have no Spotify uri the API can add.

**Genre resolution:** genres live on the *artist*, never on the track. A track's primary
genre is the first genre of its first artist that has any, falling back through the other
artists. Both sources order genres by relevance, so index 0 is the prominent one. Tracks
whose artists carry no genre at all land in `Genre: unknown` rather than being dropped.

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

### Tell the two 403s apart, it saves hours

There are two completely different 403s and the wording is the only clue:

- `{"message": "Forbidden"}` bare, no reason → **a retired endpoint**. Scopes are fine.
- `{"message": "Insufficient client scope"}` → genuinely a missing scope.

Confirm scopes by reading `scope` off the token refresh response before suspecting them.
In this project all four were granted the whole time and every bare 403 was a dead
endpoint.

Note how inconsistent it is: `PUT /playlists/{id}` (change details) and
`DELETE /playlists/{id}/followers` both work fine with the same token that gets a bare
403 on `/playlists/{id}/tracks`. Endpoint by endpoint, not scope by scope.

### Rate limits are per endpoint, shared across catalog, and brutal

Crawling a few hundred artists through `/artists/{id}` earned a `Retry-After` of
**85368 seconds**, about 23.7 hours, with `"reason": "QUOTA_EXCEEDED"`. Meanwhile `/me`
and `/me/tracks` kept working normally.

The catalog endpoints share that bucket: once `/artists/{id}` was locked, `/albums/{id}`
returned 429 too. Account endpoints were unaffected.

So: never sleep through `Retry-After` blindly. `spotify.ts` caps in process sleeps at 60
seconds and throws `RateLimited` beyond that, and `genres.ts` checkpoints its cache every
25 artists so a lockout costs you nothing but time. Re-run and it resumes.

The artist caches in `.cache/` are what make genre mode practical. Genres change rarely,
so after the first full crawl re-runs are nearly free. Delete a cache file to force a
refresh.

### Getting genres out of Spotify is the hardest part

Genres exist only on the artist object, and every cheap way to read them in bulk is gone:

| Route | Result |
|---|---|
| `GET /artists?ids=` (50 at a time) | 403, batch endpoint retired |
| `GET /artists/{id}` | works, but one request per artist and it triggers the 24h quota lock |
| `GET /search?type=artist` | works and is **not** quota limited, but `genres` is stripped from results |
| `GET /albums/{id}` and `/albums?ids=` | album `genres` is near always empty anyway |
| `GET /me/top/artists`, `/me/following?type=artist` | full artist objects **with** genres, but only a subset of your library, and they need `user-top-read` / `user-follow-read` |

Hence the MusicBrainz path below.

### MusicBrainz as the genre source

`--source=musicbrainz` sidesteps Spotify's quota entirely. No API key, no auth. Two
gotchas, both handled in `genres.ts`:

- **`tags` are not genres.** The free text `tags` list contains `english`, `2010s`,
  `philanthropist`, `actors`, `filmschauspieler`. Use the separate curated `genres` list
  from `/artist/{mbid}?inc=genres`, which is clean.
- **`score=100` does not mean it matched.** Searching `"IVIE"` returns `Ivie Anderson`
  with a perfect score. Only trust a normalized exact name equality; anything else must be
  treated as unresolved.

MusicBrainz asks for at most one request per second and blocks generic user agents, so set
a real `User-Agent`. It throttles with **503**, not 429. Two requests per artist means a
full crawl of ~760 artists takes roughly half an hour, once.

### Telling a real cover from Spotify's auto art

The playlist object always has `images` populated, so an empty array is **not** how you
find playlists lacking a cover. Read the host instead:

| Host | Meaning |
|---|---|
| `mosaic.scdn.co` | auto generated 4 tile mosaic, no real cover |
| `i.scdn.co` | single album's art, used when a playlist has too few tracks for a mosaic |
| `image-cdn-*.spotifycdn.com` | a genuine custom upload |

`covers.ts` treats the first two as "needs a cover" and never overwrites the third.

### Uploading a cover

`PUT /playlists/{id}/images` with `Content-Type: image/jpeg` and a **base64 string as the
raw body**, not JSON, not multipart. Needs the `ugc-image-upload` scope, which is easy to
forget since nothing else here uses it. JPEG only, and the base64 payload must stay under
256 KB, so `covers.ts` steps quality down until it fits.

Generation is `rsvg-convert` for SVG to PNG then `sips` for PNG to JPEG, both already on
macOS. When sizing text in SVG, note Helvetica Bold caps run about **0.70em per glyph**;
a 0.63 estimate silently clipped the longer titles off the right edge.

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

To check whether a playlist is genuinely public, fetch the owner's profile page
anonymously and look for it: `https://open.spotify.com/user/{user_id}`. Do **not** test by
fetching the playlist URL directly, because Spotify "private" playlists are still reachable
by direct link, so a 200 there proves nothing. `GET /users/{id}/playlists` with a
client credentials token would be the clean check, but it is 403 post migration.

## Exit codes

- `0` success
- `1` some tracks failed to add, re-run to retry them
- `2` rate limited, the message tells you when to resume
