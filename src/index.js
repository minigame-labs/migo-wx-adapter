// migo-wx-adapter entry point. Publishes `globalThis.wx`, aliased to the
// migo runtime's own `migo.*` capabilities, so mini-game content written
// against the `wx` global (unmodified WeChat mini-game source, or content
// from a similarly-shaped mini-game platform) runs on migo unchanged.
//
// Usage (game side, before content that references `wx` runs):
//
//   import "@minigame-labs/migo-wx-adapter";       // ESM
//   // or, in CommonJS / require-style:
//   require("./wx-adapter/src/index.js");
//
// One-shot: idempotent on re-entry, and safe to load alongside
// @minigame-labs/migo-web-adapter (the BOM/DOM adapter) -- they touch disjoint
// globals (`wx` here, `window`/`document`/etc. there).
//
// What this is NOT: a reimplementation of wx. `migo`'s capabilities for
// every name wx also defines are the *same functions* wx would call --
// this adapter is a naming/shaping layer, not new behavior. If migo does
// not implement a given wx API, `wx.thatApi` is `undefined` here exactly
// as it is on `migo` directly; this adapter cannot manufacture capabilities
// the runtime doesn't have.

// Where wx's name for an API carries the platform's own brand, migo -- which
// carries no platform's brand -- names it for what it does; wx publishes it
// under wx's name instead.
const WX_NAMES = {
  updateHostApp: "updateWeChatApp",
};

if (!globalThis.__migoWxAdapterInjected) {
  globalThis.__migoWxAdapterInjected = true;

  if (typeof globalThis.migo !== "object" || globalThis.migo === null) {
    throw new Error(
      "@minigame-labs/migo-wx-adapter: globalThis.migo is not present. " +
      "This adapter must load after the migo runtime has booted (migo " +
      "installs its namespace during bootstrap, before any content runs)."
    );
  }

  const wx = {};
  const keys = Object.getOwnPropertyNames(globalThis.migo);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    // Mirror the descriptor as-is, the same way the engine's own namespace
    // projection does: preserves getters/setters and writability rather
    // than flattening everything to a plain value copy.
    const desc = Object.getOwnPropertyDescriptor(globalThis.migo, key);
    if (desc) Object.defineProperty(wx, WX_NAMES[key] || key, desc);
  }

  Object.defineProperty(globalThis, "wx", {
    value: wx, writable: true, enumerable: true, configurable: true,
  });

  publishWXWebAssembly(globalThis.migo);
}

// The platform's wasm global. Its `instantiate` takes the path of a .wasm file in the game's
// package -- not bytes, not a URL -- and its other members are WebAssembly's own. Without it a
// game built for the platform that loads wasm this way stops on a ReferenceError: a Cocos Creator
// 3.8 mini-game build stopped there, before its first scene.
//
// Published only where the engine has WebAssembly: a jitless engine has none, and content that
// looks for WXWebAssembly then sees what it sees on a platform without wasm.
function publishWXWebAssembly(migo) {
  const W = globalThis.WebAssembly;
  if (typeof W !== "object" || W === null || "WXWebAssembly" in globalThis) return;
  // The ones that take wasm bytes or a stream. The platform's object takes a path instead.
  const TAKE_BYTES = new Set(["compile", "compileStreaming", "instantiate", "instantiateStreaming", "validate"]);
  const wxwasm = {};
  for (const key of Object.getOwnPropertyNames(W)) {
    if (TAKE_BYTES.has(key)) continue;
    Object.defineProperty(wxwasm, key, Object.getOwnPropertyDescriptor(W, key));
  }
  Object.defineProperty(wxwasm, "instantiate", {
    value: function instantiate(path, imports) {
      // Never throws: every refusal is the promise's, as WebAssembly.instantiate's are.
      return new Promise((resolve, reject) => {
        if (typeof path !== "string" || path === "") {
          throw new TypeError("WXWebAssembly.instantiate takes the path of a .wasm file in the game's package");
        }
        if (path.endsWith(".br")) {
          // Handed to WebAssembly as they are, brotli bytes fail as a missing magic number,
          // which names the wrong problem.
          throw new TypeError("WXWebAssembly.instantiate: " + path + " is brotli-compressed, and this runtime " +
            "has no brotli decoder; ship the .wasm uncompressed");
        }
        migo.getFileSystemManager().readFile({
          filePath: path,
          success: (res) => resolve(res.data),
          fail: (err) => reject(new Error("WXWebAssembly.instantiate: " + path + ": " + (err && err.errMsg))),
        });
      }).then((bytes) => W.instantiate(bytes, imports));
    },
    writable: true, enumerable: false, configurable: true,
  });
  Object.defineProperty(globalThis, "WXWebAssembly", {
    value: wxwasm, writable: true, enumerable: false, configurable: true,
  });
}

export default globalThis.wx;
