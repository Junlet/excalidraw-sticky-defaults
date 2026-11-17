/**
 * Excalidraw Sticky Note Defaults
 *
 * Rewrites the labels of Excalidraw sticky notes so they use your font, size and
 * alignment.
 *
 * WHY A PLUGIN IS NEEDED AT ALL
 * -----------------------------
 * Excalidraw hard-codes a sticky note's label to centred text: on a drawing whose
 * `currentItemTextAlign` was already `"left"`, a new note still came out
 * `textAlign: "center"`. Sticky notes also own no formatting keys of their own --
 * the single sticky-specific appState key is `currentItemStickynoteStrokeColor` --
 * so there is no default to change that would leave ordinary text alone.
 *
 * WHY IT IS A BUTTON AND NOT A WATCHER
 * ------------------------------------
 * The label is a plain text element, so the plugin can rewrite it -- but only
 * once. A note opens its text editor the moment it is created, and when that
 * editor commits it writes the label back with its creation-time values,
 * undoing any automatic patch. Watching for that and re-patching was fragile and
 * failed silently.
 *
 * So the trigger is manual and explicit: the ribbon button, the command, or the
 * button in the settings pane. Each click rewrites every sticky note in every
 * open drawing and then reports exactly what happened -- how many changed, how
 * many were skipped because you were editing them, and whether Excalidraw could
 * not be reached at all.
 */

import { Notice, Plugin } from "obsidian";
import { applyStickyDefaults, type ApplyOutcome } from "./apply";
import { isNoop } from "./defaults";
import {
	installScripts,
	type InstallReport,
} from "./script-installer";
import {
	DEFAULT_SETTINGS,
	StickyDefaultsSettingTab,
	normalizeSettings,
	toStickyDefaults,
	type StickyDefaultsSettings,
} from "./settings";

/** Icon id for the ribbon button; the name is Excalidraw's own sticky-note idea. */
const RIBBON_ICON = "sticky-note";

/** How long the result notice stays up. */
const NOTICE_MS = 8000;

/**
 * Which scope a run actually used, in words.
 *
 * With several drawings open the scope can differ per view (`"auto"` narrows
 * only where something is selected), so the mixed case is reported as such
 * rather than picking one and being subtly wrong.
 *
 * @param outcome - What the run did.
 */
function scopeLabel(outcome: ApplyOutcome): string {
	if (outcome.limitedViews === 0) return "全部";
	if (outcome.limitedViews >= outcome.views) return "仅选中";
	return "部分图纸仅选中";
}

/**
 * Turns the outcome into one sentence the user can act on.
 *
 * Every branch says something concrete: "nothing found", "everything already
 * matched" and "the scope excluded everything" must not look the same as "it
 * silently did nothing", which is exactly how the earlier polling version felt.
 *
 * @param outcome - What the run did.
 */
export function describeOutcome(outcome: ApplyOutcome): string {
	if (outcome.noAutomate) {
		return "取不到 ExcalidrawAutomate：请确认 Excalidraw 插件已启用并与 Obsidian 版本匹配。";
	}
	if (outcome.noSelection) {
		return "选中的元素里没有便签：先选中便签再点，或把「作用范围」改成「全部」。";
	}
	if (outcome.notes === 0) {
		return "没有找到便签：请先打开一张含便签的 Excalidraw 图纸，再点这个按钮。";
	}

	const parts: string[] = [];
	parts.push(
		outcome.changed > 0
			? `已改写 ${outcome.changed} 个便签`
			: "没有需要改写的便签（已经是目标样式）"
	);
	parts.push(`范围：${scopeLabel(outcome)}`);
	if (outcome.editing > 0) {
		parts.push(`跳过 ${outcome.editing} 个正在编辑的（点一下画布空白处再点一次）`);
	}
	if (outcome.noLabel > 0) {
		parts.push(`${outcome.noLabel} 个找不到文字元素`);
	}
	if (outcome.failed > 0) {
		parts.push(`${outcome.failed} 张图纸写入失败（详见控制台）`);
	}
	return `${parts.join(" · ")}（共发现 ${outcome.notes} 个便签）`;
}

/**
 * Turns an install report into one sentence.
 *
 * The conflict case is the interesting one: the plugin refuses to overwrite a
 * file it did not write, and names it instead of silently replacing the user's
 * own script of the same name.
 *
 * @param report - What {@link installScripts} did.
 */
export function describeInstall(report: InstallReport): string {
	if (report.error) return `安装脚本失败：${report.error}`;
	if (report.entries.length === 0) return "没有可安装的脚本。";

	const count = (status: string): number =>
		report.entries.filter((entry) => entry.status === status).length;
	const created = count("created");
	const updated = count("updated");
	const present = count("present");
	const conflicts = report.entries.filter((entry) => entry.status === "conflict");
	const icons = report.entries.filter(
		(entry) => entry.icon === "created" || entry.icon === "updated"
	).length;

	if (created === 0 && updated === 0 && conflicts.length === 0) {
		return `脚本已是最新，无需重复安装（${present} 个）${
			icons > 0 ? "，图标已补上" : ""
		}。`;
	}

	const parts: string[] = [];
	if (created > 0) parts.push(`新增 ${created}`);
	if (updated > 0) parts.push(`更新 ${updated}`);
	if (present > 0) parts.push(`已是最新 ${present}`);
	let message = `共 ${report.entries.length} 个脚本：${parts.join("、")}`;
	if (icons > 0) message += `（写入 ${icons} 个图标）`;
	if (conflicts.length > 0) {
		message += `；未覆盖同名文件：${conflicts
			.map((entry) => entry.label)
			.join("、")}（如需用插件版，请先改名或删除）`;
	}
	return message;
}

export default class StickyDefaultsPlugin extends Plugin {
	settings: StickyDefaultsSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new StickyDefaultsSettingTab(this.app, this));

		// No interval, no background work: the plugin only acts when asked.
		this.addRibbonIcon(RIBBON_ICON, "套用便签默认设置", () => {
			void this.applyNow();
		});

		this.addCommand({
			id: "apply-sticky-defaults",
			name: "套用便签默认设置（所有已打开的图纸）",
			callback: () => void this.applyNow(),
		});

		this.addCommand({
			id: "install-sticky-script",
			name: "安装脚本到 Excalidraw 脚本库",
			callback: () => void this.installCompanionScript(),
		});
	}

	/**
	 * Writes the bundled scripts into this vault's Excalidraw script folder.
	 *
	 * This is how the scripts reach another vault: BRAT installs the plugin, and
	 * one command here creates the script-library buttons next to it. The folder
	 * is read from Excalidraw's own settings, so a vault with a customised script
	 * path also gets them in the right place.
	 */
	async installCompanionScript(): Promise<void> {
		const report = await installScripts(this.app);
		new Notice(describeInstall(report), NOTICE_MS);
	}

	/**
	 * Runs the rewrite and reports the result.
	 *
	 * The same notice is shown whether it was triggered from the ribbon, the
	 * command or the settings tab: the outcome is what matters, not the entry
	 * point.
	 */
	async applyNow(): Promise<void> {
		if (!this.settings.enabled) {
			new Notice("便签默认设置已关闭：先在上面打开「启用」。");
			return;
		}
		const defaults = toStickyDefaults(this.settings);
		if (isNoop(defaults)) {
			new Notice(
				"字体、字号、水平对齐、垂直对齐全都是「不修改」，没有可套用的内容。"
			);
			return;
		}

		const outcome = await applyStickyDefaults(this.app, defaults, {
			scope: this.settings.scope,
			debug: this.settings.debugLog,
		});
		new Notice(describeOutcome(outcome), NOTICE_MS);
	}

	/** Loads persisted settings, falling back to defaults. */
	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	/** Persists the current settings. */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
