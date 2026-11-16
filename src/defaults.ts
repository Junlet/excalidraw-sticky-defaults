/**
 * Pure decision logic for the sticky-note defaults.
 *
 * Kept free of Obsidian and Excalidraw so the rules -- which element counts as
 * a sticky note, which label belongs to it, and whether a patch is needed --
 * can be tested on their own.
 *
 * WHY THIS IS A POST-PROCESS, NOT A DEFAULT
 * -----------------------------------------
 * Excalidraw decides the label's font and alignment itself when the Sticky note
 * tool creates one, and it *forces* the label to `textAlign: "center"`: on a
 * drawing whose `currentItemTextAlign` was already `"left"`, a freshly created
 * note still came out `"center"`. Sticky notes have no formatting keys of their
 * own either -- the only sticky-specific appState key is
 * `currentItemStickynoteStrokeColor` -- so there is no default to set that
 * would leave ordinary text alone.
 *
 * What is left is to rewrite the label after the fact: the label *is* a text
 * element, and `fontFamily` / `textAlign` are plain fields on it.
 */

/** Horizontal alignment accepted by Excalidraw text elements. */
export type TextAlign = "left" | "center" | "right";

/** Every alignment the settings offer, in menu order. */
export const TEXT_ALIGNMENTS: readonly TextAlign[] = ["left", "center", "right"];

/** `"keep"` means "do not touch this property at all". */
export type AlignSetting = TextAlign | "keep";

/**
 * Excalidraw's built-in fonts, with the ids Excalidraw itself uses.
 *
 * `0` is this plugin's "leave the font alone" value and is not an Excalidraw id.
 * None of these fonts covers CJK, so Chinese text falls back to a system font.
 */
export const FONT_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
	{ value: 1, label: "Virgil（手写）" },
	{ value: 2, label: "Helvetica（无衬线）" },
	{ value: 3, label: "Cascadia（代码）" },
	{ value: 4, label: "本地字体（Local Font）" },
	{ value: 5, label: "Excalifont" },
	{ value: 6, label: "Nunito" },
	{ value: 7, label: "Lilita One" },
	{ value: 8, label: "Comic Shanns" },
	{ value: 9, label: "Liberation Sans" },
];

/** The values this plugin writes, resolved from the settings. */
export interface StickyDefaults {
	/** Excalidraw font id, or `null` to leave the font alone. */
	fontFamily: number | null;
	/** Alignment to force, or `null` to leave it alone. */
	textAlign: TextAlign | null;
}

/** True when the settings ask for no change at all. */
export function isNoop(defaults: StickyDefaults): boolean {
	return defaults.fontFamily === null && defaults.textAlign === null;
}

/**
 * Reports whether a value is one of Excalidraw's built-in font ids.
 *
 * @param value - Candidate id. `0` is the plugin's "keep" marker, not a font.
 */
export function isFontId(value: unknown): value is number {
	return (
		typeof value === "number" &&
		FONT_OPTIONS.some((option) => option.value === value)
	);
}

/**
 * Reports whether a value is a usable alignment setting.
 *
 * @param value - Candidate value.
 */
export function isAlignSetting(value: unknown): value is AlignSetting {
	return value === "keep" || TEXT_ALIGNMENTS.includes(value as TextAlign);
}

/** The parts of a Canvas-free Excalidraw element this module reads. */
export interface ElementLike {
	id?: unknown;
	type?: unknown;
	containerId?: unknown;
	boundElements?: unknown;
	fontFamily?: unknown;
	textAlign?: unknown;
}

/** Reports whether an element is a sticky-note container. */
export function isStickyNote(element: ElementLike): boolean {
	return element.type === "stickynote";
}

/**
 * Finds the bound text element that holds a sticky note's label.
 *
 * The container lists it in `boundElements`; a scan for a text element whose
 * `containerId` points back at the container is kept as a fallback, because
 * that list is rebuilt by Excalidraw and can be momentarily absent.
 *
 * @param note - The sticky-note container.
 * @param elements - The whole scene.
 * @returns The label element, or `null` when the note has no text yet.
 */
export function boundLabelOf(
	note: ElementLike,
	elements: readonly ElementLike[]
): ElementLike | null {
	const bound = note.boundElements;
	if (Array.isArray(bound)) {
		for (const entry of bound) {
			if (!entry || typeof entry !== "object") continue;
			const candidate = entry as { id?: unknown; type?: unknown };
			if (candidate.type !== "text" || typeof candidate.id !== "string") {
				continue;
			}
			const label = elements.find((el) => el.id === candidate.id);
			if (label) return label;
		}
	}
	const fallback = elements.find(
		(el) => el.type === "text" && el.containerId === note.id
	);
	return fallback ?? null;
}

/** What still has to change on one label. */
export interface LabelPatch {
	fontFamily?: number;
	textAlign?: TextAlign;
}

/**
 * Computes the minimal patch for one label.
 *
 * Only properties that differ are included, so a label that already matches
 * produces `null` and nothing is written -- which is what keeps the feature from
 * dirtying the drawing on every scan.
 *
 * @param label - The note's bound text element.
 * @param defaults - The configured defaults.
 * @returns The patch, or `null` when the label already matches.
 */
export function labelPatch(
	label: ElementLike,
	defaults: StickyDefaults
): LabelPatch | null {
	const patch: LabelPatch = {};
	if (defaults.fontFamily !== null && label.fontFamily !== defaults.fontFamily) {
		patch.fontFamily = defaults.fontFamily;
	}
	if (defaults.textAlign !== null && label.textAlign !== defaults.textAlign) {
		patch.textAlign = defaults.textAlign;
	}
	return Object.keys(patch).length > 0 ? patch : null;
}
