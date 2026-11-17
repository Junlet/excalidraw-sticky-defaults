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

**没有后台监听**：由你点按钮触发。三个入口效果完全相同：

| 入口 | 位置 |
|---|---|
| 丝带按钮 | 左侧竖栏的便签图标 |
| 命令 | 命令面板搜「套用便签默认设置」 |
| 设置页 | 「立即套用」按钮 |

点一次 = 把设置里的字体 / 字号 / 水平对齐 / 垂直对齐套用到便签（**默认只改选中的，没选中就改全部** —— 见下面的「作用范围」）：

1. 按**作用范围**挑出要处理的便签（选中便签的**文字**也算选中它）
2. 找到每个 `stickynote` 的 label（`boundElements` 里 `type: "text"` 的元素，找不到则回退按 `containerId` 扫）
3. **编辑器开着就跳过并计数**（判据：appState 的 `editingTextElement`，或视图里存在 `textarea`）—— 否则会打断输入
4. 只改**确实不同**的字段，通过 ExcalidrawAutomate 的官方路径写回（`copyViewElementsToEAforEditing` → `addElementsToView`），以 `captureUpdate: NEVER` 提交，**不占用撤销栈**
5. 右上角 Notice 明确告诉你：改了几个、**用了哪种范围**、跳过几个、为什么没改

**幂等**：再点一次不会重复写。

### 作用范围

| 选项 | 行为 |
|---|---|
| **自动**（默认） | 选中的元素里有便签 → 只改选中的；否则改整张图纸 |
| 全部便签 | 不管选中什么，改整张图纸 |
| 仅选中的便签 | 只改选中的；没选中就什么都不做（并提示你） |

选中便签的**文字**而不是外框，也算选中了它 —— 点文字比点边框容易得多。

实际用了哪种范围，点击后的提示里会写明（多张图纸分别判断时会写「部分图纸仅选中」）。

## 为什么不自动监听

试过。新建便签会**立刻打开文字编辑器**，而编辑器提交时会把 label 写回创建时的值（`1 / center / middle`）—— 自动改写每次都在和这个编辑器赛跑，而且失败时是静默的。所以改成「你决定什么时候套用 + 结果明说」。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 启用 | 开 | 关闭后点按钮会提示先启用 |
| 便签默认字体 | **Cascadia** | Excalidraw 内置 9 种字体的 id，或「不修改」 |
| 便签字号上限 | 不修改 | 16 / 20 / 28 / 36（Excalidraw 自己的 S/M/L/XL），或「不修改」 |
| 便签默认水平对齐 | **左对齐** | 或居中 / 右对齐 / 不修改 |
| 便签默认垂直对齐 | **顶部** | 或垂直居中 / 底部 / 不修改 |
| 作用范围 | **自动** | 自动 / 全部便签 / 仅选中的便签 |
| 套用到已打开的图纸 | — | **唯一的触发方式**（设置里的按钮 / 丝带按钮 / 命令） |
| 调试日志 | 关 | 打开后每次改写都在控制台打一行（便签 id + 改了哪些字段） |

> 9 种内置字体**都不含中文字形**，中文会回退到系统字体 —— 这是 Excalidraw 字体本身的限制，不是插件的问题。
>
> **字号是「上限」不是固定值**：便签会自动适配 —— 从上限往下缩，缩到下限后才加高便签。设大了并不保证那么大。

## 能不能改 Excalidraw 的「全局对齐」达到同样效果？

**横向：不能，已验证。** 在一张 `currentItemTextAlign` 已经是 `"left"` 的图纸里新建便签，标签仍然是 `"center"`：

```
label对齐:     'center'
当前项对齐:    'left'
```

**纵向：也没有这个设置可改。** Excalidraw 的 appState 里**不存在**任何全局垂直对齐的键 —— `currentItemVerticalAlign`、`currentItemTextVerticalAlign`、`currentItemAlign` 全部 0 命中。

而且 ExcalidrawAutomate 自己的 API 文档对 `style.verticalAlign` 的说明是：

> `'top' | 'bottom' | 'middle'` —— **For future use, has no effect currently**

所以本插件会把 `verticalAlign` **写进文字元素字段**（这是插件能做的极限），但**是否被渲染引擎采纳取决于 Excalidraw 版本**。如果你的版本忽略它，界面上看不出变化 —— 那不是插件没写进去。

便签也没有自己专属的格式键：它唯一的便签专属 appState 键是 `currentItemStickynoteStrokeColor`（边框色）。所以不存在「只改便签、不动普通文本」的默认值可用，只能创建后改写。

## 已知限制

1. **需要你手动点**：不再自动监听新便签。新建之后点一下丝带按钮（或命令），Notice 会告诉你改了几个。
2. **正在编辑的便签会被跳过**：改写会打断输入，所以插件跳过它并在 Notice 里说明。点一下画布空白处让编辑器关闭，再点一次即可。
3. **垂直对齐可能看不出效果** —— Excalidraw 自己把这个字段标为「目前无效果」，见上一节。
4. **字号是「上限」**：便签会自动适配（从上限往下缩、缩到下限才加高便签），设大了也会被压回去。
5. 便签元素类型（`stickynote`）是 Excalidraw 0.18 才有的。旧版没有便签，Notice 会说「没有找到便签」。
6. 罕见情况：如果 Excalidraw 修改了 label 的字段名，Notice 会提示「写入失败（详见控制台）」。

## 安装

把 `main.js`、`manifest.json`、`styles.css` 放进 `<仓库>/.obsidian/plugins/excalidraw-sticky-defaults/`，重载后在「设置 → 第三方插件」**启用**。

或用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) → **Add a beta plugin for testing** → 填 `Junlet/excalidraw-sticky-defaults`。

## 依赖

| 依赖 | 说明 |
|---|---|
| Obsidian | ≥ 1.8.7 |
| **Excalidraw** 社区插件 | 必须启用（id `obsidian-excalidraw-plugin`），且版本含 Sticky note（0.18+） |

没有 Excalidraw 不会崩：拿不到 ExcalidrawAutomate 时会在 Notice 里说明。

## 在 Excalidraw 脚本库里加按钮（两个脚本）

Excalidraw 的脚本库把**脚本文件当作可点的按钮**。本插件自带这个脚本，装进当前库只要一步：

> 命令面板 → **安装脚本到 Excalidraw 脚本库**
> （设置页里也有同名按钮：**安装 / 更新脚本**）

脚本会被写到 Excalidraw 设置的**脚本文件夹**（默认 `Excalidraw/Scripts`，路径是读 Excalidraw 自己的设置，所以在自定义过脚本目录的库里也会放对位置），文件名 `套用便签默认设置.md`。

**同时写入图标**：`套用便签默认设置.svg`。Excalidraw 的脚本图标就是取**同目录同名的 `.svg`** 文件内容（脚本引擎里 `getIMGFilename(scriptPath, "svg")`），所以两个文件必须成对存在。图标画的是便签 + 折角 + 三行文字，用 Excalidraw 的紫色，明暗主题都看得清。

写入规则：

| 情况 | 行为 |
|---|---|
| 文件不存在 | 创建（必要时建目录） |
| 内容已是最新 | 不写，提示「无需重复安装」 |
| 是插件写的但版本旧 | 更新（靠文件里的 `managed-by` 标记识别） |
| **你自己写的同名脚本** | **不覆盖**，提示冲突并让你改名或删除 |

### 换到别的库怎么办

**每个库都点一次那条命令。** 插件能通过 BRAT 自动装到所有库，但脚本是库里的文件，不会跟着插件走 —— 这也是给它做成命令的原因：一次点击，不用担心两边内容不一致。

### 两个脚本分别做什么

**1. 套用便签默认设置** —— 转调本插件的 `applyNow()`，设置与逻辑都在插件里。

**2. 在新标签页打开选中元素的链接** —— 独立脚本，不依赖本插件：

| 选中什么 | 打开什么 |
|---|---|
| 图片 | 这张图片 |
| 插入到当前图纸的其它 Excalidraw（`embeddable`） | 那个图纸 |
| 带链接的文字 / 形状 | 该链接（站内文件或外部网址） |
| 多选 | 全部打开，重复的只开一次 |

解析顺序：先读元素的 `el.link`；图片没有 `el.link` 时再查插件图片登记表 `excalidrawData.getFile(el.fileId)` 的 `file.path` / `hyperlink`。站内文件用 `workspace.openLinkText(target, 当前图纸路径, true)` 在新标签页打开，`http(s)` 交给浏览器。

### 脚本内容

脚本只做转发，逻辑全在插件里，所以插件升级后脚本无需跟着改：

````markdown
/*
# 套用便签默认设置

把便签的字体 / 字号上限 / 水平对齐 / 垂直对齐改成设置里的值。
本脚本不含逻辑，只是调用 Excalidraw Sticky Note Defaults 插件的 applyNow()。
*/
const plugin = window.app?.plugins?.plugins?.["excalidraw-sticky-defaults"];

if (!plugin || typeof plugin.applyNow !== "function") {
	new Notice(
		"请先在「设置 → 第三方插件」启用 Excalidraw Sticky Note Defaults，再运行这个脚本。"
	);
	return;
}

await plugin.applyNow();
````

> 脚本目录里新增文件后，若脚本库没立刻出现，重载 Obsidian 即可。

## 实现要点（给改代码的人）

| 文件 | 职责 |
|---|---|
| `src/defaults.ts` | 纯逻辑：字体/对齐取值校验、找 label、算最小补丁 —— **不依赖 Obsidian，可单测** |
| `src/apply.ts` | 一次性的 `applyStickyDefaults()`：遍历已打开图纸、跳过编辑中的便签、经 ExcalidrawAutomate 写回 |
| `src/settings.ts` | 设置存储（`0` = 不改字体、`"keep"` = 不改对齐）与设置面板 |
| `src/main.ts` | 生命周期、丝带按钮、命令、结果 Notice |

**为什么是轮询**：目标版本的 ExcalidrawAutomate 没有 `onChange` / `offChange`，Excalidraw 插件也不派发场景变化事件，所以只能用 `getSceneVersion()` 做廉价的变更检测。

**为什么用 `getAPI(view)`**：它给每个图纸一个**专用**的 ExcalidrawAutomate 实例，不会碰到 `window.ExcalidrawAutomate`，也不会干扰别的图纸。

## 许可

MIT
