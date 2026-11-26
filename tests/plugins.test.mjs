// requirePlugin and the UnityPlugin provider, against fakes of what they reach: the engine's file system (for game.json,
// the package and the game's user data), the platform's subpackage loading and WXWebAssembly, and -- for UnityPlugin --
// an engine factory that behaves as the Emscripten framework a Tuanjie export carries does where the plugin meets it
// (its run dependencies, its file system calls, instantiateWasm, preRun).
// Run with `node tests/plugins.test.mjs` from this dir or via npm test.

import assert from "node:assert/strict";
import { installRequirePlugin, registerPluginProvider } from "../src/require-plugin.js";
import { createUnityPlugin, parseDataPackage, persistentFileSystem } from "../src/plugins/unity.js";

const encoder = new TextEncoder();
const bytes = (...values) => new Uint8Array(values);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---- An in-memory file system with the platform's FileSystemManager calls the plugin makes.
function fakeFileSystem(files = {}) {
  const store = new Map(Object.entries(files));
  const dirs = new Set();
  const parent = (path) => path.slice(0, path.lastIndexOf("/"));
  const addDirs = (path) => { for (let p = path; p && !dirs.has(p); p = parent(p)) dirs.add(p); };
  for (const path of store.keys()) addDirs(parent(path));
  const missing = (call, path) => Object.assign(new Error(`${call}:fail no such file or directory ${path}`), { errMsg: `${call}:fail no such file or directory ${path}` });
  const asBuffer = (data) => (typeof data === "string" ? encoder.encode(data).buffer : data);
  const fs = {
    store, dirs, made: [],
    accessSync(path) { if (!store.has(path) && !dirs.has(path)) throw missing("accessSync", path); },
    statSync(path) {
      if (!store.has(path) && !dirs.has(path)) throw missing("statSync", path);
      return { isDirectory: () => dirs.has(path), isFile: () => store.has(path) };
    },
    mkdirSync(path, recursive) { if (!recursive && !dirs.has(parent(path))) throw missing("mkdirSync", path); addDirs(path); fs.made.push(path); },
    readdirSync(dir) {
      if (!dirs.has(dir)) throw missing("readdirSync", dir);
      const names = new Set();
      for (const p of [...store.keys(), ...dirs]) if (parent(p) === dir) names.add(p.slice(dir.length + 1));
      return [...names];
    },
    readFileSync(path, encoding) {
      if (!store.has(path)) throw missing("readFileSync", path);
      const data = store.get(path);
      if (encoding === "utf8") return typeof data === "string" ? data : new TextDecoder().decode(data);
      return asBuffer(data).slice(0);
    },
    writeFileSync(path, data) {
      if (!dirs.has(parent(path))) throw missing("writeFileSync", path);
      store.set(path, asBuffer(data).slice(0));
    },
    unlinkSync(path) { if (!store.delete(path)) throw missing("unlinkSync", path); },
    rmdirSync(path) { dirs.delete(path); },
    readFile({ filePath, success, fail }) {
      queueMicrotask(() => (store.has(filePath) ? success({ data: asBuffer(store.get(filePath)).slice(0) }) : fail(missing("readFile", filePath))));
    },
    readCompressedFile({ filePath, fail }) { queueMicrotask(() => fail(missing("readCompressedFile", filePath))); },
    unlink({ filePath, complete }) { store.delete(filePath); queueMicrotask(() => complete && complete()); },
  };
  return fs;
}

// ---- A data package: the magic, the header's end, then each file's offset, size, path length and path, then the files.
function dataPackage(entries, magic = "TuanjieWebData1.0\0") {
  const paths = entries.map(([path]) => encoder.encode(path));
  let headerEnd = magic.length + 4;
  for (const p of paths) headerEnd += 12 + p.length;
  const total = headerEnd + entries.reduce((n, [, data]) => n + data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  for (let i = 0; i < magic.length; i++) out[i] = magic.charCodeAt(i);
  view.setUint32(magic.length, headerEnd, true);
  let p = magic.length + 4, offset = headerEnd;
  entries.forEach(([, data], i) => {
    view.setUint32(p, offset, true); view.setUint32(p + 4, data.length, true); view.setUint32(p + 8, paths[i].length, true);
    out.set(paths[i], p + 12);
    p += 12 + paths[i].length;
    out.set(data, offset);
    offset += data.length;
  });
  return out.buffer;
}

// =====================================================================================================================
// requirePlugin
{
  const made = [];
  registerPluginProvider("TestPlugin", (options, declared) => { made.push([options, declared]); return { default: "the plugin's exports" }; });
  const declaration = { version: "1.0.0", provider: "wx0123" };
  const gameJson = JSON.stringify({ plugins: { TestPlugin: declaration, Unprovided: { version: "2" } } });
  const migo = { getFileSystemManager: () => fakeFileSystem({ "game.json": gameJson }) };
  const global = {};
  installRequirePlugin(global, migo);
  assert.equal(typeof global.requirePlugin, "function", "requirePlugin is published");
  assert.equal(Object.keys(global).includes("requirePlugin"), false, "and is not enumerable, as the platform's globals are not");

  const options = { customEnv: { tag: 1 } };
  const exports = global.requirePlugin("TestPlugin", options);
  assert.equal(exports.default, "the plugin's exports", "a declared, provided plugin's exports");
  assert.deepEqual(made, [[options, declaration]], "made with the options and the game's declaration of it");
  assert.equal(global.requirePlugin("TestPlugin"), exports, "made once, and shared by every requirePlugin of it");
  assert.equal(made.length, 1);

  assert.throws(() => global.requirePlugin("Unprovided"), /plugin "Unprovided" is not defined: this platform provides no plugin of that name/,
    "a declared plugin no provider here implements is not defined");
  registerPluginProvider("Undeclared", () => ({}));
  assert.throws(() => global.requirePlugin("Undeclared"), /plugin "Undeclared" is not defined: game.json declares no plugin of that name/,
    "a provided plugin the game does not declare is not defined");

  // game.json unreadable (a game run without one): every provided plugin may be required.
  const bare = {};
  installRequirePlugin(bare, { getFileSystemManager: () => fakeFileSystem({}) });
  assert.deepEqual(bare.requirePlugin("Undeclared"), {}, "without a game.json, a provided plugin is required by its name");
  assert.throws(() => bare.requirePlugin("Nothing"), /is not defined: this platform provides no plugin/);

  // A requirePlugin already there (the host's own) is left alone.
  const hosted = { requirePlugin: () => "the host's" };
  installRequirePlugin(hosted, migo);
  assert.equal(hosted.requirePlugin(), "the host's", "a host's own requirePlugin is kept");
}

// =====================================================================================================================
// parseDataPackage
{
  // "Data/资源.bin" is a three-byte UTF-8 path, "\u{1F3B2}.txt" a four-byte one.
  const pkg = dataPackage([
    ["data.unity3d", bytes(1, 2, 3)],
    ["Data/资源.bin", bytes(4)],
    ["\u{1F3B2}.txt", bytes()],
  ]);
  const files = parseDataPackage(pkg);
  assert.deepEqual(files.map(([path]) => path), ["data.unity3d", "Data/资源.bin", "\u{1F3B2}.txt"], "the paths, decoded as UTF-8, in order");
  assert.deepEqual([...files[0][1]], [1, 2, 3], "each file's bytes");
  assert.deepEqual([...files[1][1]], [4]);
  assert.equal(files[2][1].length, 0, "an empty file is a file");
  assert.equal(parseDataPackage(dataPackage([["a", bytes(9)]], "UnityWebData1.0\0"))[0][0], "a", "Unity's own magic is a data package too");
  assert.throws(() => parseDataPackage(encoder.encode("not a package at all").buffer), /does not start with a data package's magic/);
  const truncated = pkg.slice(0, pkg.byteLength - 3);
  assert.throws(() => parseDataPackage(truncated), /runs past its end/, "a file that runs past the package's end is refused");
}

// =====================================================================================================================
// persistentFileSystem: /idbfs mirrored to the game's user data
{
  // The engine's file system, as far as syncfs reaches it.
  const memory = new Map(); // path -> Uint8Array, or null for a directory
  const FS = {
    filesystems: { MEMFS: { mount: "MEMFS.mount", node_ops: "MEMFS.node_ops" } },
    mkdir(path) { if (memory.has(path)) throw new Error("EEXIST"); memory.set(path, null); },
    writeFile(path, data) { memory.set(path, new Uint8Array(data)); },
    readFile(path) { return memory.get(path); },
    unlink(path) { memory.delete(path); },
    readdir(dir) { return [".", "..", ...[...memory.keys()].filter((p) => p.slice(0, p.lastIndexOf("/")) === dir).map((p) => p.slice(dir.length + 1))]; },
    stat(path) { return { mode: memory.get(path) === null ? 0o40000 : 0o100000 }; },
    isDir(mode) { return (mode & 0o170000) === 0o40000; },
  };
  memory.set("/idbfs", null);
  const root = "usr/__UNITY_IDBFS";
  const fs = fakeFileSystem({ [`${root}/top.txt`]: encoder.encode("top").buffer, [`${root}/prefs/player.dat`]: bytes(7, 8).buffer });
  const idbfs = persistentFileSystem(FS, fs, root);
  assert.equal(idbfs.mount, "MEMFS.mount", "the engine's MEMFS, kept in memory");
  assert.equal(idbfs.node_ops, "MEMFS.node_ops");
  assert.equal(FS.filesystems.MEMFS.syncfs, undefined, "MEMFS itself is not changed");
  const mount = { mountpoint: "/idbfs" };
  const sync = (toMemory) => new Promise((resolve, reject) => idbfs.syncfs(mount, toMemory, (error) => (error ? reject(error) : resolve())));

  await sync(true);
  assert.deepEqual([...memory.get("/idbfs/prefs/player.dat")], [7, 8], "populated from the user data, directories and all");
  assert.equal(new TextDecoder().decode(memory.get("/idbfs/top.txt")), "top");

  memory.delete("/idbfs/top.txt");
  memory.set("/idbfs/prefs/player.dat", bytes(9));
  memory.set("/idbfs/saves", null);
  memory.set("/idbfs/saves/slot1", bytes(1, 1));
  await sync(false);
  assert.deepEqual([...new Uint8Array(fs.store.get(`${root}/prefs/player.dat`))], [9], "a changed file is written back");
  assert.deepEqual([...new Uint8Array(fs.store.get(`${root}/saves/slot1`))], [1, 1], "a new file, in a new directory");
  assert.equal(fs.store.has(`${root}/top.txt`), false, "what the engine no longer has is removed");
  memory.delete("/idbfs/saves/slot1");
  memory.delete("/idbfs/saves");
  await sync(false);
  assert.equal(fs.dirs.has(`${root}/saves`), false, "a directory too");

  // The first flush of a game that has never saved makes the directory.
  const fresh = fakeFileSystem({});
  fresh.dirs.add("usr");
  const freshFs = persistentFileSystem(FS, fresh, "usr/__UNITY_IDBFS");
  await new Promise((resolve) => freshFs.syncfs(mount, true, resolve));
  await new Promise((resolve) => freshFs.syncfs(mount, false, resolve));
  assert.ok(fresh.store.has("usr/__UNITY_IDBFS/prefs/player.dat"), "flushed into a directory it made");

  // A failure is the callback's, not a throw through the engine.
  const broken = persistentFileSystem(FS, { ...fs, readdirSync() { throw new Error("disk gone"); }, statSync: () => ({ isDirectory: () => true }) }, root);
  const error = await new Promise((resolve) => broken.syncfs(mount, true, resolve));
  assert.match(String(error), /disk gone/, "an error reaches syncfs's callback");
  assert.throws(() => persistentFileSystem({ filesystems: {} }, fs, root), /no MEMFS/);
}

// =====================================================================================================================
// UnityPlugin's manager: the start-up, against a fake of the export's framework
{
  const CONFIG = { DATA_FILE_MD5: "d00d", CODE_FILE_MD5: "c0de", GAME_NAME: "webgl", DATA_CDN: "", loadDataPackageFromSubpackage: true, compressDataPackage: false };
  const dataPath = "data-package/d00d.webgl.data.unityweb.bin.txt";
  const codePath = "wasmcode/c0de.webgl.wasm.code.unityweb.wasm.br";

  function setUp({ withFactory = true } = {}) {
    const fs = fakeFileSystem({ [dataPath]: dataPackage([["data.unity3d", bytes(1, 2)], ["Il2CppData/Metadata/global-metadata.dat", bytes(3)]]) });
    fs.dirs.add("wxfile://usr");
    const subpackages = [];
    const shown = [];
    const wx = {
      env: { USER_DATA_PATH: "wxfile://usr" },
      getFileSystemManager: () => fs,
      loadSubpackage({ name, success }) { subpackages.push(name); setTimeout(success, 0); },
      getSystemInfoSync: () => ({ platform: "android", screenWidth: 360, screenHeight: 640, system: "Android 12", language: "zh_CN" }),
      onShow: (cb) => shown.push(["show", cb]),
      onHide: (cb) => shown.push(["hide", cb]),
    };
    const instantiated = [];
    globalThis.WXWebAssembly = { instantiate: (path, imports) => { instantiated.push([path, imports]); return Promise.resolve({ instance: "instance", module: "module" }); } };
    globalThis.GameGlobal = {};
    delete globalThis.UnityLoader;
    const seen = { managerAtStart: undefined, calls: 0, created: [], received: null, ran: false };
    const ns = {};
    if (withFactory) {
      // The framework, where the plugin meets it: run dependencies on the wasm and on the data, the data written in
      // preRun once both are let go of, and a promise of the module that settles when it has run.
      ns.UnityModule = (Module) => {
        seen.calls++;
        seen.managerAtStart = globalThis.GameGlobal.manager;
        seen.loopRunnerAtStart = ns.isLoopRunnerEnable;
        seen.systemInfoAtStart = globalThis.UnityLoader && globalThis.UnityLoader.SystemInfo;
        const deps = new Set(["wasm-instantiate", "wasm-preloadAssets"]);
        return new Promise((resolve) => {
          Module.addRunDependency = (d) => deps.add(d);
          Module.removeRunDependency = (d) => {
            deps.delete(d);
            if (deps.size === 0 && !seen.ran) { seen.ran = true; for (const f of Module.preRun) f(); resolve(Module); }
          };
          Module.FS_createPath = (parent, path) => seen.created.push(["dir", parent, path]);
          Module.FS_createDataFile = (parent, name, data) => seen.created.push(["file", parent, name, [...data]]);
          Module.instantiateWasm({ env: "imports" }, (instance, module) => {
            seen.received = [instance, module];
            Module.wasmInstantiated();
            Module.removeRunDependency("wasm-instantiate");
          });
        });
      };
    }
    const canvas = {};
    const { default: UnityManager } = createUnityPlugin({ customEnv: { wx, unityNamespace: ns, canvas } });
    return { wx, fs, ns, canvas, seen, subpackages, instantiated, shown, UnityManager };
  }

  const t = setUp();
  const manager = new t.UnityManager({ ...CONFIG });
  assert.ok(t.fs.dirs.has("wxfile://usr/__GAME_FILE_CACHE"), "PLUGIN_CACHE_PATH is made with the manager, where the SDK makes its own directories");
  assert.equal(manager.PLUGIN_CACHE_PATH, "wxfile://usr/__GAME_FILE_CACHE");
  for (const name of ["pluginLog", "eventLog", "pluginError", "timeStart", "timeEnd"]) assert.equal(typeof manager.Logger[name], "function", `Logger.${name}`);
  assert.equal(manager.getCachePath("anything"), "", "nothing has a cached copy");
  assert.equal(manager.isVisible, true);
  t.shown.find(([what]) => what === "hide")[1]();
  assert.equal(manager.isVisible, false, "isVisible follows onHide");
  t.shown.find(([what]) => what === "show")[1]();
  assert.equal(manager.isVisible, true, "and onShow");

  const events = [];
  manager.onLaunchProgress((event) => events.push(event.type));
  const prepared = [];
  manager.onModulePrepared((Module) => prepared.push(Module));
  const errors = [];
  manager.onLogError = (error) => errors.push(error);

  // As game.js has it: startGame, then the manager published as GameGlobal.manager.
  manager.startGame();
  assert.equal(t.seen.calls, 0, "the engine does not start inside startGame");
  globalThis.GameGlobal.manager = manager;
  manager.startGame();
  for (let i = 0; i < 20 && !prepared.length; i++) await tick();
  await tick();

  assert.deepEqual(errors, [], "no error on the way");
  assert.equal(t.seen.calls, 1, "the engine started once, however often startGame is called");
  assert.equal(t.seen.managerAtStart, manager, "and only once GameGlobal.manager was there for it to call");
  assert.equal(t.seen.loopRunnerAtStart, true, "with the framework's loop runner on");
  assert.deepEqual(t.subpackages.sort(), ["data-package", "wasmcode"], "both subpackages loaded");
  assert.deepEqual(t.instantiated, [[codePath, { env: "imports" }]], "the wasm instantiated from its subpackage, brotli-compressed, through WXWebAssembly");
  assert.deepEqual(t.seen.received, ["instance", "module"], "and handed to the framework");
  assert.deepEqual(t.seen.created, [
    ["file", "/", "data.unity3d", [1, 2]],
    ["dir", "/", "Il2CppData/Metadata"],
    ["file", "/Il2CppData/Metadata", "global-metadata.dat", [3]],
  ], "the data package's files written where the engine reads them");
  assert.equal(prepared.length, 1, "onModulePrepared called with the module");
  const Module = prepared[0];
  assert.equal(manager.gameInstance, Module);
  assert.equal(globalThis.GameGlobal.Module, Module, "GameGlobal.Module, which the SDK calls SendMessage on");
  assert.equal(Module.canvas, t.canvas);
  assert.equal(t.canvas.id, "canvas", "the canvas has an id for the engine's selector");
  assert.equal(Module.IsWxGame, true);
  assert.equal(t.seen.systemInfoAtStart.os, "Android", "UnityLoader.SystemInfo, a global the framework reads bare");
  assert.equal(t.seen.systemInfoAtStart.width, 360);
  assert.equal(t.seen.systemInfoAtStart.mobile, true);
  assert.equal(globalThis.UnityLoader.UnityCache.XMLHttpRequest, globalThis.XMLHttpRequest);
  assert.deepEqual([...new Set(events)].sort((a, b) => a - b), [0, 1, 2, 3, 5, 6], "every launch stage reported");
  assert.equal(events[0], 0, "the plugin's launch first");
  assert.equal(events[events.length - 1], 6, "the game prepared last");

  // A canvas that has an id keeps it.
  const named = setUp();
  named.canvas.id = "game";
  globalThis.GameGlobal.manager = new named.UnityManager({ ...CONFIG });
  globalThis.GameGlobal.manager.startGame();
  for (let i = 0; i < 20 && !named.seen.ran; i++) await tick();
  assert.equal(named.canvas.id, "game", "a canvas's own id is kept");

  // An export without its framework: the game's error handler hears of it.
  const bare = setUp({ withFactory: false });
  const lost = new bare.UnityManager({ ...CONFIG });
  const heard = [];
  lost.onLogError = (error) => heard.push(String(error));
  const quiet = console.error;
  console.error = () => {};
  try { lost.startGame(); } finally { console.error = quiet; }
  assert.equal(heard.length, 1);
  assert.match(heard[0], /unityNamespace\.UnityModule, the engine's factory, is not there/);

  // A data package that is not there: the error reaches the game, and the engine is never prepared.
  const missing = setUp();
  missing.fs.store.delete(dataPath);
  const stuck = new missing.UnityManager({ ...CONFIG });
  globalThis.GameGlobal.manager = stuck;
  const failures = [];
  stuck.onLogError = (error) => failures.push(String(error));
  const stuckPrepared = [];
  stuck.onModulePrepared(() => stuckPrepared.push(1));
  console.error = () => {};
  try {
    stuck.startGame();
    for (let i = 0; i < 20 && !failures.length; i++) await tick();
  } finally { console.error = quiet; }
  assert.match(failures.join(), /data-package\/d00d\.webgl\.data\.unityweb\.bin\.txt: readFile:fail no such file/, "the missing data package names itself");
  assert.equal(stuckPrepared.length, 0);
}

delete globalThis.WXWebAssembly;
delete globalThis.GameGlobal;
delete globalThis.UnityLoader;
console.log("PLUGINS TEST PASSED");
