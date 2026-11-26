# migo-wx-adapter

[English](README.md) | [中文](README.zh-CN.md)

Publishes `globalThis.wx`, aliased to the [migo](https://github.com/minigame-labs/migo-runtime) mini-game runtime's own `migo.*` capabilities. Lets mini-game content written against the `wx` global -- unmodified WeChat mini-game source, or content from a similarly-shaped mini-game platform -- run on migo unchanged.

The migo runtime installs only `migo` by default. `wx` is not built in, at any scale -- this adapter is how a game or host opts into it.

## When to use

- Your content is real, unmodified wx mini-game source (`wx.createCanvas()`, `wx.getSystemInfoSync()`, `wx.onTouchStart()`, ...).
- You're porting a WeChat mini-game and want to verify it runs before touching its source.

If your content calls `migo.*` directly, you don't need this adapter.

## What this is NOT

A reimplementation of wx. For every capability migo also implements, `wx.foo` and `migo.foo` are **the same function reference** -- this adapter is a naming/shaping layer over migo's own capabilities, not a new implementation of them. If migo doesn't implement a given wx API, `wx.thatApi` is `undefined` here exactly as it is on `migo` directly; no adapter can manufacture a capability the runtime doesn't have.

Concretely, that makes `wx` itself genuinely small: it is migo's own property descriptors copied onto a new object, under wx's names where those differ (see below). There's no protocol translation, no polyfilling, no behavioral shimming of `wx.*` -- that's the difference between this and the [BOM/DOM adapter (migo-web-adapter)](https://github.com/minigame-labs/migo-web-adapter), which does real work because browsers and wx mini-games don't share a capability model. wx mini-games and migo do.

Beside `wx` the adapter publishes the platform's two other globals a mini-game reaches for, which are the platform's and not capabilities of the runtime: `WXWebAssembly` and `requirePlugin` (below). They are written in terms of `migo.*`, and only where the platform defines them.

## Install

Plain ESM source -- no build step required.

```js
// game entry, BEFORE content that references `wx` runs
import "@minigame-labs/migo-wx-adapter";
// or, with a require/AMD loader:
require("./src/index.js");
```

The adapter detects re-entry via `globalThis.__migoWxAdapterInjected` and is safe to import twice. It's also safe to load alongside [`@minigame-labs/migo-web-adapter`](https://github.com/minigame-labs/migo-web-adapter) (BOM/DOM) -- they touch disjoint globals.

### Zero-touch testing via runtime boot prelude

Same mechanism as the BOM/DOM adapter: build the IIFE bundle once and feed it to the runtime via `InitOptions::with_prelude_script`, so third-party wx content that doesn't import this adapter itself still gets `wx` wired up before it runs.

```sh
npm run build
# → dist/migo-wx-adapter.bundle.js
```

```rust
let bundle = std::fs::read_to_string("path/to/migo-wx-adapter.bundle.js")?;
let init = InitOptions::new()
    .with_prelude_script("<migo-wx-adapter>", bundle)
    // ... other options
    ;
```

On Android, via `RuntimeConfig.Builder`:

```java
String bundle = readAssetAsString(context, "migo-wx-adapter.bundle.js");
RuntimeConfig config = new RuntimeConfig.Builder(context)
        .addPreludeScript("<migo-wx-adapter>", bundle)
        .build();
```

## Names that differ from `migo`

Every `migo.*` name is published on `wx` as the same function. migo carries no platform's brand, so where wx names an API after its own platform, migo names it for what it does and this adapter publishes it under wx's name:

| `migo` | `wx` |
|---|---|
| `updateHostApp` | `updateWeChatApp` |

## `WXWebAssembly`

Published beside `wx` where the engine has `WebAssembly`. `WXWebAssembly.instantiate(path, imports)`
takes the path of a `.wasm` file in the game's package -- not bytes, not a URL -- reads it through
the engine's file system, and answers as `WebAssembly.instantiate` does. Its other members are
`WebAssembly`'s own (`Memory`, `Table`, `Global`, `Module`, `Instance`, the error types); the ones
that take bytes (`compile`, `validate`, the streaming pair) are not offered. A brotli-compressed
`.wasm.br` is taken as the platform takes it: decoded by the engine's `readCompressedFile`.

## `requirePlugin`

`requirePlugin(name, options)` answers the exports of a plugin the game declares in its `game.json` `plugins`, made
once and shared by every `requirePlugin` of it. On the platform a plugin is code its provider hosts, not part of the
game's package; here a plugin is one this adapter provides (`src/plugins/`). A plugin the game does not declare, or that
no provider here implements, is "not defined", as the platform says of one the game may not use. A host that installs
its own `requirePlugin` before the adapter keeps it.

| Plugin | Provides |
|---|---|
| `UnityPlugin` | The start-up of a Tuanjie (Unity) mini-game export, whose `game.js` hands it the data package, the WebAssembly and the engine's start (`src/plugins/unity.js`). |

`UnityPlugin` is written from what the export, its framework and its SDK ask of it: the manager game.js makes
(`new UnityManager(config)`, `onLaunchProgress`, `onModulePrepared`, `startGame`, and what the framework and the SDK call
on it); the wasm from the `wasmcode` subpackage through `WXWebAssembly`; the data package (`TuanjieWebData1.0` /
`UnityWebData1.0`) from the `data-package` subpackage or the build's CDN, written into the engine's file system; the
engine's persistent `/idbfs` (PlayerPrefs, saves) kept in the game's user data instead of IndexedDB; `UnityLoader.SystemInfo`
and `GameGlobal.Module`. What the platform's own plugin adds for its product -- a launch cover, a download cache, launch
reports -- is not here: the launch events still fire, and reports go nowhere. The migo-conformance suite builds a
Tuanjie level through the editor's mini-game export and runs it on migo with this adapter
(`games/tuanjie`, `game-tuanjie-cube-drop-minigame`).

## Layout

```
src/
  index.js          entry -- builds and publishes globalThis.wx, WXWebAssembly and requirePlugin
  require-plugin.js  requirePlugin and the registry of the plugins provided here
  plugins/unity.js   UnityPlugin, the start-up of a Tuanjie (Unity) mini-game export
scripts/
  build-bundle.mjs   esbuild → dist/migo-wx-adapter.bundle.js (IIFE; for prelude injection)
tests/
  adapter.test.mjs   ESM behavior against a fake migo runtime
  plugins.test.mjs   requirePlugin and UnityPlugin against fakes of the file system, the
                     platform's subpackages and WXWebAssembly, and an export's framework
  bundle.test.mjs    IIFE bundle smoke-tested in a vm.Context, including the
                     idempotency guard and the "migo not booted" failure mode
```

## Running tests

```sh
node tests/adapter.test.mjs
node tests/plugins.test.mjs
node tests/bundle.test.mjs
# or
npm test                 # runs all three
npm run build && npm test  # rebuild bundle then test
```

## License

MIT
