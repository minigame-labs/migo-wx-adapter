# migo-wx-adapter

[English](README.md) | [中文](README.zh-CN.md)

发布 `globalThis.wx`，映射到 [migo](https://github.com/minigame-labs/migo-runtime) 小游戏运行时自身的 `migo.*` 能力。让针对 `wx` 全局对象编写的小游戏内容——未经改动的微信小游戏源码，或形态类似的小游戏平台上的内容——原样运行在 migo 上。

migo 运行时默认只安装 `migo`。任何规模下 `wx` 都不是内置的——这个适配层就是游戏或宿主选择启用它的方式。

## 何时使用

- 你的内容是真实的、未经改动的 wx 小游戏源码（`wx.createCanvas()`、`wx.getSystemInfoSync()`、`wx.onTouchStart()` 等）。
- 你正在移植一个微信小游戏，想在改动其源码之前先验证它能跑起来。

如果你的内容直接调用 `migo.*`，就不需要这个适配层。

## 这不是什么

这不是 wx 的重新实现。对于 migo 也实现的每一个能力，`wx.foo` 与 `migo.foo` 都是**同一个函数引用**——这个适配层只是在 migo 自身能力之上做命名/形态映射，而不是重新实现它们。如果 migo 没有实现某个 wx API，那么 `wx.thatApi` 在这里就和直接在 `migo` 上一样是 `undefined`；没有哪个适配层能凭空造出运行时本身不具备的能力。

具体来说，这让 `wx` 本身真正做到了很小：它就是把 migo 自身的属性描述符拷贝到一个新对象上，名字不同处用 wx 的名字（见下文）。`wx.*` 上没有协议转换，没有 polyfill，没有行为层面的垫片——这正是它与 [BOM/DOM 适配层（migo-web-adapter）](https://github.com/minigame-labs/migo-web-adapter) 的区别：后者要做真正的工作，因为浏览器与 wx 小游戏并不共享同一套能力模型；而 wx 小游戏与 migo 是共享的。

除 `wx` 外，适配层还发布小游戏会用到的另外两个平台全局对象，它们属于平台、不是运行时的能力：`WXWebAssembly` 与 `requirePlugin`（见下文）。二者都以 `migo.*` 实现，且只实现平台定义的部分。

## 安装

纯 ESM 源码——无需构建步骤。

```js
// 游戏入口，需在引用 `wx` 的内容运行之前执行
import "@minigame-labs/migo-wx-adapter";
// 或者，使用 require/AMD 加载器：
require("./src/index.js");
```

这个适配层通过 `globalThis.__migoWxAdapterInjected` 检测重复加载，可以安全地被 import 两次。它与 [`@minigame-labs/migo-web-adapter`](https://github.com/minigame-labs/migo-web-adapter)（BOM/DOM）同时加载也是安全的——两者涉及的全局对象互不重叠。

### 通过运行时启动前导脚本实现零改动测试

与 BOM/DOM 适配层机制相同：构建一次 IIFE bundle，通过 `InitOptions::with_prelude_script` 交给运行时，这样即便第三方 wx 内容自己并不 import 这个适配层，也能在运行前完成 `wx` 的接入。

```sh
npm run build
# → dist/migo-wx-adapter.bundle.js
```

```rust
let bundle = std::fs::read_to_string("path/to/migo-wx-adapter.bundle.js")?;
let init = InitOptions::new()
    .with_prelude_script("<migo-wx-adapter>", bundle)
    // ……其他选项
    ;
```

在 Android 上，通过 `RuntimeConfig.Builder`：

```java
String bundle = readAssetAsString(context, "migo-wx-adapter.bundle.js");
RuntimeConfig config = new RuntimeConfig.Builder(context)
        .addPreludeScript("<migo-wx-adapter>", bundle)
        .build();
```

## 与 `migo` 名字不同的 API

每个 `migo.*` 名字都以同一个函数发布到 `wx` 上。migo 不带任何平台的品牌名，所以 wx 以自家平台命名的 API，在 migo 里按语义命名，由本适配器以 wx 的名字发布：

| `migo` | `wx` |
|---|---|
| `updateHostApp` | `updateWeChatApp` |

## `WXWebAssembly`

引擎有 `WebAssembly` 时，与 `wx` 一同发布。`WXWebAssembly.instantiate(path, imports)` 接受游戏包内 `.wasm`
文件的路径（不接受字节，也不接受 URL），经引擎的文件系统读取，返回值同 `WebAssembly.instantiate`。其余成员就是
`WebAssembly` 自己的（`Memory`、`Table`、`Global`、`Module`、`Instance` 和各错误类型）；接受字节的那几个（`compile`、
`validate`、两个 streaming 方法）不提供。brotli 压缩的 `.wasm.br` 与平台一样接受：由引擎的 `readCompressedFile` 解码。

## `requirePlugin`

`requirePlugin(name, options)` 返回游戏在 `game.json` 的 `plugins` 里声明的插件的导出，每个插件只创建一次，所有
`requirePlugin` 共享。平台上的插件是提供方托管的代码，不在游戏包里；这里的插件由本适配层提供（`src/plugins/`）。
游戏没有声明的插件、或这里没有实现的插件都是"not defined"，与平台对游戏不能使用的插件的说法一致。宿主若在适配层之前装了自己的
`requirePlugin`，会保留宿主的。

| 插件 | 提供 |
|---|---|
| `UnityPlugin` | 团结（Unity）小游戏导出的启动：其 `game.js` 把数据包、WebAssembly 与引擎启动交给它（`src/plugins/unity.js`）。 |

`UnityPlugin` 依据导出包、其 framework 与 SDK 对它的要求实现：game.js 创建的 manager（`new UnityManager(config)`、
`onLaunchProgress`、`onModulePrepared`、`startGame`，以及 framework 与 SDK 在它上面调用的成员）；经 `WXWebAssembly` 从
`wasmcode` 分包实例化 wasm；从 `data-package` 分包或构建的 CDN 取数据包（`TuanjieWebData1.0` / `UnityWebData1.0`），写入引擎的文件系统；
引擎的持久目录 `/idbfs`（PlayerPrefs、存档）存在游戏的用户数据目录而不是 IndexedDB；`UnityLoader.SystemInfo` 与 `GameGlobal.Module`。
平台自家插件为其产品附加的部分——启动封面、下载缓存、启动上报——这里没有：启动事件照常触发，上报不发往任何地方。migo-conformance
套件用编辑器的小游戏导出构建一个团结关卡，经本适配层在 migo 上运行（`games/tuanjie`，`game-tuanjie-cube-drop-minigame`）。

## 目录结构

```
src/
  index.js          入口 -- 构建并发布 globalThis.wx、WXWebAssembly 与 requirePlugin
  require-plugin.js  requirePlugin 与这里提供的插件的登记表
  plugins/unity.js   UnityPlugin，团结（Unity）小游戏导出的启动
scripts/
  build-bundle.mjs   esbuild → dist/migo-wx-adapter.bundle.js（IIFE；供 prelude 注入使用）
tests/
  adapter.test.mjs   针对伪造 migo 运行时的 ESM 行为测试
  plugins.test.mjs   requirePlugin 与 UnityPlugin，针对伪造的文件系统、平台分包与
                     WXWebAssembly，以及导出包 framework 的伪造实现
  bundle.test.mjs    在 vm.Context 中对 IIFE bundle 做冒烟测试，包括
                     幂等性保护与"migo 未启动"失败模式
```

## 运行测试

```sh
node tests/adapter.test.mjs
node tests/plugins.test.mjs
node tests/bundle.test.mjs
# 或者
npm test                 # 运行以上三者
npm run build && npm test  # 先重新构建 bundle 再测试
```

## 许可证

MIT
