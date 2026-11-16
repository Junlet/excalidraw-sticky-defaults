# Excalidraw Sticky Note Defaults

让 Excalidraw 里**新建的便签（Sticky note）**自动使用你指定的**字体**和**左对齐**。

---

## 为什么需要这个插件

Excalidraw 的 Sticky note 工具创建便签时，**强制**把便签文字设为居中，而且**没有**任何设置项可以改。实测证据（在一张 `currentItemTextAlign` 已经是 `"left"` 的图纸里新建便签）：

```
label对齐:     'center'   ← 便签标签被强制居中
当前项对齐:    'left'     ← 但 Excalidraw 的"新文本默认对齐"是 left
```

也就是说：改 Excalidraw 的默认值**不会**影响便签。便签也没有自己专属的格式键 —— 它唯一的便签专属 appState 键是 `currentItemStickynoteStrokeColor`（边框色），所以也没有一个"只改便签、不动普通文本"的默认值可用。

**可行的办法**：便签的文字是一个普通的文本元素，`fontFamily` / `textAlign` 都是它的字段 —— 所以在便签创建后把这两个字段改写掉。

## 它怎么工作

每 300ms 比较一次打开中图纸的**场景版本号**（一个数字，开销可忽略；版本没变就直接返回）。发现**新出现的** `stickynote` 时：

1. 找到它的 label（`boundElements` 里 `type: "text"` 的那个元素，找不到则回退按 `containerId` 扫）
2. **如果这个 label 正在编辑中 → 跳过**，等下一次轮询再处理（避免打断你打字）
3. 只改**确实不同**的字段，然后通过 ExcalidrawAutomate 的官方路径写回（`copyViewElementsToEAforEditing` → `addElementsToView`），并以 `captureUpdate: NEVER` 提交，**不占用你的撤销栈**

以下情况**绝不**改动：

- 打开图纸时**已经存在**的便签（首次扫描只做记录，不写）
- 你后来**手动改过**字体/对齐的便签（只处理从没见过的 id，改完就记住）

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 启用 | 开 | 关闭后连轮询都直接返回 |
| 便签默认字体 | **不修改** | Excalidraw 内置 9 种字体的 id（Virgil / Helvetica / Cascadia / 本地字体 / Excalifont / Nunito / Lilita One / Comic Shanns / Liberation Sans） |
| 便签默认对齐 | **左对齐** | 或居中 / 右对齐 / 不修改 |
| 套用到当前图纸的已有便签 | — | 一次性按钮；也会注册成命令 |

> 9 种内置字体**都不含中文字形**，中文会回退到系统字体 —— 这是 Excalidraw 字体本身的限制，不是插件的问题。

## 已知限制

1. **打字时可能先看到居中**，点一下画布空白处才变左对齐。这是刻意取舍：`textAlign` 在文字编辑器还开着时改写会打断输入，所以插件会等编辑结束。想立刻套用就点一下空白处（或用「套用到当前图纸」按钮）。
2. **字号没有做成设置项**。便签的字号是**自动适配**的：Excalidraw 会从你给的字号上限往下缩，缩到下限后才加高便签。所以"默认字号"的语义是"上限"，设大了也会被压回去。
3. 便签元素类型（`stickynote`）是 Excalidraw 0.18 才有的。旧版没有便签，插件会静默不动作。
4. 罕见情况：如果 Excalidraw 修改了 label 的字段名，插件写入会失败 —— 会在控制台报一次错，不影响其它功能。

## 安装

把 `main.js`、`manifest.json`、`styles.css` 放进 `<仓库>/.obsidian/plugins/excalidraw-sticky-defaults/`，重载后在「设置 → 第三方插件」**启用**。

或用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) → **Add a beta plugin for testing** → 填 `Junlet/excalidraw-sticky-defaults`。

## 依赖

| 依赖 | 说明 |
|---|---|
| Obsidian | ≥ 1.8.7 |
| **Excalidraw** 社区插件 | 必须启用（id `obsidian-excalidraw-plugin`），且版本含 Sticky note（0.18+） |

没有 Excalidraw 不会崩：拿不到 ExcalidrawAutomate 时只在控制台提示一次。

## 实现要点（给改代码的人）

| 文件 | 职责 |
|---|---|
| `src/defaults.ts` | 纯逻辑：字体/对齐取值校验、找 label、算最小补丁 —— **不依赖 Obsidian，可单测** |
| `src/apply.ts` | 轮询场景版本、识别新便签、编辑中跳过、经 ExcalidrawAutomate 写回 |
| `src/settings.ts` | 设置存储（`0` = 不改字体、`"keep"` = 不改对齐）与设置面板 |
| `src/main.ts` | 生命周期、300ms 轮询、命令 |

**为什么是轮询**：目标版本的 ExcalidrawAutomate 没有 `onChange` / `offChange`，Excalidraw 插件也不派发场景变化事件，所以只能用 `getSceneVersion()` 做廉价的变更检测。

**为什么用 `getAPI(view)`**：它给每个图纸一个**专用**的 ExcalidrawAutomate 实例，不会碰到 `window.ExcalidrawAutomate`，也不会干扰别的图纸。

## 许可

MIT
