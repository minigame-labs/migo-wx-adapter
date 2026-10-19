# migo-wx-adapter

[English](README.md) | [中文](README.zh-CN.md)

Publishes `globalThis.wx`, aliased to the [migo](https://github.com/minigame-labs/migo) mini-game runtime's own `migo.*` capabilities. Lets mini-game content written against the `wx` global -- unmodified WeChat mini-game source, or content from a similarly-shaped mini-game platform -- run on migo unchanged.

The migo runtime installs only `migo` by default. `wx` is not built in, at any scale -- this adapter is how a game or host opts into it.

## When to use

- Your content is real, unmodified wx mini-game source (`wx.createCanvas()`, `wx.getSystemInfoSync()`, `wx.onTouchStart()`, ...).
- You're porting a WeChat mini-game and want to verify it runs before touching its source.

If your content calls `migo.*` directly, you don't need this adapter.

## What this is NOT

A reimplementation of wx. For every capability migo also implements, `wx.foo` and `migo.foo` are **the same function reference** -- this adapter is a naming/shaping layer over migo's own capabilities, not a new implementation of them. If migo doesn't implement a given wx API, `wx.thatApi` is `undefined` here exactly as it is on `migo` directly; no adapter can manufacture a capability the runtime doesn't have.

Concretely, that makes this adapter genuinely small: the whole thing is copying migo's own property descriptors onto a new object, minus a short, explicit exclusion list (see below). There's no protocol translation, no polyfilling, no behavioral shimming -- that's the difference between this and the [BOM/DOM adapter (migo-web-adapter)](https://github.com/minigame-labs/migo-web-adapter), which does real work because browsers and wx mini-games don't share a capability model. wx mini-games and migo do.

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
`.wasm.br` is refused: the runtime has no brotli decoder, so ship the `.wasm` uncompressed.

## Layout

```
src/
  index.js          entry -- builds and publishes globalThis.wx
scripts/
  build-bundle.mjs   esbuild → dist/migo-wx-adapter.bundle.js (IIFE; for prelude injection)
tests/
  adapter.test.mjs   ESM behavior against a fake migo runtime
  bundle.test.mjs    IIFE bundle smoke-tested in a vm.Context, including the
                     idempotency guard and the "migo not booted" failure mode
```

## Running tests

```sh
node tests/adapter.test.mjs
node tests/bundle.test.mjs
# or
npm test                 # runs both
npm run build && npm test  # rebuild bundle then test
```

## License

MIT
