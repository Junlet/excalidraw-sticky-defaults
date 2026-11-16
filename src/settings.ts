/**
 * Settings storage and the settings tab.
 *
 * Storage is deliberately plain: `0` means "leave the font alone" and `"keep"`
 * means "leave the alignment alone", so a stored value is always either a real
 * Excalidraw id or an explicit opt-out. {@link toStickyDefaults} converts that
 * into the `null`-based shape the rest of the code uses.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type StickyDefaultsPlugin from "./main";
import {
	FONT_OPTIONS,
	TEXT_ALIGNMENTS,
	isAlignSetting,
	isFontId,
	type AlignSetting,
	type StickyDefaults,
} from "./defaults";

/** Persisted settings. */
export interface StickyDefaultsSettings {
	/** Master switch. Off means the poller does nothing at all. */
	enabled: boolean;
	/** Excalidraw font id to force, or `0` to leave the font alone. */
	fontFamily: number;
	/** Alignment to force, or `"keep"`. */
	textAlign: AlignSetting;
}

/**
 * Shipped defaults.
 *
 * On with left alignment: forcing left is the whole point of the plugin, and a
 * note is only affected when it is created *after* installation.
 */
export const DEFAULT_SETTINGS: StickyDefaultsSettings = {
	enabled: true,
	fontFamily: 0,
	textAlign: "left",
};

/**
 * Merges stored data over the defaults, rejecting unusable values.
 *
 * @param stored - Raw value from `loadData()`.
 * @returns Complete, valid settings.
 */
export function normalizeSettings(stored: unknown): StickyDefaultsSettings {
	const raw = (
		stored && typeof stored === "object" ? stored : {}
	) as Partial<StickyDefaultsSettings>;

	return {
		enabled:
			typeof raw.enabled === "boolean"
				? raw.enabled
				: DEFAULT_SETTINGS.enabled,
		fontFamily: isFontId(raw.fontFamily)
			? raw.fontFamily
			: DEFAULT_SETTINGS.fontFamily,
		textAlign: isAlignSetting(raw.textAlign)
			? raw.textAlign
			: DEFAULT_SETTINGS.textAlign,
	};
}

/**
 * Resolves the settings into what gets forced onto a label.
 *
 * @param settings - Current settings.
 * @returns `null` for every property that should be left alone.
 */
export function toStickyDefaults(
	settings: StickyDefaultsSettings
): StickyDefaults {
	return {
		fontFamily: isFontId(settings.fontFamily) ? settings.fontFamily : null,
		textAlign: settings.textAlign === "keep" ? null : settings.textAlign,
	};
}

/** Translated labels for the alignment dropdown. */
const ALIGN_LABELS: Record<AlignSetting, string> = {
	left: "左对齐",
	center: "居中",
	right: "右对齐",
	keep: "不修改",
};

/** Settings tab shown under Settings -> Community plugins -> this plugin. */
export class StickyDefaultsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: StickyDefaultsPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("启用")
			.setDesc(
				"新建便签后自动套用下面的字体与对齐。已有便签不受影响 —— " +
					"要一次性套用到当前图纸，用下面的按钮或命令。"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enabled)
					.onChange(async (value) => {
						this.plugin.settings.enabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("便签默认字体")
			.setDesc(
				"只在**新建**便签时套用。「不修改」保持 Excalidraw 自己的行为。" +
					"注意：这些是 Excalidraw 内置字体，都不含中文字形，" +
					"中文会回退到系统字体。"
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("0", "不修改");
				for (const option of FONT_OPTIONS) {
					dropdown.addOption(String(option.value), option.label);
				}
				dropdown
					.setValue(String(this.plugin.settings.fontFamily))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.fontFamily = isFontId(parsed)
							? parsed
							: 0;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("便签默认对齐")
			.setDesc(
				"Excalidraw 会把便签文字**强制居中**，改它的默认值没用 —— " +
					"所以本插件是在便签创建后改写文字元素。副作用：打字时可能先看到" +
					"居中、点一下空白处才变左对齐（编辑中不打断你输入）。"
			)
			.addDropdown((dropdown) => {
				for (const value of ["keep", ...TEXT_ALIGNMENTS] as AlignSetting[]) {
					dropdown.addOption(value, ALIGN_LABELS[value]);
				}
				dropdown
					.setValue(this.plugin.settings.textAlign)
					.onChange(async (value) => {
						this.plugin.settings.textAlign = isAlignSetting(value)
							? value
							: "keep";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("套用到当前图纸的已有便签")
			.setDesc(
				"把上面两项立即套用到所有已打开的 Excalidraw 图纸里现存的便签。" +
					"正在编辑的便签会跳过，点一下空白处再点一次即可。"
			)
			.addButton((button) =>
				button
					.setButtonText("套用")
					.onClick(async () => {
						await this.plugin.applyToOpenDrawings(true);
					})
			);
	}
}
