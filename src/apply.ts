/**
 * Watches open Excalidraw drawings and rewrites the labels of newly created
 * sticky notes.
 *
 * HOW CHANGES ARE OBSERVED
 * ------------------------
 * ExcalidrawAutomate in the version this plugin targets has no `onChange` hook,
 * and the Excalidraw plugin dispatches no scene-change event, so the scene is
 * polled: one comparison of `getSceneVersion()` per tick, which is a number, and
 * the full scan only runs when that number moves or when a note is still being
 * worked on.
 *
 * WHY A NOTE STAYS "PENDING" UNTIL IT ACTUALLY MATCHES
 * ---------------------------------------------------
 * The first version marked a note as handled *before* writing to it, and it lost
 * this race every time: a freshly created sticky note immediately opens its text
 * editor, and when that editor commits it writes the label back with its own
 * creation-time values (`fontFamily: 1`, `textAlign: "center"`,
 * `verticalAlign: "middle"`). The patch was applied, then overwritten, and the
 * id was already recorded as done -- so new notes silently never took the
 * defaults while the "apply to existing notes" button (which bypasses that
 * bookkeeping) worked fine.
 *
 * So a note is now only retired once its label really matches the defaults.
 * Until then it sits in `pending` and is retried, with a bounded number of
 * attempts and a deadline so a note that simply refuses to match cannot cause
 * writes forever. Verification needs no separate code: the same scan that
 * computes the patch returns `null` once the label matches, which is exactly the
 * signal to retire the note.
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

/** How often the scene version is checked. Cheap enough to feel instant. */
export const TICK_MS = 300;

/** Wait this long after first sighting a note before touching it, so the text
 * editor that opens on creation has appeared and can be detected. */
export const FIRST_WAIT_MS = 350;

/** Minimum gap between two write attempts for the same note. */
export const RETRY_GAP_MS = 600;

/** Give up (and leave the note alone) after this many attempts. */
export const MAX_ATTEMPTS = 6;

/** Hard deadline per note, counted from first sighting. */
export const PENDING_TTL_MS = 20000;

/**
 * How long a note is watched after a successful write.
 *
 * A sticky note's creation-time text editor can commit *after* the first patch
 * lands, writing the label back to `center/middle`. Retiring the note on the
 * first scan that matches would lose that race permanently, so it stays watched
 * for this long and is repatched if it drifts back.
 */
export const VERIFY_MS = 1500;

/** `id` of the Excalidraw plugin in Obsidian's plugin registry. */
const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";

/** The parts of the Excalidraw view this plugin reads. */
interface ExcalidrawViewLike {
	excalidrawAPI?: {
		getSceneElements?: () => unknown;
		getAppState?: () => { editingTextElement?: unknown } | undefined;
	} | null;
	getSceneVersion?: (elements: unknown[]) => number;
	containerEl?: { querySelector?: (selector: string) => unknown };
}

/** The parts of ExcalidrawAutomate this plugin calls. */
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

/** A note this plugin is still trying to make match the defaults. */
interface PendingNote {
	/** Wall-clock deadline, in ms since epoch. */
	deadline: number;
	/** Writes attempted so far. */
	attempts: number;
	/** Earliest time for the next attempt. */
	nextTry: number;
	/** While this is in the future the note stays watched after a write. */
	verifyUntil: number;
}

/** Per-drawing bookkeeping. */
interface ViewState {
	/** Last scene version examined. */
	version: number;
	/** Notes whose label matches the defaults, or which were given up on. */
	seen: Set<string>;
	/** Notes still being worked on. */
	pending: Map<string, PendingNote>;
}

/** Reads the editing state out of whatever `getAppState()` returned. */
function editingIds(state: unknown): { id?: unknown; containerId?: unknown } {
	const editing = (state as { editingTextElement?: unknown } | undefined)
		?.editingTextElement;
	if (!editing || typeof editing !== "object") return {};
	const element = editing as { id?: unknown; containerId?: unknown };
	return { id: element.id, containerId: element.containerId };
}

/** Keeps sticky notes in line with the configured defaults. */
export class StickyNoteFixer {
	private readonly states = new WeakMap<object, ViewState>();

	/** Warned once when ExcalidrawAutomate could not be reached. */
	private warned = false;

	/**
	 * @param app - The Obsidian app.
	 * @param readDefaults - Current settings, read live so a dropdown takes
	 *   effect without restarting the poller.
	 * @param readDebug - Whether to log each fix to the console.
	 */
	constructor(
		private readonly app: App,
		private readonly readDefaults: () => StickyDefaults,
		private readonly readDebug: () => boolean = () => false
	) {}

	/**
	 * One poll: look for sticky notes that do not match the defaults yet.
	 *
	 * Runs on every tick rather than only on scene changes, because a patch that
	 * the text editor then overwrote leaves the scene version settled at a value
	 * that no longer changes -- waiting for another change would never retry it.
	 * The version check is kept only as a cheap idle short-circuit.
	 */
	tick(): void {
		const defaults = this.readDefaults();
		if (isNoop(defaults)) return;

		for (const view of this.views()) {
			const api = view.excalidrawAPI;
			if (!api?.getSceneElements) continue;
			const elements = api.getSceneElements();
			if (!Array.isArray(elements)) continue;

			const version = this.sceneVersion(view, elements);
			let state = this.states.get(view as object);
			if (!state) {
				// First sight of this drawing: everything already there is
				// history. This feature is about new notes, so nothing is written.
				state = {
					version,
					seen: this.noteIds(elements as ElementLike[]),
					pending: new Map(),
				};
				this.states.set(view as object, state);
				continue;
			}
			if (version === state.version && state.pending.size === 0) continue;
			state.version = version;
			void this.reconcile(
				view,
				elements as ElementLike[],
				state,
				defaults,
				false
			);
		}
	}

	/**
	 * Applies the defaults to every sticky note in every open drawing.
	 *
	 * Used by the command of the same name: unlike {@link tick} this ignores the
	 * "new only" rule, but still leaves a note alone while a text editor is open.
	 *
	 * @returns How many labels were rewritten.
	 */
	async applyToExisting(): Promise<number> {
		const defaults = this.readDefaults();
		if (isNoop(defaults)) return 0;

		let changed = 0;
		for (const view of this.views()) {
			const elements = view.excalidrawAPI?.getSceneElements?.();
			if (!Array.isArray(elements)) continue;
			const state = this.states.get(view as object) ?? {
				version: -1,
				seen: new Set<string>(),
				pending: new Map<string, PendingNote>(),
			};
			this.states.set(view as object, state);
			changed += await this.reconcile(
				view,
				elements as ElementLike[],
				state,
				defaults,
				true
			);
		}
		return changed;
	}

	/** Open Excalidraw views, in workspace order. */
	private views(): ExcalidrawViewLike[] {
		const leaves = this.app.workspace.getLeavesOfType("excalidraw");
		const views: ExcalidrawViewLike[] = [];
		for (const leaf of leaves) {
			if (leaf.view) views.push(leaf.view as unknown as ExcalidrawViewLike);
		}
		return views;
	}

	/** Ids of every sticky note in a scene. */
	private noteIds(elements: ElementLike[]): Set<string> {
		const ids = new Set<string>();
		for (const element of elements) {
			if (isStickyNote(element) && typeof element.id === "string") {
				ids.add(element.id);
			}
		}
		return ids;
	}

	/** A cheap change detector for one drawing. */
	private sceneVersion(view: ExcalidrawViewLike, elements: unknown[]): number {
		if (typeof view.getSceneVersion === "function") {
			try {
				return view.getSceneVersion(elements);
			} catch {
				// Fall through to the length, which still catches additions.
			}
		}
		return elements.length;
	}

	/** Retires a note: it matches the defaults, or we have stopped trying. */
	private retire(state: ViewState, noteId: string): void {
		state.seen.add(noteId);
		state.pending.delete(noteId);
	}

	/**
	 * Rewrites the labels that need it.
	 *
	 * @param view - The drawing.
	 * @param elements - Its scene.
	 * @param state - Per-drawing bookkeeping.
	 * @param defaults - What to force.
	 * @param force - Ignore the "already seen" list and the retry delays.
	 * @returns How many labels were rewritten.
	 */
	private async reconcile(
		view: ExcalidrawViewLike,
		elements: ElementLike[],
		state: ViewState,
		defaults: StickyDefaults,
		force: boolean
	): Promise<number> {
		const now = Date.now();
		const patches: Array<{ noteId: string; labelId: string; patch: LabelPatch }> =
			[];
		let gaveUp = 0;

		for (const note of elements) {
			if (!isStickyNote(note) || typeof note.id !== "string") continue;
			if (!force && state.seen.has(note.id)) continue;

			const label = boundLabelOf(note, elements);
			if (!label || typeof label.id !== "string") {
				this.retire(state, note.id);
				continue;
			}

			const patch = labelPatch(label, defaults);
			if (!patch) {
				// Correct right now -- but a note is only retired once its grace
				// window has passed, so a late editor commit cannot undo the fix
				// permanently.
				const pending = state.pending.get(note.id);
				if (pending && pending.verifyUntil > now) continue;
				this.retire(state, note.id);
				continue;
			}

			if (!force) {
				const pending = state.pending.get(note.id);
				if (!pending) {
					// First sight: wait one beat for the creation-time text editor
					// to appear, so {@link isEditing} can see it.
					state.pending.set(note.id, {
						deadline: now + PENDING_TTL_MS,
						attempts: 0,
						nextTry: now + FIRST_WAIT_MS,
						verifyUntil: 0,
					});
					continue;
				}
				if (now < pending.nextTry) continue;
				if (now > pending.deadline || pending.attempts >= MAX_ATTEMPTS) {
					this.retire(state, note.id);
					gaveUp += 1;
					continue;
				}
				if (this.isEditing(view, label)) {
					pending.nextTry = now + RETRY_GAP_MS / 2;
					continue;
				}
				pending.attempts += 1;
				pending.nextTry = now + RETRY_GAP_MS;
			}

			patches.push({ noteId: note.id, labelId: label.id, patch });
		}

		if (gaveUp > 0) {
			console.warn(
				`[excalidraw-sticky-defaults] 有 ${gaveUp} 个便签在 ${MAX_ATTEMPTS} 次尝试后仍未改成默认样式，已跳过。`
			);
		}
		if (patches.length === 0) return 0;

		const ok = await this.write(
			view,
			elements,
			patches.map((entry) => ({ labelId: entry.labelId, patch: entry.patch }))
		);
		if (!ok) return 0;

		// Successful writes open a short grace window before the note is retired.
		for (const entry of patches) {
			const pending = state.pending.get(entry.noteId);
			if (pending) pending.verifyUntil = Date.now() + VERIFY_MS;
		}

		if (this.readDebug()) {
			for (const entry of patches) {
				console.log(
					"[excalidraw-sticky-defaults] 已改写便签",
					entry.noteId,
					entry.patch
				);
			}
		}
		return patches.length;
	}

	/**
	 * Whether a text editor is open, so writing would fight the user.
	 *
	 * Three signals, cheapest first. The `textarea` check is blunt -- it reacts to
	 * *any* open text editor in the view, not just this note's -- but it is the
	 * one that does not depend on an internal appState key, and a false positive
	 * only delays the fix by a tick.
	 *
	 * @param view - The drawing.
	 * @param label - The label about to be written.
	 */
	private isEditing(view: ExcalidrawViewLike, label: ElementLike): boolean {
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
	 * Commits the patches through ExcalidrawAutomate.
	 *
	 * The same route the Excalidraw plugin uses for its own element edits: copy
	 * the scene elements onto a workbench, mutate the copies, then let
	 * `addElementsToView()` merge them back with proper version bumps and
	 * redrawing. `"NEVER"` is passed as the capture action so an automatic,
	 * cosmetic fix does not land on the undo stack.
	 *
	 * @returns True when the elements were committed.
	 */
	private async write(
		view: ExcalidrawViewLike,
		elements: ElementLike[],
		patches: Array<{ labelId: string; patch: LabelPatch }>
	): Promise<boolean> {
		const ea = this.acquireAutomate(view);
		if (!ea) {
			if (!this.warned) {
				this.warned = true;
				console.warn(
					"[excalidraw-sticky-defaults] 取不到 ExcalidrawAutomate，" +
						"便签默认设置未生效。请确认 Excalidraw 插件已启用且是最新版本。"
				);
			}
			return false;
		}

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
			console.error("[excalidraw-sticky-defaults] 写入便签label失败", error);
			return false;
		} finally {
			ea.destroy?.();
		}
	}

	/**
	 * Mints an ExcalidrawAutomate bound to one view.
	 *
	 * `getAPI(view)` is Excalidraw's own factory, so the instance belongs to this
	 * view and cannot disturb `window.ExcalidrawAutomate` or another drawing.
	 */
	private acquireAutomate(view: ExcalidrawViewLike): AutomateLike | null {
		const registry = (this.app as unknown as {
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
}
