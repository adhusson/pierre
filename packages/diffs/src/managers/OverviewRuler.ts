import type { CodeViewLocalManagerContext } from '../components/CodeView';

const SVG_NS = "http://www.w3.org/2000/svg";
const RULER_WIDTH = 17;
// A thread mark: a dot left of the track, in the space between the files and the ruler (the track's overflow is visible). DOT_X: its
// center, from the track's left edge; DOT_R: its radius.
const DOT_X = -5, DOT_R = 3;

interface RulerSlice {
	yStart: number;
	yEnd: number;
}

// A mark as drawn on the track (x to xEnd, y to end, on layer: 0 a change, 1 a match, 2 a thread, in the order of the paths; a thread's x is left of the track) and the
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
	thumb: SVGRectElement | undefined;
	viewer: CodeViewLocalManagerContext<LAnnotation, Caret> | undefined;
	drag: { pointerId: number; grab: number } | undefined;  // a drag of the thumb: grab is the pointer's distance below the thumb's top
	thumbPress = false;  // the last press was on the thumb: its click does not scroll
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
			[data-ruler-thumb]{cursor:grab}
			[data-ruler-dragging],[data-ruler-dragging] [data-ruler-thumb]{cursor:grabbing}
		`;
		const host = this.host = document.createElement("div");
		host.dataset.overviewRuler = "";
		host.style.cssText = "position:sticky;top:0;height:0;z-index:5;pointer-events:none";
		const track = this.track = document.createElementNS(SVG_NS, "svg");
		track.setAttribute("preserveAspectRatio", "none");
		track.style.cssText = `position:absolute;top:0;right:0;width:${RULER_WIDTH}px;overflow:visible;background:var(--diffs-overview-bg,#f6f8fa);border-left:1px solid #00000014;pointer-events:auto;user-select:none;touch-action:none`;
		this.paths = ["deletions", "additions", "separators", "matches", "threads", "unread"].map(() => {
			const path = document.createElementNS(SVG_NS, "path");
			track.append(path);
			return path;
		});
		const thumb = this.thumb = document.createElementNS(SVG_NS, "rect");
		thumb.dataset.rulerThumb = "";
		thumb.setAttribute("x", "0");
		thumb.setAttribute("width", `${RULER_WIDTH}`);
		track.append(thumb);
		track.addEventListener("pointerdown", this.onPointerDown);
		track.addEventListener("pointermove", this.onPointerMove);
		track.addEventListener("pointerup", this.onPointerUp);
		track.addEventListener("pointercancel", this.onPointerUp);
		track.addEventListener("click", this.onClick);
		host.append(track);
		this.overflowY = root.style.overflowY;
		root.style.overflowY = "scroll";
		root.dataset.overviewScrollbar = "";
		if (viewer.container) {
			this.marginRight = viewer.container.style.marginRight;
			viewer.container.style.marginRight = `${RULER_WIDTH}px`;
		}
		root.prepend(styleEl, host);
	}

	// A press on the thumb starts a drag: the track captures the pointer, and preventDefault keeps the press from selecting text.
	private onPointerDown = (ev: PointerEvent) => {
		this.thumbPress = ev.target === this.thumb;
		if (!this.thumbPress || ev.button !== 0 || !this.track) return;
		ev.preventDefault();
		const y = ev.clientY - this.track.getBoundingClientRect().top;
		this.drag = { pointerId: ev.pointerId, grab: y - Number(this.thumb!.getAttribute("y")) };
		this.track.setPointerCapture(ev.pointerId);
		this.track.dataset.rulerDragging = "";
	};

	// During a drag, the thumb's top follows the pointer, at the grab's distance above it. update() draws the thumb's top at the baseline
	// place of scrollTop (its mapY); this inverts mapY: the baseline place of the thumb's top gives the scrollTop to set. The next render
	// draws the thumb from that scrollTop, so the thumb stays under the pointer while the rows on the way are measured. A tall thread
	// or wrap has one baseline place, so the drag jumps over it. The write adds a difference to root.scrollTop, so CodeView's paged
	// scroll (its rebase of very tall views) keeps its offset.
	// ponytail: getScrollTop() reads root.scrollTop again only after a scroll event. Chrome sends one pointermove per frame, before the
	// frame's scroll event. A browser that sends two moves before that event scrolls too far at the second move, and the next move
	// corrects it. If that shows, write once per frame (requestAnimationFrame).
	private onPointerMove = (ev: PointerEvent) => {
		const viewer = this.viewer, drag = this.drag;
		if (!viewer?.root || !drag || ev.pointerId !== drag.pointerId || this.height <= 0 || viewer.items.length === 0) return;
		const { offset, entries, estScrollHeight } = this.layout(viewer, this.height);
		const est = (ev.clientY - this.track!.getBoundingClientRect().top - drag.grab) * estScrollHeight / this.height;
		const e = entries.find(e => est <= e.estTop + e.estHeight) ?? entries.at(-1)!;
		const scrollTop = est <= offset ? est
			: est <= e.estTop ? e.measTop - (e.estTop - est)
			: est <= e.estTop + e.estHeight ? e.measTop + (e.record.type === "diff" ? e.record.instance.mapEstimatedToMeasured(est - e.estTop) : est - e.estTop)
			: e.measTop + e.measHeight + (est - (e.estTop + e.estHeight));
		viewer.root.scrollTop += scrollTop - viewer.getScrollTop();
	};

	private onPointerUp = (ev: PointerEvent) => {
		if (ev.pointerId !== this.drag?.pointerId) return;
		this.drag = undefined;
		if (this.track) delete this.track.dataset.rulerDragging;
	};

	// A click on the track scrolls to what the track shows at that height. The click's height gives a place in baseline row space,
	// as the marks use it; the line of the row there goes to the middle of the view (a line target: CodeView follows it while the
	// rows on the way are measured). A mark is drawn at least 2 px tall (a thread: a dot), so in a long diff it covers more rows than its own: a
	// click on it goes to its own rows. Each kind of mark has its own band of x (a change: the whole width, a thread: its dot, left of the
	// track, a match: the left edge): only the marks drawn under the click count, and of those the one drawn on top (a match over a change),
	// else the one whose rows are nearest. A diff item without rows goes to its start; a file item has no baseline space of its own.
	private onClick = (ev: MouseEvent) => {
		const viewer = this.viewer;
		if (!viewer || this.thumbPress || ev.button !== 0 || this.height <= 0 || viewer.items.length === 0) return;
		const rect = (ev.currentTarget as Element).getBoundingClientRect(), y = ev.clientY - rect.top;  // not offsetX/Y: over a mark, Firefox measures them from the mark
		const x = RULER_WIDTH - (rect.right - ev.clientX);  // from the right edge: the box is 1 px wider than the drawing (its left border). A dot's x is negative
		const { entries, estScrollHeight } = this.layout(viewer, this.height);
		let est = y * estScrollHeight / this.height;
		const gap = (m: RulerMark) => Math.max(0, m.estTop - est, est - (m.estEnd - 1));
		const hit = [...this.marks, ...this.matchMarks].filter(m => m.x <= x && x < m.xEnd && m.y <= y && y < m.end).sort((a, b) => b.layer - a.layer || gap(a) - gap(b))[0];
		if (hit) est = Math.min(Math.max(est, hit.estTop), hit.estEnd - 1);
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

	update(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>, search?: { version: number; keys(id: string): ReadonlySet<string> | undefined }) {
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
				separatorPath += `M0 ${divY}h${RULER_WIDTH}v1h-${RULER_WIDTH}z`;
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
					marks.push({ layer: 0, x: 0, xEnd: RULER_WIDTH, y, end, estTop: fileTop + region.top, estEnd: fileTop + region.top + region.height });
					const previous = bands[side].at(-1);
					if (previous && y <= previous[1]) previous[1] = Math.max(previous[1], end);
					else bands[side].push([y, end]);
				}
			}
			const edges = bands.flatMap((bands, side) => bands.flatMap(([top, bottom]) => [{ y: top, side, change: 1 }, { y: bottom, side, change: -1 }])).sort((a, b) => a.y - b.y);
			const active = [0, 0], paths = ["", ""];
			let top = 0;
			const half = RULER_WIDTH / 2;
			for (const edge of edges) {
				if (edge.y > top) for (let side = 0; side < 2; side++) {
					if (!active[side]) continue;
					const width = active[1 - side] ? half : RULER_WIDTH, x = active[1 - side] ? side * half : 0;
					paths[side] += `M${x} ${top}h${width}v${edge.y - top}h-${width}z`;
				}
				active[edge.side] += edge.change;
				top = edge.y;
			}
			this.paths![0].setAttribute("d", paths[0]);
			this.paths![1].setAttribute("d", paths[1]);
			this.paths![2].setAttribute("d", separatorPath);
			let openPath = "", unreadPath = "";
			for (const { record, estTop: fileTop, slice, index } of files) {
				const [minY, maxY] = fileBounds(index, slice);
				for (const mark of record.instance.getOverviewRulerThreads(viewer.options.getAnnotationRulerState)) {
					const [y, end] = span(fileTop + mark.top, mark.height, 4, minY, maxY);
					const cy = Math.min(Math.max((y + end) / 2, DOT_R), trackHeight - DOT_R);  // a round dot at the middle of the mark's rows
					marks.push({ layer: 2, x: DOT_X - DOT_R - 1, xEnd: DOT_X + DOT_R + 1, y: Math.floor(cy - DOT_R - 1), end: Math.ceil(cy + DOT_R + 1), estTop: fileTop + mark.top, estEnd: fileTop + mark.top + mark.height });
					const d = `M${DOT_X - DOT_R} ${cy}a${DOT_R} ${DOT_R} 0 1 0 ${2 * DOT_R} 0a${DOT_R} ${DOT_R} 0 1 0 ${-2 * DOT_R} 0z`;
					if (mark.state === "unread") unreadPath += d;
					else openPath += d;
				}
			}
			this.marks = marks;
			this.paths![4].setAttribute("d", openPath);
			this.paths![5].setAttribute("d", unreadPath);
			const element = files.find(({ record }) => record.element)?.record.element;
			const style = getComputedStyle(root), theme = element ? getComputedStyle(element) : style;
			this.track!.style.colorScheme = theme.colorScheme;
			this.paths![0].style.fill = style.getPropertyValue("--diffs-overview-deletion") || theme.getPropertyValue("--diffs-bg-deletion") || "#ffebe9";
			this.paths![1].style.fill = style.getPropertyValue("--diffs-overview-addition") || theme.getPropertyValue("--diffs-bg-addition") || "#dafbe1";
			this.paths![2].style.fill = style.getPropertyValue("--diffs-overview-separator") || "#0000001f";
			this.paths![3].style.fill = style.getPropertyValue("--diffs-overview-match") || "#ffd33d";
			this.paths![4].style.fill = style.getPropertyValue("--diffs-overview-thread") || "#57606a";
			this.paths![5].style.fill = style.getPropertyValue("--diffs-overview-unread") || "#0969da";
			this.thumb!.style.fill = style.getPropertyValue("--diffs-overview-viewport") || "#80808024";
			this.dirty = false;
		}
		if (layout || matches) {
			this.searchVersion = search?.version;
			const matchMarks: RulerMark[] = [];
			this.paths![3].setAttribute("d", search ? files.flatMap(({ record, estTop: fileTop }) => {
				const keys = search.keys(record.item.id);
				return keys?.size ? record.instance.getOverviewRulerMarks(keys).map(mark => {
					const [y, end] = span(fileTop + mark.top, mark.height);
					matchMarks.push({ layer: 1, x: 0, xEnd: 8, y, end, estTop: fileTop + mark.top, estEnd: fileTop + mark.top + mark.height });
					return `M0 ${y}h8v${end - y}h-8z`;
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
		const estStart = mapY(scrollTop), estEnd = mapY(scrollTop + height);
		const thumbHeight = extent <= height ? trackHeight : Math.min(trackHeight, Math.max(12, Math.round((estEnd - estStart) * trackHeight / estScrollHeight)));
		const thumbY = extent <= height ? 0 : Math.min(trackHeight - thumbHeight, Math.max(0, Math.round(estStart * trackHeight / estScrollHeight)));
		this.thumb!.setAttribute("y", `${thumbY}`);
		this.thumb!.setAttribute("height", `${thumbHeight}`);
	}

	private clear() {
		this.paths?.forEach(p => p.setAttribute("d", ""));
		this.thumb?.setAttribute("height", "0");
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
		this.thumb = undefined;
		this.drag = undefined;
		this.viewer = undefined;
	}
}
