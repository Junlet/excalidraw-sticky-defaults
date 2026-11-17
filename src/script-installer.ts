/**
 * Installs the companion Excalidraw script into the current vault.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin reaches every vault through BRAT, but the script-library button is
 * a plain file inside the vault, so it does not travel with the plugin. Doing the
 * copy by hand in every vault invites version drift between the script and the
 * plugin it calls.
 *
 * So the script text lives here, next to the code it invokes, and one command
 * writes it into the folder Excalidraw actually scans -- read from Excalidraw's
 * own settings rather than assumed, because that path is configurable per vault.
 *
 * Safety rules, because this writes a file the user will see:
 *   - nothing is written when an identical file is already there;
 *   - an existing file is only overwritten when it carries {@link MANAGED_MARKER},
 *     i.e. this plugin wrote it;
 *   - anything else is reported as a conflict and left untouched.
 */

import type { App } from "obsidian";
import { EXCALIDRAW_PLUGIN_ID } from "./constants";

/** The script's file name inside the script folder. */
export const SCRIPT_FILE_NAME = "套用便签默认设置.md";

/**
 * Marker proving this plugin owns the file.
 *
 * Present in every script this module writes, so a later run can distinguish
 * "refresh our own file" from "the user has a file of the same name".
 */
export const MANAGED_MARKER = "managed-by: excalidraw-sticky-defaults";

/** Fallback used when Excalidraw's own setting cannot be read. */
export const DEFAULT_SCRIPT_FOLDER = "Excalidraw/Scripts";

/**
 * The script itself.
 *
 * It deliberately contains no rewriting logic: it calls the plugin, so settings,
 * behaviour and the result notice stay in one place.
 */
export const SCRIPT_CONTENT = `/*
# 套用便签默认设置

把 Excalidraw 便签的**字体 / 字号上限 / 水平对齐 / 垂直对齐**一键改成你在设置里定的值。

本脚本**不含改写逻辑**，只是把 **Excalidraw Sticky Note Defaults** 插件的「立即套用」搬进脚本库，方便在画布里直接点。设置项、改写逻辑、结果提示都在那个插件里 —— 这样只有一份真相，不会两边不一致。

## 为什么需要它

Excalidraw 会把便签文字**强制居中**，改它的默认对齐没用；便签也没有专属的格式键。所以只能创建后改写文字元素。而新建便签会立刻打开文字编辑器，自动改写容易和编辑器抢跑 —— 因此改成**手动触发**。

## 用法

1. 在 Excalidraw 里打开脚本库，点「套用便签默认设置」
2. 或命令面板搜「套用便签默认设置」
3. 或在插件设置页点「立即套用」

三者效果完全相同。点完右上角会提示改写了几个便签。

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

/** What {@link installScript} did. */
export type InstallResult =
	| { status: "created"; path: string }
	| { status: "updated"; path: string }
	| { status: "present"; path: string }
	| { status: "conflict"; path: string }
	| { status: "error"; path: string; reason: string };

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
 * Writes the companion script into the vault's Excalidraw script folder.
 *
 * @param app - The Obsidian app.
 * @returns What happened, including the vault path involved.
 */
export async function installScript(app: App): Promise<InstallResult> {
	const vault = (app as unknown as { vault?: VaultLike }).vault;
	if (!vault || typeof vault.create !== "function") {
		return { status: "error", path: "", reason: "拿不到 vault 接口" };
	}

	const folder = resolveScriptFolder(app);
	const path = joinPath(folder, SCRIPT_FILE_NAME);

	try {
		await ensureFolder(vault, folder);

		const existing = vault.getAbstractFileByPath(path);
		if (existing) {
			const current = await vault.read(existing);
			if (current === SCRIPT_CONTENT) return { status: "present", path };
			if (!current.includes(MANAGED_MARKER)) {
				return { status: "conflict", path };
			}
			// Ours but outdated: refresh it so the script keeps matching the
			// plugin it calls.
			await vault.modify(existing, SCRIPT_CONTENT);
			return { status: "updated", path };
		}

		await vault.create(path, SCRIPT_CONTENT);
		return { status: "created", path };
	} catch (error) {
		return {
			status: "error",
			path,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
