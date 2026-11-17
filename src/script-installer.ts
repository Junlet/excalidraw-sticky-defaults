/**
 * Installs the bundled Excalidraw scripts -- and their icons -- into this vault.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin reaches every vault through BRAT, but the script-library buttons are
 * plain files inside the vault, so they do not travel with the plugin. Doing the
 * copy by hand in every vault invites version drift between the scripts and the
 * code they call.
 *
 * So the script texts live here, next to the code they invoke, and one command
 * writes them into the folder Excalidraw actually scans -- read from Excalidraw's
 * own settings rather than assumed, because that path is configurable per vault.
 *
 * THE ICONS
 * ---------
 * Excalidraw takes a script's icon from a **sibling file with the same name and
 * an `.svg` extension** (`getIMGFilename(scriptPath, "svg")` in its script
 * engine), reading the file's text as the icon markup. So each script is
 * installed as a pair: the script and its icon.
 *
 * Safety rules, because this writes files the user will see:
 *   - nothing is written when an identical file is already there;
 *   - an existing file is only overwritten when it carries the matching
 *     `managed-by` marker, i.e. this plugin wrote it;
 *   - anything else is reported as a conflict and left untouched.
 */

import type { App } from "obsidian";
import { EXCALIDRAW_PLUGIN_ID } from "./constants";

/**
 * Marker proving this plugin owns a file.
 *
 * Present in every file this module writes, so a later run can distinguish
 * "refresh our own file" from "the user has a file of the same name".
 */
export const MANAGED_MARKER = "managed-by: excalidraw-sticky-defaults";

/** The same marker in HTML-comment form, for the SVG icons. */
export const ICON_MARKER = `<!-- ${MANAGED_MARKER} -->`;

/** Fallback used when Excalidraw's own setting cannot be read. */
export const DEFAULT_SCRIPT_FOLDER = "Excalidraw/Scripts";

/**
 * Applies the sticky-note defaults.
 *
 * Contains no rewriting logic: it calls the plugin, so settings, behaviour and
 * the result notice stay in one place.
 */
export const STICKY_SCRIPT_CONTENT = `/*
# 套用便签默认设置

把 Excalidraw 便签的**字体 / 字号上限 / 水平对齐 / 垂直对齐**一键改成你在设置里定的值（可以只改选中的便签）。

本脚本**不含改写逻辑**，只是把 **Excalidraw Sticky Note Defaults** 插件的「立即套用」搬进脚本库，方便在画布里直接点。设置项、改写逻辑、结果提示都在那个插件里 —— 这样只有一份真相，不会两边不一致。

## 为什么需要它

Excalidraw 会把便签文字**强制居中**，改它的默认对齐没用；便签也没有专属的格式键。所以只能创建后改写文字元素。而新建便签会立刻打开文字编辑器，自动改写容易和编辑器抢跑 —— 因此改成**手动触发**。

## 用法

1. 在 Excalidraw 里打开脚本库，点「套用便签默认设置」
2. 或命令面板搜「套用便签默认设置」
3. 或在插件设置页点「立即套用」

三者效果完全相同。点完右上角会提示改写了几个便签、用的是哪种范围。

**只改选中的便签**：先在画布上选中它们再点。默认「自动」—— 选中了便签就只改选中的，没选中就改全部。

## 依赖

必须启用 **Excalidraw Sticky Note Defaults** 插件（id: \`excalidraw-sticky-defaults\`）；没启用时会提示你去启用。

## 提示

- 正在编辑的便签会被跳过（避免打断输入）—— 点一下画布空白处再点一次即可
- 幂等：已经符合的便签不会被重复写，也不占撤销栈
- ${MANAGED_MARKER}（这一行由插件写入，用于判断文件归属；删除它不会影响脚本运行）
*/

const plugin = window.app?.plugins?.plugins?.["excalidraw-sticky-defaults"];

if (!plugin || typeof plugin.applyNow !== "function") {
	new Notice(
		"请先在「设置 → 第三方插件」启用 Excalidraw Sticky Note Defaults，再运行这个脚本。"
	);
	return;
}

await plugin.applyNow();
`;

/** The sticky-note script's icon: a note with a folded corner and three lines. */
export const STICKY_SCRIPT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40" fill="none">
${ICON_MARKER}
<path d="M9 5h22a4 4 0 0 1 4 4v15l-9 9H9a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z" fill="#F3F1FF" stroke="#6965DB" stroke-width="2.2" stroke-linejoin="round"/>
<path d="M26 33v-6a3 3 0 0 1 3-3h6" fill="#DDD8FF" stroke="#6965DB" stroke-width="2.2" stroke-linejoin="round"/>
<path d="M11 13h16M11 19h16M11 25h9" stroke="#6965DB" stroke-width="2.2" stroke-linecap="round"/>
</svg>
`;

/**
 * Opens the selected elements' links in new tabs.
 *
 * Standalone: it needs only Excalidraw, not this plugin. It reads `el.link`
 * first, because that is where every linked element keeps its target (text,
 * shapes, and the `embeddable` elements the plugin creates for other drawings);
 * images inserted from the vault carry their file in the plugin's own image
 * registry instead, so that is the documented fallback.
 */
export const OPEN_LINK_SCRIPT_CONTENT = `/*
# 在新标签页打开选中元素的链接

选中画布上的元素，把它们的链接/文件**在新标签页打开**。

- 选中**图片** → 打开这张图片
- 选中**插入到当前图纸的其它 Excalidraw** → 打开那个图纸
- 选中**带链接的文字/形状** → 打开链接（站内文件或外部网址都行）
- 多选 → 全部打开，重复的只开一次

## 用法

1. 在画布上选中一个或多个元素
2. 运行本脚本（脚本库 / 命令面板 / 快捷键）
3. 结果会以右上角提示告诉你开了几个、有几个元素没有链接

## 说明

- 站内文件走 Obsidian 的链接解析，相对路径按**当前图纸**的位置解析
- 外部网址（\`http(s)://\`）用浏览器新标签页打开
- 优先读元素自己的 \`link\` 字段；图片若没有 \`link\`，就从 Excalidraw 插件的图片登记表里取它对应的文件
- 不依赖任何其它插件
- ${MANAGED_MARKER}（这一行由插件写入，用于判断文件归属；删除它不会影响脚本运行）
*/

const selected = ea.getViewSelectedElements();

if (!selected || selected.length === 0) {
	new Notice("先选中要打开的元素（图片、嵌入的 Excalidraw、带链接的文字或形状）。");
	return;
}

const view = ea.targetView;
const sourcePath = view?.file?.path ?? "";
const obsidian = window.app;

/** 元素 → 目标（站内路径或网址），拿不到就返回 null。 */
function resolveTarget(element) {
	const link = typeof element.link === "string" ? element.link.trim() : "";
	if (link) return link;

	// 图片：Excalidraw 插件把对应的库内文件登记在图片表里
	if (element.type === "image") {
		try {
			const entry = view?.excalidrawData?.getFile?.(element.fileId);
			if (entry?.isHyperLink && entry.hyperlink) return entry.hyperlink;
			if (entry?.file?.path) return entry.file.path;
		} catch (error) {
			console.warn("[打开选中元素的链接] 读取图片登记失败", error);
		}
	}

	return null;
}

/** 去掉 [[ ]] / ![[ ]] 包裹、别名与尺寸后缀，得到 Obsidian 能解析的链接文本。 */
function normalize(target) {
	let text = target.trim();
	const isUrl = /^https?:\\/\\//i.test(text);
	if (isUrl) return text;
	text = text.replace(/^!?\\[\\[/, "").replace(/\\]\\]$/, "");
	text = text.split("|")[0].trim();
	return text;
}

const targets = [];
const seen = new Set();
let withoutLink = 0;

for (const element of selected) {
	const raw = resolveTarget(element);
	if (!raw) {
		withoutLink += 1;
		continue;
	}
	const target = normalize(raw);
	if (!target) {
		withoutLink += 1;
		continue;
	}
	if (seen.has(target)) continue;
	seen.add(target);
	targets.push(target);
}

if (targets.length === 0) {
	new Notice(
		"选中的 " + selected.length + " 个元素里没有可打开的链接。"
	);
	return;
}

let opened = 0;
for (const target of targets) {
	try {
		if (/^https?:\\/\\//i.test(target)) {
			window.open(target, "_blank");
		} else {
			await obsidian.workspace.openLinkText(target, sourcePath, true);
		}
		opened += 1;
	} catch (error) {
		console.error("[打开选中元素的链接] 打开失败", target, error);
	}
}

const parts = ["已在新标签页打开 " + opened + " 个链接"];
if (targets.length > opened) parts.push((targets.length - opened) + " 个打开失败（详见控制台）");
if (withoutLink > 0) parts.push(withoutLink + " 个元素没有链接");
new Notice(parts.join("；") + "。");
`;

/** The open-link script's icon: a page with an arrow leaving it. */
export const OPEN_LINK_SCRIPT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40" fill="none">
${ICON_MARKER}
<rect x="5.5" y="13.5" width="20" height="20" rx="3.5" fill="#F3F1FF" stroke="#6965DB" stroke-width="2.2"/>
<path d="M22 6h12v12" stroke="#6965DB" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M34 6 20 20" stroke="#6965DB" stroke-width="2.2" stroke-linecap="round"/>
</svg>
`;

/** One script that ships with this plugin. */
export interface BundledScript {
	/** Short name used in notices. */
	label: string;
	/** File name inside the script folder. */
	fileName: string;
	/** Script body. */
	content: string;
	/** Icon file name (same stem, `.svg`). */
	iconFileName: string;
	/** Icon markup. */
	icon: string;
}

/** Everything this plugin installs, in install order. */
export const BUNDLED_SCRIPTS: readonly BundledScript[] = [
	{
		label: "套用便签默认设置",
		fileName: "套用便签默认设置.md",
		content: STICKY_SCRIPT_CONTENT,
		iconFileName: "套用便签默认设置.svg",
		icon: STICKY_SCRIPT_ICON,
	},
	{
		label: "在新标签页打开选中元素的链接",
		fileName: "在新标签页打开选中元素的链接.md",
		content: OPEN_LINK_SCRIPT_CONTENT,
		iconFileName: "在新标签页打开选中元素的链接.svg",
		icon: OPEN_LINK_SCRIPT_ICON,
	},
];

/** What {@link installScripts} did to one file. */
export type FileStatus = "created" | "updated" | "present" | "conflict";

/** What {@link installScripts} did to one script. */
export interface ScriptInstallEntry {
	/** Short name from {@link BundledScript}. */
	label: string;
	/** Outcome for the script file itself. */
	status: FileStatus;
	/** Outcome for its icon (best effort). */
	icon: FileStatus;
	/** Vault path of the script file. */
	path: string;
}

/** What {@link installScripts} did overall. */
export interface InstallReport {
	/** Per-script outcomes, in install order. */
	entries: ScriptInstallEntry[];
	/** Set when the run failed before touching every script. */
	error?: string;
}

/** The slice of Obsidian's vault this module needs. */
interface VaultLike {
	getFolderByPath?(path: string): unknown;
	getAbstractFileByPath(path: string): unknown;
	createFolder(path: string): Promise<unknown>;
	create(path: string, data: string): Promise<unknown>;
	read(file: unknown): Promise<string>;
	modify(file: unknown, data: string): Promise<void>;
}

/**
 * Reads the folder Excalidraw scans for scripts.
 *
 * `scriptFolderPath` is user-configurable per vault, so it is read rather than
 * assumed; the shipped default is used when the plugin or the key is missing.
 *
 * @param app - The Obsidian app.
 * @returns A vault-relative folder with no leading or trailing slash.
 */
export function resolveScriptFolder(app: App): string {
	const registry = (app as unknown as {
		plugins?: { plugins?: Record<string, unknown> };
	}).plugins;
	const excalidraw = registry?.plugins?.[EXCALIDRAW_PLUGIN_ID] as
		| { settings?: { scriptFolderPath?: unknown } }
		| undefined;
	const configured = excalidraw?.settings?.scriptFolderPath;
	if (typeof configured !== "string") return DEFAULT_SCRIPT_FOLDER;

	const trimmed = configured
		.replace(/\\/gu, "/")
		.replace(/^\/+|\/+$/gu, "")
		.trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_SCRIPT_FOLDER;
}

/** Joins folder and file name without introducing a double slash. */
function joinPath(folder: string, name: string): string {
	return folder.length > 0 ? `${folder}/${name}` : name;
}

/**
 * Ensures every segment of a folder path exists.
 *
 * @param vault - The vault.
 * @param folder - Vault-relative folder.
 */
async function ensureFolder(vault: VaultLike, folder: string): Promise<void> {
	if (folder.length === 0) return;
	if (vault.getFolderByPath?.(folder)) return;
	try {
		await vault.createFolder(folder);
	} catch {
		// Re-check: createFolder throws when the folder already exists, which is
		// the expected outcome for a pre-existing scripts folder.
		if (!vault.getFolderByPath?.(folder)) throw new Error(`无法创建目录：${folder}`);
	}
}

/**
 * Writes one managed file, respecting existing content.
 *
 * @param vault - The vault.
 * @param path - Vault-relative path.
 * @param content - What the file should contain.
 * @param marker - Ownership marker that licenses an overwrite.
 * @returns What happened.
 */
async function ensureFile(
	vault: VaultLike,
	path: string,
	content: string,
	marker: string
): Promise<FileStatus> {
	const existing = vault.getAbstractFileByPath(path);
	if (!existing) {
		await vault.create(path, content);
		return "created";
	}

	const current = await vault.read(existing);
	if (current === content) return "present";
	if (!current.includes(marker)) return "conflict";

	await vault.modify(existing, content);
	return "updated";
}

/**
 * Writes every bundled script and its icon into the vault's script folder.
 *
 * One conflicting script does not stop the others: the report says per script
 * what happened, so a single filename clash cannot block an install.
 *
 * @param app - The Obsidian app.
 * @returns Per-script outcomes, plus an error when the folder could not be made.
 */
export async function installScripts(app: App): Promise<InstallReport> {
	const vault = (app as unknown as { vault?: VaultLike }).vault;
	if (!vault || typeof vault.create !== "function") {
		return { entries: [], error: "拿不到 vault 接口" };
	}

	const folder = resolveScriptFolder(app);
	try {
		await ensureFolder(vault, folder);
	} catch (error) {
		return {
			entries: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const entries: ScriptInstallEntry[] = [];
	for (const script of BUNDLED_SCRIPTS) {
		const path = joinPath(folder, script.fileName);
		try {
			const status = await ensureFile(
				vault,
				path,
				script.content,
				MANAGED_MARKER
			);

			// The icon is cosmetic: a clash there must not fail the script, and a
			// script without an icon still runs, so it stays best-effort.
			let icon: FileStatus = "conflict";
			if (status !== "conflict") {
				try {
					icon = await ensureFile(
						vault,
						joinPath(folder, script.iconFileName),
						script.icon,
						ICON_MARKER
					);
				} catch (iconError) {
					console.warn(
						"[excalidraw-sticky-defaults] 写入脚本图标失败（不影响脚本运行）",
						iconError
					);
				}
			}

			entries.push({ label: script.label, status, icon, path });
		} catch (error) {
			return {
				entries,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	return { entries };
}
