/**
 * One time login. Opens the Spotify consent screen, catches the redirect on
 * 127.0.0.1:8888, and stores a refresh token in .tokens.json.
 */
import { credentials, exchangeCode, SCOPES } from "./spotify";

const { clientId, redirectUri } = credentials();
const state = crypto.randomUUID();

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    show_dialog: "true",
  });

const port = Number(new URL(redirectUri).port || 8888);

const done = new Promise<void>((resolve, reject) => {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== new URL(redirectUri).pathname) {
        return new Response("Not found", { status: 404 });
      }

      const error = url.searchParams.get("error");
      if (error) {
        setTimeout(() => {
          server.stop();
          reject(new Error(`Spotify returned: ${error}`));
        }, 100);
        return new Response(`Authorization failed: ${error}`, { status: 400 });
      }

      if (url.searchParams.get("state") !== state) {
        return new Response("State mismatch, refusing.", { status: 400 });
      }

      const code = url.searchParams.get("code");
      if (!code) return new Response("No code in callback.", { status: 400 });

      try {
        await exchangeCode(code);
      } catch (e) {
        setTimeout(() => {
          server.stop();
          reject(e as Error);
        }, 100);
        return new Response(String(e), { status: 500 });
      }

      setTimeout(() => {
        server.stop();
        resolve();
      }, 100);

      return new Response(
        `<!doctype html><meta charset="utf-8">
         <body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">
         <div><h2>Authorized.</h2><p>You can close this tab and go back to the terminal.</p></div>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });

  console.log(`Listening on http://127.0.0.1:${port}`);
});

console.log("\nOpening Spotify authorization page in your browser.");
console.log("If it does not open, paste this URL yourself:\n");
console.log(authUrl + "\n");

Bun.spawn(["open", authUrl]);

await done;
console.log("Refresh token saved to .tokens.json. Now run: bun run sync.ts");
