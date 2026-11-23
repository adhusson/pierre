import type { CodeViewLocalManagerContext } from '../components/CodeView';

const SVG_NS = "http://www.w3.org/2000/svg";
const RULER_WIDTH = 16, RULER_GAP = 0;  // the track's width, and the space between the track and the scroll box's right edge (0: the page hides the native scrollbar, style.css)
// The ruler has two bands. Left of the track, in the 15 px between the files and the track (pr-watch's layout; the track's overflow is visible): the marks of
// the changes, from CHANGE_X, CHANGE_W px wide, and of the matches over them, MATCH_W px wide from CHANGE_X. In the track: the thread marks, from THREAD_X, THREAD_W px wide, then the thumb (THUMB_W px
// at the right edge). So a thread's mark is beside the thumb.
// A thread's mark is a bar of FLAT_H px at its line's place while its card is not in the view. While its card is in the view the mark is a box: the card's part
// of the view at the thumb's scale, beside the thumb's part for it (update), when BOX_MIN px or more of it show. One sign for a thread: the bar opens into the
// box. A draft's mark: a pencil in a square of DRAFT_SIZE px, at the middle of the band. The thumb's hit area starts at THUMB_X, over the change marks
const CHANGE_X = -14, CHANGE_W = 13, MATCH_W = 8, THREAD_X = 2, THREAD_W = 9, FLAT_H = 3, BOX_MIN = FLAT_H, DRAFT_SIZE = 9, THUMB_X = -13;  // BOX_MIN: the smallest box is as high as a bar
// The thumb (the part in view) is a bar of THUMB_W px at the track's right edge. Its length is constant: the view's height at the track's scale, which is the length of a
// view that holds only code rows (a length that followed the wraps and the thread cards in the view drew the eye). The thumb has one colour: the view's cards
// show beside it, as the boxes of their thread marks (it was a picture of the view: a part for each card, and a paler colour for wrapped lines). The thumb's top is at the track place of the view's first row. A card or a wrap has no height on
// the track: the thumb's end is lower than the view's last row by the length
// of them all. Near the diff's end that length does not fit in the track after the first row's place: the track's end cuts the thumb there (thumbSpan), THUMB_MIN px
// at least. The thread marks have the rest of the track, MARK_W. The thumb's hit area (grab) is
// the track's whole width and reaches THUMB_X at the left, over the change marks: a press on it starts a drag, as a press on the bar
const THUMB_W = 3, MARK_W = RULER_WIDTH - THUMB_W, THUMB_MIN = 12;
// While the pointer is on the thumb's hit area for 150 ms, and at once during a drag, a wide bar shows over the whole hit area (halo: the band of the change marks and the
// track, half transparent, with a border and square corners): it fades in fast and shows that the thumb can be dragged. The thin bar does not change

interface RulerSlice {
	yStart: number;
	yEnd: number;
}

// A mark as drawn on the track (x to xEnd, y to end, on layer: 0 a change, 1 a match, 2 a thread, in the order of the paths; the x of a change or of a match is left of the track, so negative) and the
// rows it stands for in baseline row space (estTop, estEnd): a click on it goes to its rows
interface RulerMark {
	layer: number;
	x: number;
	xEnd: number;
	y: number;
	end: number;
	estTop: number;
	estEnd: number;
}

export class OverviewRuler<LAnnotation, Caret> {
	dirty = true;
	styleEl: HTMLStyleElement | undefined;
	host: HTMLDivElement | undefined;
	track: SVGSVGElement | undefined;
	paths: SVGPathElement[] | undefined;
	thumb: SVGRectElement | undefined;  // the thumb's place and length; it has no paint
	view: SVGGElement | undefined;  // the thumb's paint: one rect
	viewKey = "";  // the thumb's span and the boxes, as drawn
	annotationFill = "";  // the colour of the thread marks: the bars and the boxes
	boxes: SVGGElement | undefined;  // the boxes of the threads whose card is in the view, one rect each (update)
	flats: { key: string; cy: number }[] = [];  // the threads' bars (not the drafts' pencils), from the last layout. key: the item's id and the mark's baseline top
	flatsKey: string | undefined;  // the threads that have a box, and so no bar, as drawn (undefined: the bars are to draw)
	places = new Map<string, number>();  // each thread mark's place on the track (the middle of its bar), the drafts' too, by key: an annotation row of one of them is a thread's card, and its box starts there
	estView: [number, number] = [0, 0];  // the view's start and end in baseline row space, at the last update
	grab: SVGRectElement | undefined;  // the thumb's hit area
	halo: SVGRectElement | undefined;  // the wider bar that shows while the pointer is on the hit area
	swap = false;  // a click on the track moved the view: at the next draw of the thumb the ghost goes, and the thumb's wide bar shows at once (update)
	ghost: SVGRectElement | undefined;  // where the thumb will be after a click at the pointer's place: it shows while the pointer is on the track, off the thumb (showGhost)
	viewer: CodeViewLocalManagerContext<LAnnotation, Caret> | undefined;
	drag: { pointerId: number; startY: number; startScrollTop: number; ratio: number } | undefined;  // a drag of the thumb: the pointer's and the scroll's start, and the scroll per pointer px
	thumbPress = false;  // the last press was on the thumb: its click scrolls only to a thread mark, or to a place that is not in the view
	thumbScrollY = 0;  // the thumb's top for the scroll position alone (the thumb starts higher while context rows stick at the top), for checks
	thumbLength = 0;  // the thumb's whole length (update). The drawn thumb is shorter only where the track's end cuts it (thumbSpan)
	marks: RulerMark[] = [];  // the change and thread marks
	matchMarks: RulerMark[] = [];  // the search's marks
	height = 0;
	estExtent = 0;
	loading: string | undefined;
	searchVersion: number | undefined;
	marginRight = "";
	overflowY = "";

	invalidate() {
		this.dirty = true;
	}

	setup(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		this.viewer = viewer;
		const root = viewer.root!;
		const styleEl = this.styleEl = document.createElement("style");
		styleEl.dataset.overviewRulerStyle = "";
		styleEl.textContent = `
			@supports not selector(::-webkit-scrollbar){[data-overview-scrollbar]{scrollbar-width:thin}}
			[data-overview-scrollbar]::-webkit-scrollbar{width:7px;height:7px}
			[data-overview-scrollbar]::-webkit-scrollbar-track{background:var(--diffs-overview-bg,#f6f8fa);border-left:1px solid #00000014}
			[data-overview-scrollbar]::-webkit-scrollbar-thumb{background:rgba(31,35,40,.28);border-radius:3.5px}
			[data-overview-scrollbar]::-webkit-scrollbar-thumb:hover{background:rgba(31,35,40,.45)}
			[data-overview-scrollbar]::-webkit-scrollbar-button{display:none}
			[data-ruler-grab]{cursor:grab}
			[data-ruler-halo]{opacity:0;fill:var(--diffs-overview-halo,#f59e0b40);stroke:var(--diffs-overview-halo-border,#d97706b3);stroke-width:1;transition:opacity 80ms}
			[data-ruler-grab]:hover+[data-ruler-halo],[data-ruler-dragging] [data-ruler-halo]{opacity:1;transition-delay:150ms}
			[data-ruler-dragging] [data-ruler-halo]{transition-delay:0s}
			[data-ruler-dragging],[data-ruler-dragging] [data-ruler-grab]{cursor:grabbing}
			[data-ruler-ghost]{display:none;fill:var(--diffs-overview-ghost,#1f232812);stroke:var(--diffs-overview-ghost-border,#1f232866);stroke-width:1}
			[data-ruler-now] [data-ruler-halo]{opacity:1;transition:none}
		`;
		const host = this.host = document.createElement("div");
		host.dataset.overviewRuler = "";
		host.style.cssText = "position:sticky;top:0;height:0;z-index:5;pointer-events:none";
		const track = this.track = document.createElementNS(SVG_NS, "svg");
		track.setAttribute("preserveAspectRatio", "none");
		track.style.cssText = `position:absolute;top:0;right:${RULER_GAP}px;width:${RULER_WIDTH}px;overflow:visible;background:var(--diffs-overview-bg,#f6f8fa);border-left:1px solid #00000014;pointer-events:auto;user-select:none;touch-action:none`;
		// The band left of the track takes the pointer over its whole height: a click there between two marks counts too (onClick)
		const strip = document.createElementNS(SVG_NS, "rect");
		strip.setAttribute("x", `${THUMB_X - 2}`);
		strip.setAttribute("width", `${2 - THUMB_X}`);
		strip.setAttribute("height", "100%");
		strip.setAttribute("fill", "transparent");
		strip.style.pointerEvents = "all";
		track.append(strip);
		this.paths = ["deletions", "additions", "separators", "matches", "threads", "drafts"].map(() => {
			const path = document.createElementNS(SVG_NS, "path");
			track.append(path);
			return path;
		});
		// the boxes are under the bars and the pencils: the bar of a thread on a later line shows on a box
		const boxes = this.boxes = document.createElementNS(SVG_NS, "g");
		boxes.dataset.rulerBoxes = "";
		boxes.style.pointerEvents = "none";
		track.insertBefore(boxes, this.paths[4]);
		const grab = this.grab = document.createElementNS(SVG_NS, "rect");
		grab.dataset.rulerGrab = "";
		grab.setAttribute("x", `${THUMB_X}`);
		grab.setAttribute("width", `${RULER_WIDTH - THUMB_X}`);
		grab.setAttribute("fill", "transparent");
		grab.style.pointerEvents = "all";
		const halo = this.halo = document.createElementNS(SVG_NS, "rect");
		halo.dataset.rulerHalo = "";
		halo.setAttribute("x", `${THUMB_X + 0.5}`);
		halo.setAttribute("width", `${RULER_WIDTH - THUMB_X - 1}`);
		const thumb = this.thumb = document.createElementNS(SVG_NS, "rect");
		thumb.dataset.rulerThumb = "";
		thumb.setAttribute("x", `${MARK_W}`);
		thumb.setAttribute("width", `${THUMB_W}`);
		thumb.setAttribute("fill", "none");
		const view = this.view = document.createElementNS(SVG_NS, "g");
		view.dataset.rulerView = "";
		const ghost = this.ghost = document.createElementNS(SVG_NS, "rect");
		ghost.dataset.rulerGhost = "";
		ghost.setAttribute("x", `${THUMB_X + 0.5}`);
		ghost.setAttribute("width", `${RULER_WIDTH - THUMB_X - 1}`);
		halo.style.pointerEvents = ghost.style.pointerEvents = thumb.style.pointerEvents = view.style.pointerEvents = "none";  // the pointer is always on grab, under them
		track.append(grab, halo, ghost, thumb, view);
		track.addEventListener("pointerdown", this.onPointerDown);
		track.addEventListener("pointermove", this.onPointerMove);
		track.addEventListener("pointerup", this.onPointerUp);
		track.addEventListener("pointercancel", this.onPointerUp);
		track.addEventListener("click", this.onClick);
		track.addEventListener("pointerleave", this.onPointerLeave);
		host.append(track);
		this.overflowY = root.style.overflowY;
		root.style.overflowY = "scroll";
		root.dataset.overviewScrollbar = "";
		if (viewer.container) {
			this.marginRight = viewer.container.style.marginRight;
			viewer.container.style.marginRight = `${RULER_WIDTH + RULER_GAP}px`;
		}
		root.prepend(styleEl, host);
	}

	// A press on the thumb starts a drag: the track captures the pointer, and preventDefault keeps the press from selecting text.
	private dragged = false;  // the pointer moved since the press on the thumb: a drag, not a click
	private onPointerDown = (ev: PointerEvent) => {
		this.thumbPress = ev.target === this.grab;
		this.dragged = false;
		if (!this.thumbPress || ev.button !== 0 || !this.track || !this.viewer) return;
		ev.preventDefault();
		const viewer = this.viewer, y = ev.clientY - this.track.getBoundingClientRect().top;
		this.drag = { pointerId: ev.pointerId, startY: y, startScrollTop: viewer.getScrollTop(), ratio: viewer.getScrollHeight() / Math.max(1, this.height) };
		this.track.setPointerCapture(ev.pointerId);
		this.track.dataset.rulerDragging = "";
		this.showGhost(undefined);
	};

	// During a drag, the scroll follows the pointer as with a scrollbar's thumb: each move adds the pointer's travel times the scroll height over
	// the track's height to root.scrollTop (a scrollbar's ratio: this thumb can fill the track, so its free length cannot give one; a difference, so
	// CodeView's paged scroll, its rebase of very tall views, keeps its offset). The
	// drag is continuous also across a tall thread or a wrap, which has one baseline place: the thumb pauses on it while the pointer goes on,
	// as when the wheel scrolls through it (before, the pointer's baseline place gave the scroll, and the drag jumped over the thread). The
	// next render draws the thumb from the new scrollTop.
	// ponytail: getScrollTop() reads root.scrollTop again only after a scroll event. Chrome sends one pointermove per frame, before the
	// frame's scroll event. A browser that sends two moves before that event scrolls too far at the second move, and the next move
	// corrects it. If that shows, write once per frame (requestAnimationFrame).
	private onPointerMove = (ev: PointerEvent) => {
		this.showGhost(ev);
		const viewer = this.viewer, drag = this.drag;
		if (!viewer?.root || !drag || ev.pointerId !== drag.pointerId || this.height <= 0 || viewer.items.length === 0) return;
		const travel = ev.clientY - this.track!.getBoundingClientRect().top - drag.startY;
		if (Math.abs(travel) > 3) this.dragged = true;
		const scrollTop = drag.startScrollTop + travel * drag.ratio;
		viewer.root.scrollTop += scrollTop - viewer.getScrollTop();
	};

	// A measured place of the scroll area (a scroll position) in baseline row space, where the track draws it: as mapY of update
	private toEst(offset: number, entries: { record: CodeViewLocalManagerContext<LAnnotation, Caret>["items"][number]; measTop: number; measHeight: number; estTop: number; estHeight: number }[], y: number): number {
		if (y <= offset) return Math.max(0, y);
		for (const e of entries) {
			if (y <= e.measTop) return e.estTop - (e.measTop - y);
			if (y <= e.measTop + e.measHeight) return e.estTop + (e.record.type === "diff" ? e.record.instance.mapMeasuredToEstimated(y - e.measTop) : y - e.measTop);
		}
		const last = entries.at(-1)!;
		return last.estTop + last.estHeight + (y - (last.measTop + last.measHeight));
	}

	// The thumb's top and drawn length for a view whose first row is at est (baseline row space): the top at that row's place on the track, and the whole length
	// (thumbLength), which the track's end cuts. With a card or wraps in the view, the view holds less rows than the whole length stands for, so near the diff's
	// end the whole length does not fit after the first row's place. A thumb moved up to fit covered the marks of rows above the view: it said that a thread
	// above the view's top was in view. Only the last THUMB_MIN px of the track move the top up, so that a thumb is left
	private thumbSpan(est: number, estScrollHeight: number): [y: number, length: number] {
		const y = Math.max(0, Math.min(this.height - THUMB_MIN, Math.round(est * this.height / estScrollHeight)));
		return [y, Math.min(this.thumbLength, this.height - y)];
	}

	// The ghost of the thumb: where the thumb will be after a click at the pointer's place. It takes the click's own steps (onClick): the row at that height of the
	// track (in the thread band: the row of the thread mark that the click takes, the nearest one, 8 px away at most), its measured place, the scroll position that puts it
	// at the middle of the view (a folded file: at the top), and that position's place on the track, as update gives the thumb. It shows while the mouse is on the
	// track and not on the thumb (a press there drags), and not while the thumb is dragged. ev undefined: it hides
	private showGhost(ev: PointerEvent | undefined) {
		const { ghost, thumb, track, viewer } = this;
		if (!ghost || !thumb || !track) return;
		if (!ev || ev.target !== this.grab) delete track.dataset.rulerNow;  // the pointer left the thumb: its wide bar waits 150 ms again
		if (this.swap && ev) return;  // between a click and the thumb's draw: the ghost stays where the click was
		const length = this.thumbLength;
		if (!ev || !viewer || this.drag || ev.target === this.grab || ev.pointerType !== "mouse" || length <= 0 || length >= this.height || viewer.items.length === 0) {
			ghost.style.display = "none";
			return;
		}
		const rect = track.getBoundingClientRect(), x = RULER_WIDTH - (rect.right - ev.clientX);
		let y = ev.clientY - rect.top;
		if (x >= 0 && x < MARK_W) {  // the thread band
			const near = (m: RulerMark) => Math.abs((m.y + m.end) / 2 - y);
			const mark = this.marks.filter(m => m.layer === 2 && near(m) <= 8).sort((a, b) => near(a) - near(b))[0];
			if (mark) y = (mark.y + mark.end) / 2;
		}
		const { offset, entries, estScrollHeight } = this.layout(viewer, this.height), est = y * estScrollHeight / this.height;
		let entry = entries[0];
		for (const e of entries) {
			if (e.estTop <= est) entry = e;
			else break;
		}
		const local = Math.max(0, Math.min(entry.estHeight, est - entry.estTop)), { record } = entry, height = viewer.getHeight();
		const place = record.type !== "diff" ? entry.measTop + local - height / 2 : record.item.collapsed ? entry.measTop : entry.measTop + record.instance.mapEstimatedToMeasured(local) - height / 2;
		const scrollTop = Math.max(0, Math.min(viewer.getScrollHeight() - height, place));
		const [top, cut] = this.thumbSpan(this.toEst(offset, entries, scrollTop), estScrollHeight);
		ghost.setAttribute("y", `${top + 0.5}`);
		ghost.setAttribute("height", `${Math.max(1, cut - 1)}`);
		ghost.style.display = "block";
	}

	private onPointerLeave = () => this.showGhost(undefined);

	private onPointerUp = (ev: PointerEvent) => {
		if (ev.pointerId !== this.drag?.pointerId) return;
		this.drag = undefined;
		if (this.track) delete this.track.dataset.rulerDragging;
	};

	// A click on the track scrolls to what the track shows at that height. The click's height gives a place in baseline row space,
	// as the marks use it; the line of the row there goes to the middle of the view (a line target: CodeView follows it while the
	// rows on the way are measured). A mark is drawn at least 2 px tall (a thread: a bar of FLAT_H px), so in a long diff it covers more rows than its own: a
	// click on it goes to its own rows. Each kind of mark has its own band of x (a change: the band left of the track, a match: that band's left
	// edge, a thread: the track, left of the thumb). Left of the track, only the marks drawn under the click count, and of those the one drawn on top (a match over a change),
	// else the one whose rows are nearest. A diff item without rows goes to its start; a file item has no baseline space of its own.
	private onClick = (ev: MouseEvent) => {
		const viewer = this.viewer;
		if (!viewer || this.thumbPress && this.dragged || ev.button !== 0 || this.height <= 0 || viewer.items.length === 0) return;
		const rect = (ev.currentTarget as Element).getBoundingClientRect(), y = ev.clientY - rect.top;  // not offsetX/Y: over a mark, Firefox measures them from the mark
		const x = RULER_WIDTH - (rect.right - ev.clientX);  // from the right edge: the box is 1 px wider than the drawing (its left border). A change mark's x is negative
		const { entries, estScrollHeight } = this.layout(viewer, this.height);
		let est = y * estScrollHeight / this.height;
		const gap = (m: RulerMark) => Math.max(0, m.estTop - est, est - (m.estEnd - 1));
		// In the thread band (the track, left of the thumb) are only the thread marks, and each is small: the click takes the nearest one, 8 px above or under it at most. A press on the
		// thumb that did not drag is a click too: for a thread mark under it (the thumb's hit area covers the marks of the threads in view), and for a place that is not in the view
		const near = (m: RulerMark) => Math.abs((m.y + m.end) / 2 - y);
		const threads = x >= 0 && x < MARK_W, hit = threads
			? this.marks.filter(m => m.layer === 2 && near(m) <= 8).sort((a, b) => near(a) - near(b))[0]
			: [...this.marks, ...this.matchMarks].filter(m => m.x <= x && x < m.xEnd && m.y <= y && y < m.end).sort((a, b) => b.layer - a.layer || gap(a) - gap(b))[0];
		if (hit) est = Math.min(Math.max(est, hit.estTop), hit.estEnd - 1);
		// A press on the thumb moves nothing when its place is in the view. It goes to a place that is not: the thumb has the length of a whole view of code rows, so with
		// a card or a wrap in the view it covers rows after the view's last one, and it can fill the track
		if (this.thumbPress && !(hit && threads) && est >= this.estView[0] && est <= this.estView[1]) return;
		this.swap = this.ghost?.style.display === "block";  // the ghost stays until the thumb is drawn at its new place (update): no moment with neither
		let entry = entries[0];
		for (const e of entries) {
			if (e.estTop <= est) entry = e;
			else break;
		}
		const local = Math.max(0, Math.min(entry.estHeight, est - entry.estTop)), { record } = entry, id = record.item.id;
		if (record.type !== "diff") viewer.scrollTo({ type: "position", position: entry.measTop + local - viewer.getHeight() / 2 });
		else {
			const line = record.item.collapsed ? undefined : record.instance.getOverviewRulerLine(local);
			viewer.scrollTo(line ? { type: "line", id, lineNumber: line.lineNumber, side: line.side, align: "center" } : { type: "item", id, align: "start" });
		}
	};

	// Each item's place in the measured layout (measTop, measHeight) and in baseline row space (estTop, estHeight), where a line is one
	// line high and a wrap or a thread card adds nothing; and the baseline height of the whole scroll area, which the track's height stands for.
	private layout(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>, trackHeight: number) {
		const offset = viewer.getItemTopOffset(), layoutCfg = viewer.getLayout();
		let estCursor = offset;
		const entries = viewer.items.map((record, i) => {
			const measTop = offset + record.top, measHeight = record.height;
			const estTop = estCursor;
			const estHeight = record.type === "diff" ? record.instance.getEstimatedHeight() : record.height;
			estCursor += estHeight + (i < viewer.items.length - 1 ? layoutCfg.gap : 0);
			return { record, measTop, measHeight, estTop, estHeight };
		});
		return { offset, entries, estScrollHeight: Math.max(estCursor + layoutCfg.paddingBottom, trackHeight) };
	}

	sync(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		if (!viewer.root || !viewer.options.overviewRuler) {
			this.cleanUp();
			return;
		}
		if (!this.host) this.setup(viewer);
	}

	update(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>, search?: { version: number; keys(id: string): ReadonlySet<string> | undefined }, sticky?: { pinnedRowsTop(scrollTop: number): number | undefined }) {
		this.sync(viewer);
		if (!this.host) return;
		this.viewer = viewer;  // the context of this render: a click reads its items, and CodeView can replace the items array after setup
		const root = viewer.root!, trackHeight = root.clientHeight, height = viewer.getHeight(), extent = viewer.getScrollHeight();
		if (this.dirty || trackHeight !== this.height) {
			this.dirty = true;
			this.height = trackHeight;
		}
		if (height <= 0 || extent <= 0 || trackHeight <= 0 || viewer.items.length === 0) {
			this.clear();
			return;
		}
		const { offset, entries, estScrollHeight } = this.layout(viewer, trackHeight);
		const slices: RulerSlice[] = entries.map((e, i) => {
			const yStart = i === 0 ? 0 : Math.min(trackHeight - 1, Math.floor(e.estTop * trackHeight / estScrollHeight));
			const yEnd = i < entries.length - 1
				? Math.min(trackHeight, Math.floor(entries[i + 1].estTop * trackHeight / estScrollHeight))
				: trackHeight;
			return { yStart, yEnd: Math.max(yStart + 1, yEnd) };
		});
		const loading = viewer.items.filter(record => record.type === "diff" && record.instance.loadingFiles).map(record => record.item.id).join("\n");
		const layout = this.dirty || estScrollHeight !== this.estExtent || loading !== this.loading;
		const matches = search != null && search.version !== this.searchVersion;
		const span = (top: number, h: number, minH = 2, minY = 0, maxY = trackHeight): [number, number] => {
			const limitEnd = Math.max(minY + minH, maxY);
			const y = Math.max(minY, Math.min(limitEnd - minH, Math.floor(top * trackHeight / estScrollHeight)));
			return [y, Math.min(limitEnd, Math.max(y + minH, Math.ceil((top + h) * trackHeight / estScrollHeight)))];
		};
		const files = entries.map((e, i) => ({ ...e, slice: slices[i], index: i })).filter((e): e is typeof e & { record: Extract<typeof e.record, { type: "diff" }> } =>
			e.record.type === "diff" && !e.record.item.collapsed && !e.record.instance.loadingFiles
		);
		if (layout) {
			this.track!.style.height = `${trackHeight}px`;
			this.track!.setAttribute("viewBox", `0 0 ${RULER_WIDTH} ${trackHeight}`);
			this.estExtent = estScrollHeight;
			this.loading = loading;
			const dividers = new Set<number>();
			let separatorPath = "", lastDivY = -3;
			for (let i = 1; i < slices.length; i++) {
				const divY = slices[i].yStart;
				if (divY - lastDivY < 3) continue;
				lastDivY = divY;
				dividers.add(i);
				separatorPath += `M${CHANGE_X} ${divY}h${MARK_W - CHANGE_X}v1h-${MARK_W - CHANGE_X}z`;  // across the two bands
			}
			const fileBounds = (index: number, slice: RulerSlice): [number, number] => {
				const tall = slice.yEnd - slice.yStart >= 6;
				const minY = tall && dividers.has(index) ? slice.yStart + 1 : slice.yStart;
				const maxY = tall && dividers.has(index + 1) ? slice.yEnd - 1 : slice.yEnd;
				return [minY, maxY];
			};
			const bands: [number, number][][] = [[], []], marks: RulerMark[] = [];
			for (const { record, estTop: fileTop, slice, index } of files) {
				const [minY, maxY] = fileBounds(index, slice);
				for (const region of record.instance.getOverviewRulerRegions() ?? []) {
					const side = region.side === "deletions" ? 0 : 1;
					const [y, end] = span(fileTop + region.top, region.height, 2, minY, maxY);
					marks.push({ layer: 0, x: CHANGE_X, xEnd: CHANGE_X + CHANGE_W, y, end, estTop: fileTop + region.top, estEnd: fileTop + region.top + region.height });
					const previous = bands[side].at(-1);
					if (previous && y <= previous[1]) previous[1] = Math.max(previous[1], end);
					else bands[side].push([y, end]);
				}
			}
			const edges = bands.flatMap((bands, side) => bands.flatMap(([top, bottom]) => [{ y: top, side, change: 1 }, { y: bottom, side, change: -1 }])).sort((a, b) => a.y - b.y);
			const active = [0, 0], paths = ["", ""];
			let top = 0;
			const half = CHANGE_W / 2;
			for (const edge of edges) {
				if (edge.y > top) for (let side = 0; side < 2; side++) {
					if (!active[side]) continue;
					const width = active[1 - side] ? half : CHANGE_W, x = CHANGE_X + (active[1 - side] ? side * half : 0);
					paths[side] += `M${x} ${top}h${width}v${edge.y - top}h-${width}z`;
				}
				active[edge.side] += edge.change;
				top = edge.y;
			}
			this.paths![0].setAttribute("d", paths[0]);
			this.paths![1].setAttribute("d", paths[1]);
			this.paths![2].setAttribute("d", separatorPath);
			let draftPath = "";
			const flats: { key: string; cy: number }[] = [], places = new Map<string, number>();
			for (const { record, estTop: fileTop, slice, index } of files) {
				const [minY, maxY] = fileBounds(index, slice);
				for (const mark of record.instance.getOverviewRulerThreads(viewer.options.getAnnotationRulerState)) {
					const [y, end] = span(fileTop + mark.top, mark.height, 4, minY, maxY);
					// the mark at the middle of its rows: a bar across the thread band, or a draft's pencil (it points down and left: its body, then its tip, 1 px apart, on a grid of 11 units; `at` gives a grid point's place)
					const draft = mark.state === "draft", half = draft ? DRAFT_SIZE / 2 : FLAT_H / 2, u = DRAFT_SIZE / 11, cx = THREAD_X + THREAD_W / 2, cy = Math.min(Math.max((y + end) / 2, half), trackHeight - half);
					const at = (px: number, qy: number) => `${+(cx - half + px * u).toFixed(2)} ${+(cy - half + qy * u).toFixed(2)}`;
					marks.push({ layer: 2, x: THREAD_X - 1, xEnd: THREAD_X + THREAD_W + 1, y: Math.floor(cy - half - 1), end: Math.ceil(cy + half + 1), estTop: fileTop + mark.top, estEnd: fileTop + mark.top + mark.height });
					const key = `${record.item.id}\n${mark.top}`;
					places.set(key, cy);
					if (draft) draftPath += `M${at(8, 0)}L${at(11, 3)}L${at(5, 9)}L${at(2, 6)}zM${at(0, 11)}L${at(1.3, 7.1)}L${at(3.9, 9.7)}z`;
					else flats.push({ key, cy });
				}
			}
			this.marks = marks;
			this.flats = flats;
			this.places = places;
			this.flatsKey = undefined;  // the bars are drawn below, with the view's cards: a thread with a box has no bar
			this.paths![5].setAttribute("d", draftPath);
			const element = files.find(({ record }) => record.element)?.record.element;
			const style = getComputedStyle(root), theme = element ? getComputedStyle(element) : style;
			this.track!.style.colorScheme = theme.colorScheme;
			this.paths![0].style.fill = style.getPropertyValue("--diffs-overview-deletion") || theme.getPropertyValue("--diffs-bg-deletion") || "#ffebe9";
			this.paths![1].style.fill = style.getPropertyValue("--diffs-overview-addition") || theme.getPropertyValue("--diffs-bg-addition") || "#dafbe1";
			this.paths![2].style.fill = style.getPropertyValue("--diffs-overview-separator") || "#0000001f";
			this.paths![3].style.fill = style.getPropertyValue("--diffs-overview-match") || "#ffd33d";
			this.paths![4].style.fill = style.getPropertyValue("--diffs-overview-thread") || "#57606a";
			this.paths![5].style.fill = style.getPropertyValue("--diffs-overview-draft") || "#57606a";
			this.view!.style.fill = style.getPropertyValue("--diffs-overview-viewport") || "#80808024";
			this.annotationFill = (style.getPropertyValue("--diffs-overview-thread") || "#57606a").trim();
			this.dirty = false;
		}
		if (layout || matches) {
			this.searchVersion = search?.version;
			const matchMarks: RulerMark[] = [];
			this.paths![3].setAttribute("d", search ? files.flatMap(({ record, estTop: fileTop }) => {
				const keys = search.keys(record.item.id);
				return keys?.size ? record.instance.getOverviewRulerMarks(keys).map(mark => {
					const [y, end] = span(fileTop + mark.top, mark.height);
					matchMarks.push({ layer: 1, x: CHANGE_X, xEnd: CHANGE_X + MATCH_W, y, end, estTop: fileTop + mark.top, estEnd: fileTop + mark.top + mark.height });
					return `M${CHANGE_X} ${y}h${MATCH_W}v${end - y}h-${MATCH_W}z`;
				}) : [];
			}).join("") : "");
			this.matchMarks = matchMarks;
			// While a search shows its marks, the changes are dimmed: the yellow marks stand out on them
			this.paths![0].style.opacity = this.paths![1].style.opacity = matchMarks.length ? "0.35" : "";
		}
		const scrollTop = viewer.getScrollTop();
		const mapY = (y: number): number => {
			if (y <= offset) return Math.max(0, y);
			for (let i = 0; i < entries.length; i++) {
				const e = entries[i];
				if (y <= e.measTop) return e.estTop - (e.measTop - y);
				if (y <= e.measTop + e.measHeight) {
					const localY = y - e.measTop;
					return e.estTop + (e.record.type === "diff" ? e.record.instance.mapMeasuredToEstimated(localY) : localY);
				}
			}
			const last = entries.at(-1)!;
			return last.estTop + last.estHeight + (y - (last.measTop + last.measHeight));
		};
		// The thumb starts at the context rows that stick at the top while the view is in a card (they show, with the card's line), else at the view's top
		const pinnedTop = sticky?.pinnedRowsTop(scrollTop), estScroll = mapY(scrollTop), estStart = pinnedTop == null ? estScroll : Math.min(estScroll, mapY(pinnedTop)), estEnd = mapY(scrollTop + height);
		// The thumb's whole length: the view's height at the track's scale, the same at every scroll position. Its top is at the place of the view's first row, and
		// the track's end cuts it (thumbSpan)
		this.thumbLength = extent <= height ? trackHeight : Math.min(trackHeight, Math.max(THUMB_MIN, Math.round(height * trackHeight / estScrollHeight)));
		const [thumbY, thumbHeight] = extent <= height ? [0, trackHeight] : this.thumbSpan(estStart, estScrollHeight);
		this.thumbScrollY = extent <= height ? 0 : Math.min(trackHeight, Math.max(0, Math.round(estScroll * trackHeight / estScrollHeight)));
		for (const bar of [this.thumb!, this.grab!, this.halo!]) {
			bar.setAttribute("y", `${thumbY}`);
			bar.setAttribute("height", `${thumbHeight}`);
		}
		if (this.swap) {  // the first draw after a click on the track: the thumb is under the pointer now. The ghost goes, and the thumb's wide bar is there at once
			this.swap = false;
			if (this.ghost) this.ghost.style.display = "none";
			if (this.track) this.track.dataset.rulerNow = "";
		}
		this.estView = [estStart, estEnd];
		// The view at the thumb's scale (at): from the thumb's top (after the rows that stick there), a place of the view is at its distance from the view's top
		// times the thumb's length over the view's height. A box takes its length from it
		const thumbEnd = thumbY + thumbHeight, perPx = thumbHeight / height, pictureTop = thumbY + (estScroll - estStart) * perPx;
		const at = (y: number) => Math.min(thumbEnd, Math.max(thumbY, pictureTop + (y - scrollTop) * perPx));
		// A thread's card in the view (the annotation rows of a thread mark) has a box in the thread band, when BOX_MIN px or more of it show: the thread's bar
		// opens into the box, and the bar is not drawn then. A box starts at its own bar's place and is as long as the card's part of the view at the thumb's
		// scale: it grows and shrinks from the bar, and no mark changes place. The boxes of two cards on near lines overlap (the fill is pale, so the overlap shows).
		// A box has a darker part from its top: the share of the card that is above the view (read). While the view goes through a card, the thumb does not move
		// (a card has no height on the track), and in a card taller than the view the box keeps its length: the darker part is then the thing that follows the scroll.
		// under: for the first card of the view, its rows that are under the context rows stuck at the view's top. While the scroll goes through those rows they
		// stay, and the card moves up under them: the scroll's place is then after the thumb's start by that height (estScroll - estStart, 1:1 for code rows)
		const boxes: [y: number, end: number, read: number][] = [], open = new Set<string>();
		let under = Math.max(0, estScroll - estStart);
		if (extent > height) for (const e of entries) {
			if (e.measTop >= scrollTop + height) break;
			if (e.record.type !== "diff" || e.measTop + e.measHeight <= scrollTop) continue;
			for (const part of e.record.instance.getOverviewExtras(scrollTop - e.measTop, scrollTop + height - e.measTop)) {
				if (part.row == null) continue;
				const key = `${e.record.item.id}\n${part.row}`, place = this.places.get(key), length = at(e.measTop + part.top + part.height) - at(e.measTop + part.top);
				if (place == null || length < BOX_MIN) continue;
				boxes.push([place - FLAT_H / 2, Math.min(trackHeight, place - FLAT_H / 2 + length), part.whole > 0 ? Math.min(1, (part.above + under) / part.whole) : 0]);
				under = 0;
				open.add(key);
			}
		}
		const openKey = [...open].join("\n");
		if (openKey !== this.flatsKey) {
			this.flatsKey = openKey;
			this.paths![4].setAttribute("d", this.flats.filter(flat => !open.has(flat.key)).map(({ cy }) => `M${THREAD_X} ${cy - FLAT_H / 2}h${THREAD_W}v${FLAT_H}h-${THREAD_W}z`).join(""));
		}
		const key = `${thumbY} ${thumbEnd}|${boxes.map(([y, end, read]) => `${y.toFixed(2)} ${end.toFixed(2)} ${((end - y) * read).toFixed(1)}`).join()}|${this.annotationFill}`;
		if (key === this.viewKey) return;
		this.viewKey = key;
		// the thumb's paint: one bar in one colour
		const bar = document.createElementNS(SVG_NS, "rect");
		bar.setAttribute("x", `${MARK_W}`);
		bar.setAttribute("width", `${THUMB_W}`);
		bar.setAttribute("y", `${thumbY}`);
		bar.setAttribute("height", `${thumbHeight}`);
		this.view!.replaceChildren(bar);
		// a box: the bar's colour, pale inside, with a line of 1 px around it
		this.boxes!.replaceChildren(...boxes.flatMap(([y, end, read]) => {
			const rect = document.createElementNS(SVG_NS, "rect");
			rect.setAttribute("x", `${THREAD_X + 0.5}`);
			rect.setAttribute("width", `${THREAD_W - 1}`);
			rect.setAttribute("y", (y + 0.5).toFixed(2));
			rect.setAttribute("height", Math.max(1, end - y - 1).toFixed(2));
			rect.setAttribute("fill", this.annotationFill);
			rect.setAttribute("fill-opacity", "0.3");
			rect.setAttribute("stroke", this.annotationFill);
			if ((end - y) * read < 0.5) return [rect];
			const above = document.createElementNS(SVG_NS, "rect");  // the part of the card that is above the view
			above.dataset.read = "";
			above.setAttribute("x", `${THREAD_X}`);
			above.setAttribute("width", `${THREAD_W}`);
			above.setAttribute("y", y.toFixed(2));
			above.setAttribute("height", ((end - y) * read).toFixed(1));
			above.setAttribute("fill", this.annotationFill);
			return [rect, above];
		}));
	}

	private clear() {
		this.paths?.forEach(p => p.setAttribute("d", ""));
		this.thumb?.setAttribute("height", "0");
		this.grab?.setAttribute("height", "0");
		this.halo?.setAttribute("height", "0");
		this.view?.replaceChildren();
		this.viewKey = "";
		this.boxes?.replaceChildren();
		this.flats = [];
		this.flatsKey = undefined;
		this.places = new Map();
		this.marks = [];
		this.matchMarks = [];
		this.estExtent = 0;
		this.loading = undefined;
		this.dirty = true;
	}

	cleanUp() {
		this.clear();
		this.track?.removeEventListener("pointerdown", this.onPointerDown);
		this.track?.removeEventListener("pointermove", this.onPointerMove);
		this.track?.removeEventListener("pointerup", this.onPointerUp);
		this.track?.removeEventListener("pointercancel", this.onPointerUp);
		this.track?.removeEventListener("click", this.onClick);
		this.track?.removeEventListener("pointerleave", this.onPointerLeave);
		this.styleEl?.remove();
		this.host?.remove();
		const root = this.viewer?.root;
		if (root) {
			root.style.overflowY = this.overflowY;
			delete root.dataset.overviewScrollbar;
		}
		if (this.viewer?.container) {
			this.viewer.container.style.marginRight = this.marginRight;
		}
		this.styleEl = undefined;
		this.host = undefined;
		this.track = undefined;
		this.paths = undefined;
		this.thumb = this.grab = this.halo = this.ghost = this.view = this.boxes = undefined;
		this.drag = undefined;
		this.viewer = undefined;
	}
}
