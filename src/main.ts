/**
 * Excalidraw Sticky Note Defaults
 *
 * New Excalidraw sticky notes, with your font and left alignment.
 *
 * WHY A PLUGIN IS NEEDED AT ALL
 * -----------------------------
 * Excalidraw hard-codes a sticky note's label to centred text: on a drawing whose
 * `currentItemTextAlign` was already `"left"`, a new note still came out
 * `textAlign: "center"`. Sticky notes also own no formatting keys of their own --
 * the single sticky-specific appState key is `currentItemStickynoteStrokeColor` --
 * so there is no default to change that would leave ordinary text alone.
 *
 * The label is a plain text element, though, so this plugin rewrites it after
 * creation: poll each open drawing, and when a sticky note appears that was not
 * there before, force the configured `fontFamily` / `textAlign` on its label.
 *
 * Notes that already exist when a drawing is opened are never touched, and a
 * note the user later reformats by hand is not reverted -- only ids never seen
 * before are processed.
 */

import { Notice, Plugin } from "obsidian";
import { StickyNoteFixer, TICK_MS } from "./apply";
import type { StickyDefaults } from "./defaults";
import {
	DEFAULT_SETTINGS,
	StickyDefaultsSettingTab,
	normalizeSettings,
	toStickyDefaults,
	type StickyDefaultsSettings,
} from "./settings";

/** Returned when the feature is off, so every scan short-circuits. */
const NO_DEFAULTS: StickyDefaults = {
	fontFamily: null,
	fontSize: null,
	textAlign: null,
	verticalAlign: null,
};

export default class StickyDefaultsPlugin extends Plugin {
	settings: StickyDefaultsSettings = DEFAULT_SETTINGS;

	/** Watches drawings and rewrites new sticky notes. */
	private fixer: StickyNoteFixer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// The reader is a closure over live settings, so changing a dropdown takes
		// effect on the next tick without restarting the poller.
		this.fixer = new StickyNoteFixer(
			this.app,
			() =>
				this.settings.enabled ? toStickyDefaults(this.settings) : NO_DEFAULTS,
			() => this.settings.debugLog
		);

		this.addSettingTab(new StickyDefaultsSettingTab(this.app, this));

		// Cleared automatically when the plugin unloads.
		this.registerInterval(
			window.setInterval(() => void this.fixer?.tick(), TICK_MS)
		);

		this.addCommand({
			id: "apply-to-open-drawings",
			name: "把便签默认设置套用到已打开的图纸",
			callback: () => void this.applyToOpenDrawings(false),
		});
	}

	/**
	 * Applies the defaults to the notes that already exist.
	 *
	 * @param fromSettingsTab - Whether to confirm in a notice; the command already
	 *   produces its own feedback, and a silent button would be a mystery.
	 */
	async applyToOpenDrawings(fromSettingsTab: boolean): Promise<void> {
		if (!this.settings.enabled) {
			new Notice("便签默认设置已关闭，先打开「启用」。");
			return;
		}
		const changed = (await this.fixer?.applyToExisting()) ?? 0;
		new Notice(
			changed > 0
				? `已改写 ${changed} 个便签的文字样式。`
				: fromSettingsTab
					? "没有需要改写的便签（可能正在编辑中，点一下画布空白处再试）。"
					: "没有需要改写的便签。"
		);
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
