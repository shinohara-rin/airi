# airi-plugin-airicraft

Lets AIRI play Minecraft through the [airicraft](https://github.com/proj-airi/airicraft) mod. It gives the agent the mod's tools and its events.

## What it does

- Registers each tool of the mod as an agent tool. Names start with `ac_`. Tools of the mod's own planner stay hidden, because the agent owns speech, goals, and wake policy.
- Turns the mod's event feed into agent events. Each event type has a trigger: a reflex start preempts, outcomes and direct chat flush, percepts debounce, and bookkeeping is archived.
- Cuts each tool receipt to 20 000 characters and says how much it left out. The event list in `observe` is replaced by a note, because those events already arrive as events.
- Gives one notice when the bridge stops answering and one when it returns. The plugin starts at the present after each connection.

## When to use it

Use it in AIRI desktop (Tamagotchi) when the airicraft mod runs on the same machine. The game can start after AIRI. The plugin connects when the mod's bridge answers.

Do not use it for a game on another machine. The bridge listens on `127.0.0.1` only.

## How it finds the mod

The mod writes its port and token to a discovery file on every launch. The plugin reads the path from `AIRICRAFT_BRIDGE_STATE_FILE`. When that is not set, it reads `~/.airicraft/bridge-state.json`.

## Build

```sh
pnpm -F @proj-airi/airi-plugin-airicraft build
```

The build writes `dist/extension.mjs`, which `extension.airi.json` names as the Electron entry point. Install the whole folder as an AIRI extension.

## Test

```sh
pnpm -F @proj-airi/airi-plugin-airicraft exec vitest run
pnpm -F @proj-airi/airi-plugin-airicraft typecheck
```

The tests use an in-process stand-in for the bridge. They do not need the game.

## Files

| File | Job |
| --- | --- |
| `src/bridge.ts` | HTTP client for the bridge and its discovery file. |
| `src/events.ts` | Trigger rules and event text. |
| `src/tools.ts` | Tool definitions, hidden tools, and receipt shaping. |
| `src/link.ts` | Poll loop, tool registration, and connection notices. |
| `src/index.ts` | The extension entry point. |
