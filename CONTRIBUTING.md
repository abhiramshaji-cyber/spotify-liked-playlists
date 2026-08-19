# Contributing

Issues and pull requests are welcome. This is a small project, so the bar is
simple: keep each change focused on one thing, and say why in the description.

## Getting set up

```sh
bun install
cp .env.example .env    # then fill in your Spotify client id and secret
bun run auth
```

## Before opening a pull request

- Run `bun test`.
- Try your change with `bun run dry` first. It writes nothing, so it is the safe
  way to see what a sync would do to a real account.
- Never commit `.env` or `.tokens.json`. Both are gitignored; keep them that way.

If you hit a Spotify API behaviour that contradicts the official docs, please add
it to the API landmines section of the README. That section is the main reason
this repository exists, and it is the most useful thing you can contribute.

Please open an issue first for anything that changes behaviour or widens scope,
so the approach can be agreed before you spend time on it. Issues labelled
`good first issue` are self contained and a good place to start.
