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
 * or the button in the settings pane rewrites every sticky note in every open
 * drawing and then *reports what happened* through a notice. Nothing runs in the
 * background, nothing is silent.
 *
 * A note whose text editor is open at that moment is skipped and counted, so the
 * notice can say why it was not changed instead of looking broken.
 */

import type { App } from "obsidian";
import {
	boundLabelOf,
	isNoop,
	isStickyNote,
	labelPatch,
	type ElementLike,
	type LabelPatch,
	type StickyDefaults,
} from "./defaults";

/** `id` of the Excalidraw plugin in Obsidian's plugin registry. */
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

/** What one run of {@link applyStickyDefaults} did. */
export interface ApplyOutcome {
	/** Sticky notes found across every open drawing. */
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
}

/** The parts of the Excalidraw view this module reads. */
interface ExcalidrawViewLike {
	excalidrawAPI?: {
		getSceneElements?: () => unknown;
		getAppState?: () => { editingTextElement?: unknown } | undefined;
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
 * Rewrites every sticky note in every open Excalidraw drawing.
 *
 * Idempotent: labels that already match produce no patch and no write, so a
 * second click is harmless.
 *
 * @param app - The Obsidian app.
 * @param defaults - What to force; `null` fields are left alone.
 * @param debug - Log each rewritten label.
 * @returns What happened, for the caller to report.
 */
export async function applyStickyDefaults(
	app: App,
	defaults: StickyDefaults,
	debug = false
): Promise<ApplyOutcome> {
	const outcome: ApplyOutcome = {
		notes: 0,
		changed: 0,
		editing: 0,
		noLabel: 0,
		failed: 0,
		noAutomate: false,
	};
	if (isNoop(defaults)) return outcome;

	for (const leaf of app.workspace.getLeavesOfType("excalidraw")) {
		const view = leaf.view as unknown as ExcalidrawViewLike | undefined;
		const elements = view?.excalidrawAPI?.getSceneElements?.();
		if (!view || !Array.isArray(elements)) continue;

		const patches: Array<{ labelId: string; patch: LabelPatch }> = [];
		for (const element of elements as ElementLike[]) {
			if (!isStickyNote(element)) continue;
			outcome.notes += 1;

			const label = boundLabelOf(element, elements as ElementLike[]);
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
		const ok = await writePatches(app, view, elements as ElementLike[], patches);
		if (ok) {
			outcome.changed += patches.length;
			if (debug) {
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
