/**
 * Settings storage and the settings tab.
 *
 * Storage is deliberately plain: `0` means "leave this numeric property alone"
 * and `"keep"` means "leave this alignment alone", so a stored value is always
 * either a real Excalidraw value or an explicit opt-out.
 * {@link toStickyDefaults} converts that into the `null`-based shape the rest of
 * the code uses.
 */

import { App, PluginSettingTab, Setting } from "obsidian";
import type StickyDefaultsPlugin from "./main";
import {
	FONT_OPTIONS,
	FONT_SIZES,
	TEXT_ALIGNMENTS,
	VERTICAL_ALIGNMENTS,
	isAlignSetting,
	isFontId,
	isFontSizeSetting,
	isVerticalAlignSetting,
	type AlignSetting,
	type StickyDefaults,
	type VAlignSetting,
} from "./defaults";

/** Persisted settings. */
export interface StickyDefaultsSettings {
	/** Master switch. Off means the poller does nothing at all. */
	enabled: boolean;
	/** Excalidraw font id to force, or `0` to leave the font alone. */
	fontFamily: number;
	/** Font-size ceiling, or `0` to leave it alone. */
	fontSize: number;
	/** Horizontal alignment to force, or `"keep"`. */
	textAlign: AlignSetting;
	/** Vertical alignment to force, or `"keep"`. */
	verticalAlign: VAlignSetting;
}

/**
 * Shipped defaults: Cascadia, 左对齐 + 顶部对齐.
 *
 * Font size stays "keep" -- most people want Excalidraw's own sizing there, and
 * for a sticky note the value is only a ceiling anyway.
 */
export const DEFAULT_SETTINGS: StickyDefaultsSettings = {
	enabled: true,
	fontFamily: 3,
	fontSize: 0,
	textAlign: "left",
	verticalAlign: "top",
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

	// `0` is a real stored value meaning "leave it alone", so it must survive a
	// reload rather than be mistaken for a missing/invalid entry. Only a value
	// that is neither `0` nor a known id falls back to the default.
	const fontFamily =
		raw.fontFamily === 0 || isFontId(raw.fontFamily)
			? (raw.fontFamily as number)
			: DEFAULT_SETTINGS.fontFamily;
	const fontSize =
		raw.fontSize === 0 || isFontSizeSetting(raw.fontSize)
			? (raw.fontSize as number)
			: DEFAULT_SETTINGS.fontSize;

	return {
		enabled:
			typeof raw.enabled === "boolean"
				? raw.enabled
				: DEFAULT_SETTINGS.enabled,
		fontFamily,
		fontSize,
		textAlign: isAlignSetting(raw.textAlign)
			? raw.textAlign
			: DEFAULT_SETTINGS.textAlign,
		verticalAlign: isVerticalAlignSetting(raw.verticalAlign)
			? raw.verticalAlign
			: DEFAULT_SETTINGS.verticalAlign,
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
		fontSize: isFontSizeSetting(settings.fontSize) ? settings.fontSize : null,
		textAlign: settings.textAlign === "keep" ? null : settings.textAlign,
		verticalAlign:
			settings.verticalAlign === "keep" ? null : settings.verticalAlign,
	};
}

/** Labels for the horizontal-alignment dropdown. */
const ALIGN_LABELS: Record<AlignSetting, string> = {
	left: "左对齐",
	center: "居中",
	right: "右对齐",
	keep: "不修改",
};

/** Labels for the vertical-alignment dropdown. */
const VALIGN_LABELS: Record<VAlignSetting, string> = {
	top: "顶部",
	middle: "垂直居中",
	bottom: "底部",
	keep: "不修改",
};

/** Labels for the font-size dropdown, matching Excalidraw's own presets. */
const SIZE_LABELS: Record<number, string> = {
	16: "16（S）",
	20: "20（M / Excalidraw 默认）",
	28: "28（L）",
	36: "36（XL）",
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
				"新建便签后自动套用下面各项。已有便签不受影响 —— " +
					"要一次性套用到当前图纸，用最下面的按钮或同名命令。"
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
			.setName("便签字号上限")
			.setDesc(
				"这是**上限**而不是固定字号：便签会自动适配 —— " +
					"字号从上限往下缩，缩到下限后才加高便签。" +
					"所以设大了并不保证那么大。"
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("0", "不修改");
				for (const size of FONT_SIZES) {
					dropdown.addOption(String(size), SIZE_LABELS[size] ?? String(size));
				}
				dropdown
					.setValue(String(this.plugin.settings.fontSize))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.fontSize = isFontSizeSetting(parsed)
							? parsed
							: 0;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("便签默认水平对齐")
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
			.setName("便签默认垂直对齐")
			.setDesc(
				"会写进文字元素的 `verticalAlign` 字段。**但 Excalidraw 自己的 API " +
					"文档把这个字段标注为「For future use, has no effect currently」**，" +
					"所以你的版本若忽略它，界面上看不出变化 —— 那不是插件没写进去。" +
					"另外 Excalidraw 没有「全局垂直对齐」这个默认值，无法从设置里改。"
			)
			.addDropdown((dropdown) => {
				for (const value of ["keep", ...VERTICAL_ALIGNMENTS] as VAlignSetting[]) {
					dropdown.addOption(value, VALIGN_LABELS[value]);
				}
				dropdown
					.setValue(this.plugin.settings.verticalAlign)
					.onChange(async (value) => {
						this.plugin.settings.verticalAlign = isVerticalAlignSetting(
							value
						)
							? value
							: "keep";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("套用到当前图纸的已有便签")
			.setDesc(
				"把上面各项立即套用到所有已打开的 Excalidraw 图纸里现存的便签。" +
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
