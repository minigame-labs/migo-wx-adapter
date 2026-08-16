# migo-wx-adapter

[English](README.md) | [中文](README.zh-CN.md)

发布 `globalThis.wx`，映射到 [migo](https://github.com/minigame-labs/migo) 小游戏运行时自身的 `migo.*` 能力。让针对 `wx` 全局对象编写的小游戏内容——未经改动的微信小游戏源码，或形态类似的小游戏平台上的内容——原样运行在 migo 上。

migo 运行时默认只安装 `migo`。任何规模下 `wx` 都不是内置的——这个适配层就是游戏或宿主选择启用它的方式。

## 何时使用

- 你的内容是真实的、未经改动的 wx 小游戏源码（`wx.createCanvas()`、`wx.getSystemInfoSync()`、`wx.onTouchStart()` 等）。
- 你正在移植一个微信小游戏，想在改动其源码之前先验证它能跑起来。

如果你的内容直接调用 `migo.*`，就不需要这个适配层。

## 这不是什么

这不是 wx 的重新实现。对于 migo 也实现的每一个能力，`wx.foo` 与 `migo.foo` 都是**同一个函数引用**——这个适配层只是在 migo 自身能力之上做命名/形态映射，而不是重新实现它们。如果 migo 没有实现某个 wx API，那么 `wx.thatApi` 在这里就和直接在 `migo` 上一样是 `undefined`；没有哪个适配层能凭空造出运行时本身不具备的能力。

具体来说，这让这个适配层真正做到了很小：它的全部工作就是把 migo 自身的属性描述符拷贝到一个新对象上，再减去一份简短、明确的排除列表（见下文）。这里没有协议转换，没有 polyfill，没有行为层面的垫片——这正是它与 [BOM/DOM 适配层（migo-web-adapter）](https://github.com/minigame-labs/migo-web-adapter) 的区别：后者要做真正的工作，因为浏览器与 wx 小游戏并不共享同一套能力模型；而 wx 小游戏与 migo 是共享的。

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

## 哪些能力被排除在 `wx` 之外

migo 暴露的、超出常见小游戏能力面的部分——为了与浏览器内容互通而存在（Web Gamepad API），但在真实微信上没有对应的 wx API：

| 名称 | 原因 |
|---|---|
| `getGamepads`、`onGamepadConnected`、`offGamepadConnected`、`onGamepadDisconnected`、`offGamepadDisconnected` | 浏览器内容能力，不是 wx API。不放进 `wx` 是为了让从真实 wx 内容移植过来的特性检测代码（`if (!wx.getGamepads) { ... }`）看到的缺失情况与在微信上一致。仍可直接在 `migo` 上访问。 |

该列表与引擎自身 `97_migo_namespace.js` 中的 `_NON_MINIGAME_API` 保持一致；如果那边的集合发生变化，需要同步更新这里。

## 目录结构

```
src/
  index.js          入口 -- 构建并发布 globalThis.wx
scripts/
  build-bundle.mjs   esbuild → dist/migo-wx-adapter.bundle.js（IIFE；供 prelude 注入使用）
tests/
  adapter.test.mjs   针对伪造 migo 运行时的 ESM 行为测试
  bundle.test.mjs    在 vm.Context 中对 IIFE bundle 做冒烟测试，包括
                     幂等性保护与"migo 未启动"失败模式
```

## 运行测试

```sh
node tests/adapter.test.mjs
node tests/bundle.test.mjs
# 或者
npm test                 # 运行以上两者
npm run build && npm test  # 先重新构建 bundle 再测试
```

## 许可证

MIT
