// Behavioral test of the wx-adapter against a faked migo runtime.
// Run with `node tests/adapter.test.mjs` from this dir or via npm test.

import assert from "node:assert/strict";

// ---- Fake migo runtime, installed on globalThis BEFORE importing the
//      adapter. The adapter reads `globalThis.migo` at module-eval time.
const fakeMigo = {
  createCanvas: () => ({ width: 0, height: 0 }),
  getSystemInfoSync: () => ({ platform: "android" }),
  onTouchStart: (cb) => cb,
  clearStorage: () => {},
  // migo's brand-free name for an API wx names after itself.
  updateHostApp: () => {},
  // Gamepads are a wx API (device/gamepad) -- they reach wx like any other.
  getGamepads: () => [],
  onGamepadConnected: () => {},
  offGamepadConnected: () => {},
  onGamepadDisconnected: () => {},
  offGamepadDisconnected: () => {},
  // The package's files, as the engine's file system reads them: a module exporting add(a, b).
  getFileSystemManager: () => ({
    readFile({ filePath, success, fail }) {
      reads.push(filePath);
      const data = PACKAGE[filePath];
      queueMicrotask(() => (data ? success({ data }) : fail({ errMsg: `readFile:fail no such file or directory ${filePath}` })));
    },
  }),
};
const reads = [];
const PACKAGE = {
  "wasm/add.wasm": new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
    0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
    0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
  ]).buffer,
};
Object.defineProperty(globalThis, "migo", {
  value: fakeMigo, writable: true, configurable: true, enumerable: true,
});

const { default: wx } = await import("../src/index.js");

// 1. Shared capabilities are the SAME function reference as migo's --
//    aliasing/copying, not reimplementation.
assert.equal(wx.createCanvas, fakeMigo.createCanvas, "wx.createCanvas === migo.createCanvas (same reference)");
assert.equal(wx.getSystemInfoSync, fakeMigo.getSystemInfoSync);
assert.equal(wx.clearStorage, fakeMigo.clearStorage);

// 2. Every migo name reaches wx -- nothing on migo is kept off wx. Gamepads
//    included: they are wx's own device API, not a browser-only extra.
for (const key of Object.getOwnPropertyNames(fakeMigo)) {
  if (key === "updateHostApp") continue;
  assert.equal(wx[key], fakeMigo[key], `wx.${key} === migo.${key}`);
}

// 3. An API wx names after the platform reaches wx under that name, and only
//    under it.
assert.equal(wx.updateWeChatApp, fakeMigo.updateHostApp, "wx.updateWeChatApp === migo.updateHostApp");
assert.equal(typeof wx.updateHostApp, "undefined", "migo's own name is not a wx name");

// 4. globalThis.wx is the published object.
assert.equal(globalThis.wx, wx, "globalThis.wx is set");
assert.equal(globalThis.__migoWxAdapterInjected, true);

// 5. WXWebAssembly: instantiate takes a path in the package and reads it through the engine's
//    file system; everything else is WebAssembly's own.
const WXW = globalThis.WXWebAssembly;
assert.equal(typeof WXW, "object", "WXWebAssembly is published");
for (const name of ["Memory", "Table", "Global", "Module", "Instance", "CompileError", "LinkError", "RuntimeError"]) {
  assert.equal(WXW[name], WebAssembly[name], `WXWebAssembly.${name} is WebAssembly.${name}`);
}
for (const name of ["compile", "compileStreaming", "instantiateStreaming", "validate"]) {
  assert.equal(WXW[name], undefined, `WXWebAssembly.${name} is not offered: it takes bytes, and the platform's takes a path`);
}
const { instance, module } = await WXW.instantiate("wasm/add.wasm", {});
assert.equal(instance.exports.add(2, 3), 5, "the module read from the package runs");
assert.ok(module instanceof WebAssembly.Module);
assert.deepEqual(reads, ["wasm/add.wasm"], "read once, by its package path");

const refused = async (source, pattern, what) => {
  let result;
  try {
    result = WXW.instantiate(source, {});
  } catch (e) {
    assert.fail(`${what}: instantiate threw instead of rejecting: ${e}`);
  }
  await assert.rejects(result, pattern, what);
};
// Held to the message: bytes reaching the path handling also fail with a TypeError, later and
// for no reason a game could act on.
const wantsPath = { name: "TypeError", message: /takes the path of a \.wasm file in the game's package/ };
await refused(PACKAGE["wasm/add.wasm"], wantsPath, "bytes are refused, as the platform refuses them");
await refused("", wantsPath, "an empty path is refused");
await refused("wasm/missing.wasm", /wasm\/missing\.wasm: readFile:fail no such file/, "a missing file names itself");
reads.length = 0;
await refused("wasm/add.wasm.br", /brotli/, "a brotli file is refused as what it is");
assert.deepEqual(reads, [], "and is not read first");

// Idempotency on re-entry is exercised in bundle.test.mjs, which runs the
// raw script twice via vm.runInContext -- ESM import caching makes a second
// `import()` of this same module a no-op regardless, so it isn't a
// meaningful test of the guard at this level.

console.log("ADAPTER TEST PASSED");
