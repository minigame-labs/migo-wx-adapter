// requirePlugin, the mini-game platform's: the exports of a plugin the game declares in its game.json `plugins`, by the
// name it gives it there. On the platform a plugin is code its provider hosts, not part of the game's package; here it is
// a provider this adapter carries (src/plugins/), registered under the plugin's name. A plugin the game does not declare,
// or that no provider here implements, is "not defined", as the platform says of one the game may not use -- the words a
// Tuanjie export looks for to tell its owner the plugin must be enabled.
//
// The exports are made once per plugin and shared by every requirePlugin of it, as the platform's are.

const providers = new Map();

/// Register `factory(options)` -> exports as the provider of the plugin `name`.
export function registerPluginProvider(name, factory) {
  providers.set(String(name), factory);
}

// The plugins game.json declares, or null when it cannot be read (then any provided plugin may be required).
function declaredPlugins(migo) {
  try {
    const text = migo.getFileSystemManager().readFileSync("game.json", "utf8");
    const json = JSON.parse(String(text));
    return json && typeof json.plugins === "object" && json.plugins !== null ? json.plugins : {};
  } catch {
    return null;
  }
}

export function installRequirePlugin(global, migo) {
  if (typeof global.requirePlugin === "function") return;
  let declared;
  const made = new Map();
  Object.defineProperty(global, "requirePlugin", {
    value: function requirePlugin(name, options) {
      const key = String(name);
      if (made.has(key)) return made.get(key);
      if (declared === undefined) declared = declaredPlugins(migo);
      if (declared !== null && !Object.prototype.hasOwnProperty.call(declared, key)) {
        throw new Error(`requirePlugin: plugin "${key}" is not defined: game.json declares no plugin of that name`);
      }
      const factory = providers.get(key);
      if (!factory) {
        throw new Error(`requirePlugin: plugin "${key}" is not defined: this platform provides no plugin of that name`);
      }
      const exports = factory(options === undefined ? {} : options, declared && declared[key]);
      made.set(key, exports);
      return exports;
    },
    writable: true, enumerable: false, configurable: true,
  });
}
