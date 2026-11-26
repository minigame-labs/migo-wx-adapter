// UnityPlugin: the start-up a Tuanjie (Unity) mini-game export hands to a plugin the platform hosts. The export's game.js
// carries the engine (`webgl.wasm.framework.unityweb.js`, an Emscripten factory it publishes as
// `unityNamespace.UnityModule`), its SDK and its configuration, and asks `requirePlugin('UnityPlugin').default` for the
// manager that loads the rest: the WebAssembly in the `wasmcode` subpackage, the data package in `data-package` (or on
// the build's CDN), and the engine's start. The platform's plugin is its provider's own code; this is the same role,
// written from what the export, its framework and its SDK (MIT) ask of it:
//
//   - `new UnityManager(managerConfig)`, then `onLaunchProgress(cb)`, `onModulePrepared(cb)`, `onLogError` and
//     `startGame()`; game.js publishes it as `GameGlobal.manager`, where the framework and the SDK reach it.
//   - The framework's Module: `instantiateWasm` compiles the brotli-compressed module through WXWebAssembly;
//     `wasmInstantiated`, which the framework waits for before it lets go of its "wasm-instantiate" dependency; the data
//     package, which it waits for as "wasm-preloadAssets" and which is written into its file system in `preRun`; the
//     canvas, the context attributes, `IsWxGame`.
//   - `UnityLoader.SystemInfo` (a global the framework reads bare) and `UnityLoader.UnityCache.XMLHttpRequest`, the
//     request class its web requests are made with.
//   - `GameGlobal.Module`, the engine's module, which the SDK calls into (SendMessage).
//   - What the framework and the SDK call on the manager: `Logger`, `TimeLogger`, `reporter`, `fs`, `isVisible`,
//     `getCachePath`, `PLUGIN_CACHE_PATH` (made when the manager is), `hideLoadingPage`, `font`, and the rest below.
//
// What the platform's plugin adds for its own product -- a launch cover with a progress bar, a download cache, launch
// reports to its analytics -- is not here: the launch events still fire, nothing is cached that is not asked for, and
// reports go nowhere.

const LAUNCH = { launchPlugin: 0, loadWasm: 1, compileWasm: 2, loadAssets: 3, readAssets: 5, prepareGame: 6 };
const DATA_MAGICS = ["TuanjieWebData1.0\0", "UnityWebData1.0\0"];

// UTF-8 to a string, for a path in a data package: the platform's globals have no TextDecoder to count on.
function utf8(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let cp;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) { cp = ((b & 0x0f) << 12) | ((bytes[i] & 0x3f) << 6) | (bytes[i + 1] & 0x3f); i += 2; }
    else { cp = ((b & 0x07) << 18) | ((bytes[i] & 0x3f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); i += 3; }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/// The files of a data package: `[path, bytes]` in the order it lists them. Its header is a magic string, the header's
/// length (u32, little-endian) and, for each file, its offset, its size and its path's length (u32 each) and its path.
export function parseDataPackage(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = DATA_MAGICS.find((m) => m.length <= bytes.length && [...m].every((c, i) => bytes[i] === c.charCodeAt(0)));
  if (!magic) throw new Error("UnityPlugin: the data package does not start with a data package's magic");
  const headerSize = view.getUint32(magic.length, true);
  const files = [];
  for (let p = magic.length + 4; p < headerSize;) {
    const offset = view.getUint32(p, true), size = view.getUint32(p + 4, true), pathLength = view.getUint32(p + 8, true);
    p += 12;
    const path = utf8(bytes.subarray(p, p + pathLength));
    p += pathLength;
    if (offset + size > bytes.length) throw new Error(`UnityPlugin: the data package's ${path} runs past its end`);
    files.push([path, bytes.subarray(offset, offset + size)]);
  }
  return files;
}

function osName(platform) {
  return { android: "Android", ios: "iOS", ohos: "HarmonyOS", windows: "Windows", mac: "macOS", linux: "Linux" }[platform] || String(platform || "");
}

function systemInfo(wx, config) {
  const sys = typeof wx.getSystemInfoSync === "function" ? wx.getSystemInfoSync() : {};
  const win = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : sys;
  const webgl = config && config.contextConfig && config.contextConfig.contextType === 2 ? 2 : 1;
  return {
    width: win.screenWidth || sys.screenWidth || 0,
    height: win.screenHeight || sys.screenHeight || 0,
    os: osName(sys.platform),
    osVersion: String(sys.system || ""),
    browser: "",
    browserVersion: "",
    gpu: "",
    language: String(sys.language || ""),
    hasWebGL: webgl,
    hasFullscreen: false,
    hasCursorLock: false,
    hasThreads: false,
    hasWasm: true,
    hasWasmThreads: false,
    mobile: !["windows", "mac", "linux"].includes(sys.platform),
  };
}

function readPackageFile(fs, path) {
  return new Promise((resolve, reject) => {
    const fail = (err) => reject(new Error(`UnityPlugin: ${path}: ${err && err.errMsg}`));
    if (path.endsWith(".br")) {
      fs.readCompressedFile({ filePath: path, compressionAlgorithm: "br", success: (res) => resolve(res.data), fail });
    } else {
      fs.readFile({ filePath: path, success: (res) => resolve(res.data), fail });
    }
  });
}

function loadSubpackage(wx, name) {
  return new Promise((resolve, reject) => {
    if (typeof wx.loadSubpackage !== "function") { resolve(); return; }
    wx.loadSubpackage({ name, success: () => resolve(), fail: (err) => reject(new Error(`UnityPlugin: the subpackage ${name}: ${err && err.errMsg}`)) });
  });
}

function download(wx, url) {
  return new Promise((resolve, reject) => {
    wx.request({
      url, responseType: "arraybuffer",
      success: (res) => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(res.data) : reject(new Error(`UnityPlugin: ${url}: HTTP ${res.statusCode}`))),
      fail: (err) => reject(new Error(`UnityPlugin: ${url}: ${err && err.errMsg}`)),
    });
  });
}

function ensureDirectory(fs, path) {
  try {
    fs.accessSync(path);
  } catch {
    try { fs.mkdirSync(path, true); } catch (error) { console.warn("[UnityPlugin] could not make " + path + ": " + (error && (error.errMsg || error.message))); }
  }
}

// The engine's persistent directory, /idbfs, where it keeps PlayerPrefs and what a game saves: in a browser IndexedDB
// holds it (IDBFS), which the platform does not have. Here it is the engine's in-memory file system with a `syncfs`
// that mirrors it to a directory of the game's user data: read in when the engine populates it, written back -- and
// what it no longer has removed -- when the engine flushes it. The framework mounts it through the
// `tuanjieFileSystemInit` hook it calls in place of IDBFS's.
export function persistentFileSystem(FS, fs, root) {
  const MEMFS = FS.filesystems && FS.filesystems.MEMFS;
  if (!MEMFS) throw new Error("UnityPlugin: the engine's file system has no MEMFS to keep /idbfs in");
  const exists = (path) => { try { fs.accessSync(path); return true; } catch { return false; } };
  const isDir = (path) => { try { return fs.statSync(path).isDirectory(); } catch { return false; } };
  const mkdirs = (path) => { if (!exists(path)) fs.mkdirSync(path, true); };
  function populate(mountpoint, from) {
    if (!isDir(from)) return;
    for (const name of fs.readdirSync(from)) {
      const source = `${from}/${name}`, target = `${mountpoint}/${name}`;
      if (isDir(source)) {
        try { FS.mkdir(target); } catch { /* already there */ }
        populate(target, source);
      } else {
        FS.writeFile(target, new Uint8Array(fs.readFileSync(source)));
      }
    }
  }
  function entries(dir, out) {
    for (const name of FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const path = `${dir}/${name}`;
      const stat = FS.stat(path);
      if (FS.isDir(stat.mode)) { out.push([path, null]); entries(path, out); } else out.push([path, FS.readFile(path)]);
    }
    return out;
  }
  function flush(mountpoint, to) {
    mkdirs(to);
    const kept = new Set();
    for (const [path, bytes] of entries(mountpoint, [])) {
      const target = to + path.slice(mountpoint.length);
      kept.add(target);
      if (bytes === null) mkdirs(target);
      else fs.writeFileSync(target, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    const prune = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (isDir(path)) { prune(path); if (!kept.has(path)) fs.rmdirSync(path, true); } else if (!kept.has(path)) fs.unlinkSync(path);
      }
    };
    prune(to);
  }
  return Object.assign({}, MEMFS, {
    syncfs(mount, toMemory, callback) {
      try {
        if (toMemory) populate(mount.mountpoint, root);
        else flush(mount.mountpoint, root);
        callback(null);
      } catch (error) {
        callback(error);
      }
    },
  });
}

export function createUnityPlugin(options) {
  const env = (options && options.customEnv) || {};
  const wx = env.wx || globalThis.wx;
  const debug = (...args) => { if (typeof console.debug === "function") console.debug("[UnityPlugin]", ...args); };

  class UnityManager {
    constructor(config) {
      this.config = config;
      this.gameInstance = null;
      this.Module = null;
      this.onLogError = null;
      this.assetPath = `${String(config.DATA_CDN || "").replace(/\/$/, "")}/Assets`;
      this.isVisible = true;
      if (typeof wx.onShow === "function") wx.onShow(() => { this.isVisible = true; });
      if (typeof wx.onHide === "function") wx.onHide(() => { this.isVisible = false; });
      this.fs = wx.getFileSystemManager();
      this.PLUGIN_CACHE_PATH = `${wx.env.USER_DATA_PATH}/__GAME_FILE_CACHE`;
      ensureDirectory(this.fs, this.PLUGIN_CACHE_PATH);
      const timers = new Map();
      const timeStart = (label) => { timers.set(label, Date.now()); };
      const timeEnd = (label) => {
        const start = timers.get(label);
        timers.delete(label);
        const elapsed = start === undefined ? 0 : Date.now() - start;
        debug(`${label}: ${elapsed} ms`);
        return elapsed;
      };
      this.Logger = {
        pluginLog: debug,
        eventLog: debug,
        pluginError: (...args) => console.error("[UnityPlugin]", ...args),
        timeStart,
        timeEnd,
      };
      this.TimeLogger = { timeStart, timeEnd };
      // Reports to the platform's analytics: none here.
      this.reporter = { wxAssetBundle: { reportEmptyContent() {} }, alarm: { malloc() {} } };
      // The platform's common font (a system font the SDK can subset): none is offered here.
      this.font = {
        getCommonFont({ fail, complete } = {}) {
          if (typeof fail === "function") fail({ errMsg: "getCommonFont:fail no common font is offered" });
          if (typeof complete === "function") complete();
        },
      };
      this._progress = [];
      this._prepared = [];
      this._launchedAt = Date.now();
      this._stageAt = this._launchedAt;
      this._preloadList = [];
      this._concurrent = 0;
      this._started = false;
    }

    onLaunchProgress(callback) { if (typeof callback === "function") this._progress.push(callback); }
    onModulePrepared(callback) { if (typeof callback === "function") this._prepared.push(callback); }

    // The plugin caches nothing it is not asked to: no file has a cached copy.
    getCachePath() { return ""; }
    cleanCache() { return Promise.resolve(); }
    cleanAllCache() { return Promise.resolve(); }
    removeFile(path) {
      return new Promise((resolve) => this.fs.unlink({ filePath: path, complete: () => resolve() }));
    }
    hideLoadingPage() {}
    setGameStage() {}
    setDataCDN(cdn) { this.config.DATA_CDN = cdn; }
    setPreloadList(list) { this._preloadList = Array.isArray(list) ? list.slice() : []; }
    setConcurrent(count) { this._concurrent = count | 0; }
    reportGameSceneError() {}
    reportCustomLaunchInfo() {}
    writeLog(...args) { console.log(...args); }
    writeWarn(...args) { console.warn(...args); }
    printErr(...args) { console.error(...args); }
    // A video drawn by the platform's own view (iOS): none here, so the SDK plays it as an ordinary video.
    createWKVideo() { return null; }

    _emit(type) {
      const now = Date.now();
      const event = {
        type,
        data: {
          costTimeMs: now - this._stageAt,
          runTimeMs: now - this._launchedAt,
          loadDataPackageFromSubpackage: !!this.config.loadDataPackageFromSubpackage,
          isVisible: this.isVisible,
          useCodeSplit: false,
          isHighPerformance: false,
          needDownloadDataPackage: !this.config.loadDataPackageFromSubpackage,
        },
      };
      this._stageAt = now;
      for (const callback of this._progress) {
        try { callback(event); } catch (error) { this._error(error); }
      }
    }

    _error(error) {
      console.error("[UnityPlugin]", error && (error.stack || error.message) || error);
      if (typeof this.onLogError === "function") {
        try { this.onLogError(error); } catch { /* the game's own handler failed: nothing more to tell */ }
      }
    }

    _dataPackage() {
      const c = this.config;
      const file = `${c.DATA_FILE_MD5}.${c.GAME_NAME}.data.unityweb.bin`;
      if (c.loadDataPackageFromSubpackage) {
        return loadSubpackage(wx, "data-package")
          .then(() => readPackageFile(this.fs, `data-package/${file}${c.compressDataPackage ? ".br" : ".txt"}`));
      }
      const ns = env.unityNamespace || globalThis.unityNamespace || {};
      const cdn = String(c.DATA_CDN || "").replace(/\/$/, "");
      return download(wx, `${cdn}/${ns.dataFileSubPrefix || ""}${file}`);
    }

    startGame() {
      if (this._started) return;
      this._started = true;
      const c = this.config;
      const ns = env.unityNamespace || globalThis.unityNamespace;
      if (!ns || typeof ns.UnityModule !== "function") {
        this._error(new Error("UnityPlugin: unityNamespace.UnityModule, the engine's factory, is not there"));
        return;
      }
      this._emit(LAUNCH.launchPlugin);
      const UnityLoader = Object.assign(ns.UnityLoader || {}, {
        SystemInfo: systemInfo(wx, c),
        UnityCache: { XMLHttpRequest: globalThis.XMLHttpRequest },
      });
      ns.UnityLoader = UnityLoader;
      globalThis.UnityLoader = UnityLoader;
      // The framework's main loop schedules itself only when the loop runner is on; this plugin leaves the frames to it.
      if (ns.isLoopRunnerEnable === undefined) ns.isLoopRunnerEnable = true;

      const cdn = String(c.DATA_CDN || "").replace(/\/$/, "");
      const resolveBuildUrl = (path) => (/^[a-z]+:\/\//i.test(path) || !cdn ? path : `${cdn}/${path}`);
      const codePath = `wasmcode/${c.CODE_FILE_MD5}.${c.GAME_NAME}.wasm.code.unityweb.wasm.br`;
      const wasmcode = loadSubpackage(wx, "wasmcode");
      let files = null;
      const manager = this;
      const canvas = env.canvas || globalThis.canvas;
      // The engine names its canvas by id for its input and its CSS selector (jsCanvasSelector): a mini-game canvas has
      // none of its own.
      if (canvas && !canvas.id) canvas.id = "canvas";
      const Module = {
        canvas,
        IsWxGame: true,
        webglContextAttributes: { preserveDrawingBuffer: false, powerPreference: 2 },
        streamingAssetsUrl: resolveBuildUrl("StreamingAssets"),
        resolveBuildUrl,
        locateFile: (path) => path,
        print: (text) => console.log(text),
        printErr: (text) => { console.error(text); },
        errorHandler: (error) => { manager._error(error); return false; },
        abortHandler: (reason) => { manager._error(reason); return false; },
        instantiateWasm(imports, receive) {
          manager._emit(LAUNCH.loadWasm);
          wasmcode
            .then(() => globalThis.WXWebAssembly.instantiate(codePath, imports))
            .then((result) => receive(result.instance, result.module))
            .catch((error) => manager._error(error));
          return {};
        },
        wasmInstantiated() { manager._emit(LAUNCH.compileWasm); },
        // /idbfs on the game's user data rather than IndexedDB (persistentFileSystem).
        tuanjieFileSystemInit() {
          const FS = ns.FS;
          FS.mkdir("/idbfs");
          FS.mount(persistentFileSystem(FS, manager.fs, `${wx.env.USER_DATA_PATH}/__UNITY_IDBFS`), {}, "/idbfs");
          Module.addRunDependency("JS_FileSystem_Mount");
          FS.syncfs(true, (error) => {
            if (error) manager._error(error);
            Module.removeRunDependency("JS_FileSystem_Mount");
          });
        },
        preRun: [() => {
          // The data package's files, where the engine reads them: the root of its file system.
          for (const [path, bytes] of files) {
            const slash = path.lastIndexOf("/");
            const dir = slash < 0 ? "" : path.slice(0, slash);
            if (dir) Module.FS_createPath("/", dir, true, true);
            Module.FS_createDataFile(`/${dir}`, path.slice(slash + 1), bytes, true, true, true);
          }
          files = null;
          manager._emit(LAUNCH.readAssets);
          manager.gameInstance = Module;
          for (const callback of manager._prepared) {
            try { callback(Module); } catch (error) { manager._error(error); }
          }
        }],
      };
      this.Module = Module;
      // The engine starts once its code's subpackage is there, after startGame has returned: game.js publishes the
      // manager as GameGlobal.manager only then, and the engine calls it from its first line.
      const data = this._dataPackage();
      wasmcode
        .then(() => {
          // The SDK reaches the engine's module as GameGlobal.Module (its SendMessage, its exports): nothing in the
          // package publishes it, so the plugin does.
          (globalThis.GameGlobal || globalThis).Module = Module;
          const ready = ns.UnityModule(Module);
          data
            .then((buffer) => {
              files = parseDataPackage(buffer);
              this._emit(LAUNCH.loadAssets);
              Module.removeRunDependency("wasm-preloadAssets");
            })
            .catch((error) => this._error(error));
          return ready;
        })
        .then(() => this._emit(LAUNCH.prepareGame), (error) => this._error(error));
    }
  }

  return { default: UnityManager };
}
