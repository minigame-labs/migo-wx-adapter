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

// Idempotency on re-entry is exercised in bundle.test.mjs, which runs the
// raw script twice via vm.runInContext -- ESM import caching makes a second
// `import()` of this same module a no-op regardless, so it isn't a
// meaningful test of the guard at this level.

console.log("ADAPTER TEST PASSED");
