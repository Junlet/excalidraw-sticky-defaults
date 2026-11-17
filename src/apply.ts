/**
 * One-shot rewrite of sticky-note labels, triggered by the user.
 *
 * WHY THERE IS NO POLLING
 * -----------------------
 * Earlier versions watched open drawings and patched new sticky notes as they
 * appeared. That never worked reliably: a note opens its text editor the moment
 * it is created, and when that editor commits it writes the label back with its
 * own creation-time values, undoing the patch. Every fix for that race (waiting
 * a beat, retrying, watching for a grace period) added moving parts and still
 * failed sometimes, silently.
 *
 * So detection is gone. The user picks the moment: a ribbon button, a command,
 * the settings pane or the script-library button rewrites the labels and then
 * *reports what happened* through a notice. Nothing runs in the background.
 *
 * SCOPE
 * -----
 * A run can be limited to the current selection. See {@link ApplyScope} for why
 * `"auto"` is the shipped default, and note that whatever a run decided is
 * stated in the notice -- a scope that quietly guessed wrong would be
 * indistinguishable from a broken button.
 */

import type { App } from "obsidian";
import { EXCALIDRAW_PLUGIN_ID } from "./constants";
import {
	boundLabelOf,
	isNoop,
	isStickyNote,
	labelPatch,
	type ApplyScope,
	type ElementLike,
	type LabelPatch,
	type StickyDefaults,
} from "./defaults";

/** What one run of {@link applyStickyDefaults} did. */
export interface ApplyOutcome {
	/** Sticky notes the run considered (after applying the scope). */
	notes: number;
	/** Labels actually rewritten. */
	changed: number;
	/** Notes skipped because a text editor was open. */
	editing: number;
	/** Notes whose bound label could not be found. */
	noLabel: number;
	/** Drawings whose write failed. */
	failed: number;
	/** True when ExcalidrawAutomate could not be reached at all. */
	noAutomate: boolean;
	/** Drawings the run looked at. */
	views: number;
	/** Drawings whose run was limited to the selection. */
	limitedViews: number;
	/** True when the scope asked for a selection but none held a sticky note. */
	noSelection: boolean;
}

/** Knobs for one run. */
export interface ApplyOptions {
	/** Which notes to touch. Defaults to `"auto"`. */
	scope?: ApplyScope;
	/** Log each rewritten label to the console. */
	debug?: boolean;
}

/** The parts of the Excalidraw view this module reads. */
interface ExcalidrawViewLike {
	excalidrawAPI?: {
		getSceneElements?: () => unknown;
		getAppState?: () => unknown;
	} | null;
	containerEl?: { querySelector?: (selector: string) => unknown };
}

/** The parts of ExcalidrawAutomate this module calls. */
interface AutomateLike {
	copyViewElementsToEAforEditing(elements: unknown[]): void;
	getElement(id: string): Record<string, unknown> | undefined;
	addElementsToView(
		repositionToCursor?: boolean,
		save?: boolean,
		newElementsOnTop?: boolean,
		shouldRestoreElements?: boolean,
		captureUpdate?: unknown
	): Promise<boolean>;
	destroy?(): void;
}

/** Reads the editing state out of whatever `getAppState()` returned. */
function editingIds(state: unknown): { id?: unknown; containerId?: unknown } {
	const editing = (state as { editingTextElement?: unknown } | undefined)
		?.editingTextElement;
	if (!editing || typeof editing !== "object") return {};
	const element = editing as { id?: unknown; containerId?: unknown };
	return { id: element.id, containerId: element.containerId };
}

/**
 * Ids of the sticky notes the user has selected.
 *
 * Selecting a note's text label instead of the note itself is counted as
 * selecting the note: the label is what this plugin rewrites, and clicking the
 * words rather than the coloured box is easy to do by accident.
 *
 * @param elements - The scene.
 * @param state - `getAppState()` result, read for `selectedElementIds`.
 */
export function selectedNoteIds(
	elements: readonly ElementLike[],
	state: unknown
): Set<string> {
	const selected = new Set<string>();
	const raw = (state as { selectedElementIds?: unknown } | undefined)
		?.selectedElementIds;
	if (!raw || typeof raw !== "object") return selected;

	for (const [id, on] of Object.entries(raw as Record<string, unknown>)) {
		if (!on) continue;
		const element = elements.find((el) => el.id === id);
		if (!element) continue;
		if (isStickyNote(element)) {
			selected.add(id);
		} else if (element.type === "text" && typeof element.containerId === "string") {
			selected.add(element.containerId);
		}
	}
	return selected;
}

/**
 * Whether a text editor is open, so writing would fight the user.
 *
 * Two signals. The `textarea` probe is blunt -- it reacts to *any* open editor in
 * the view -- but it does not depend on an internal appState key, and here a
 * false positive only means "try again after clicking away", which the notice
 * says out loud.
 *
 * @param view - The drawing.
 * @param label - The label about to be written.
 */
export function isEditing(view: ExcalidrawViewLike, label: ElementLike): boolean {
	try {
		if (view.containerEl?.querySelector?.("textarea")) return true;
	} catch {
		// A missing/odd container is not a reason to skip.
	}

	let state: unknown;
	try {
		state = view.excalidrawAPI?.getAppState?.();
	} catch {
		return false;
	}
	const { id, containerId } = editingIds(state);
	if (id === undefined && containerId === undefined) return false;
	return id === label.id || containerId === label.id;
}

/**
 * Mints an ExcalidrawAutomate bound to one view.
 *
 * `getAPI(view)` is Excalidraw's own factory, so the instance belongs to this
 * view and cannot disturb `window.ExcalidrawAutomate` or another drawing.
 *
 * @param app - The Obsidian app.
 * @param view - The drawing to target.
 */
function acquireAutomate(
	app: App,
	view: ExcalidrawViewLike
): AutomateLike | null {
	const registry = (app as unknown as {
		plugins?: { plugins?: Record<string, unknown> };
	}).plugins;
	const plugin = registry?.plugins?.[EXCALIDRAW_PLUGIN_ID] as
		| { ea?: { getAPI?: (target: unknown) => AutomateLike } }
		| undefined;
	const factory = plugin?.ea;
	if (!factory || typeof factory.getAPI !== "function") return null;
	try {
		return factory.getAPI(view) ?? null;
	} catch {
		return null;
	}
}

/**
 * Commits label patches for one drawing through ExcalidrawAutomate.
 *
 * The same route the Excalidraw plugin uses for its own element edits: copy the
 * scene elements onto a workbench, mutate the copies, then let
 * `addElementsToView()` merge them back with proper version bumps and redrawing.
 * `"NEVER"` is passed as the capture action so a cosmetic fix does not land on
 * the undo stack.
 *
 * @returns True when the elements were committed.
 */
async function writePatches(
	app: App,
	view: ExcalidrawViewLike,
	elements: ElementLike[],
	patches: Array<{ labelId: string; patch: LabelPatch }>
): Promise<boolean> {
	const ea = acquireAutomate(app, view);
	if (!ea) return false;

	try {
		const targets = patches
			.map((entry) => elements.find((el) => el.id === entry.labelId))
			.filter((el): el is ElementLike => el !== undefined);
		if (targets.length === 0) return false;

		ea.copyViewElementsToEAforEditing(targets);
		for (const entry of patches) {
			const target = ea.getElement(entry.labelId);
			if (!target) continue;
			if (entry.patch.fontFamily !== undefined) {
				target.fontFamily = entry.patch.fontFamily;
			}
			if (entry.patch.fontSize !== undefined) {
				target.fontSize = entry.patch.fontSize;
			}
			if (entry.patch.textAlign !== undefined) {
				target.textAlign = entry.patch.textAlign;
			}
			if (entry.patch.verticalAlign !== undefined) {
				target.verticalAlign = entry.patch.verticalAlign;
			}
		}
		return await ea.addElementsToView(false, true, false, false, "NEVER");
	} catch (error) {
		console.error("[excalidraw-sticky-defaults] 写入便签 label 失败", error);
		return false;
	} finally {
		ea.destroy?.();
	}
}

/**
 * Rewrites sticky-note labels in every open Excalidraw drawing.
 *
 * Idempotent: labels that already match produce no patch and no write, so a
 * second click is harmless.
 *
 * @param app - The Obsidian app.
 * @param defaults - What to force; `null` fields are left alone.
 * @param options - Scope and logging.
 * @returns What happened, for the caller to report.
 */
export async function applyStickyDefaults(
	app: App,
	defaults: StickyDefaults,
	options: ApplyOptions = {}
): Promise<ApplyOutcome> {
	const scope = options.scope ?? "auto";
	const outcome: ApplyOutcome = {
		notes: 0,
		changed: 0,
		editing: 0,
		noLabel: 0,
		failed: 0,
		noAutomate: false,
		views: 0,
		limitedViews: 0,
		noSelection: false,
	};
	if (isNoop(defaults)) return outcome;

	for (const leaf of app.workspace.getLeavesOfType("excalidraw")) {
		const view = leaf.view as unknown as ExcalidrawViewLike | undefined;
		const api = view?.excalidrawAPI;
		const elements = api?.getSceneElements?.();
		if (!view || !Array.isArray(elements)) continue;
		outcome.views += 1;

		const scene = elements as ElementLike[];
		let state: unknown;
		try {
			state = api?.getAppState?.();
		} catch {
			state = undefined;
		}
		const selection = selectedNoteIds(scene, state);

		// "selected" obeys the user literally; "auto" only narrows when the
		// selection actually holds a note.
		const limitToSelection =
			scope === "selected" || (scope === "auto" && selection.size > 0);
		if (limitToSelection) outcome.limitedViews += 1;
		if (scope === "selected" && selection.size === 0) {
			outcome.noSelection = true;
			continue;
		}

		const patches: Array<{ labelId: string; patch: LabelPatch }> = [];
		for (const element of scene) {
			if (!isStickyNote(element) || typeof element.id !== "string") continue;
			if (limitToSelection && !selection.has(element.id)) continue;
			outcome.notes += 1;

			const label = boundLabelOf(element, scene);
			if (!label || typeof label.id !== "string") {
				outcome.noLabel += 1;
				continue;
			}
			if (isEditing(view, label)) {
				outcome.editing += 1;
				continue;
			}
			const patch = labelPatch(label, defaults);
			if (patch) patches.push({ labelId: label.id, patch });
		}

		if (patches.length === 0) continue;
		const ok = await writePatches(app, view, scene, patches);
		if (ok) {
			outcome.changed += patches.length;
			if (options.debug) {
				for (const entry of patches) {
					console.log(
						"[excalidraw-sticky-defaults] 已改写便签",
						entry.labelId,
						entry.patch
					);
				}
			}
		} else {
			outcome.failed += 1;
			if (!acquireAutomate(app, view)) outcome.noAutomate = true;
		}
	}

	return outcome;
}
