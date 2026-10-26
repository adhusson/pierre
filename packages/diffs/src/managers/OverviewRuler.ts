import type { CodeViewLocalManagerContext } from '../components/CodeView';

const SVG_NS = "http://www.w3.org/2000/svg";
const RULER_WIDTH = 24;

interface RulerSlice {
	id: string;
	yStart: number;
	yEnd: number;
}

export class OverviewRuler<LAnnotation, Caret> {
	dirty = true;
	host: HTMLDivElement | undefined;
	track: SVGSVGElement | undefined;
	activeFileRect: SVGRectElement | undefined;
	hoverFileRect: SVGRectElement | undefined;
	paths: SVGPathElement[] | undefined;
	thumb: SVGRectElement | undefined;
	tooltip: HTMLDivElement | undefined;
	viewer: CodeViewLocalManagerContext<LAnnotation, Caret> | undefined;
	slices: RulerSlice[] = [];
	height = 0;
	estExtent = 0;
	loading: string | undefined;
	searchVersion: number | undefined;
	marginRight = "";

	invalidate() {
		this.dirty = true;
	}

	setup(viewer: CodeViewLocalManagerContext<LAnnotation, Caret>) {
		this.viewer = viewer;
		const host = this.host = document.createElement("div");
		host.dataset.overviewRuler = "";
		host.style.cssText = "position:sticky;top:0;height:0;z-index:5;pointer-events:none";
		const track = this.track = document.createElementNS(SVG_NS, "svg");
		track.setAttribute("preserveAspectRatio", "none");
		track.style.cssText = `position:absolute;top:0;right:0;width:${RULER_WIDTH}px;background:var(--diffs-overview-bg,#ebeff3);border-left:1px solid #00000014;pointer-events:auto`;
		const activeFileRect = this.activeFileRect = document.createElementNS(SVG_NS, "rect");
		activeFileRect.dataset.rulerActiveFile = "";
		activeFileRect.setAttribute("x", "0");
		activeFileRect.setAttribute("width", `${RULER_WIDTH}`);
		track.append(activeFileRect);
		this.paths = ["deletions", "additions", "separators", "matches", "threads", "unread"].map(() => {
			const path = document.createElementNS(SVG_NS, "path");
			track.append(path);
			return path;
		});
		const hoverFileRect = this.hoverFileRect = document.createElementNS(SVG_NS, "rect");
		hoverFileRect.dataset.rulerHoverFile = "";
		hoverFileRect.setAttribute("x", "0");
		hoverFileRect.setAttribute("width", `${RULER_WIDTH}`);
		hoverFileRect.setAttribute("height", "0");
		hoverFileRect.style.fill = "#0969da18";
		track.append(hoverFileRect);
		const thumb = this.thumb = document.createElementNS(SVG_NS, "rect");
		thumb.dataset.rulerThumb = "";
		thumb.setAttribute("x", "0");
		thumb.setAttribute("width", `${RULER_WIDTH}`);
		track.append(thumb);
		const tooltip = this.tooltip = document.createElement("div");
		tooltip.dataset.rulerTooltip = "";
		tooltip.hidden = true;
		tooltip.style.cssText = `position:absolute;right:${RULER_WIDTH + 6}px;padding:2px 6px;border-radius:4px;background:#1f2328;color:#fff;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;pointer-events:none;box-shadow:0 1px 4px #00000033`;
		track.addEventListener("pointermove", this.onPointerMove);
		track.addEventListener("pointerleave", this.onPointerLeave);
		host.append(track, tooltip);
		if (viewer.container) {
			this.marginRight = viewer.container.style.marginRight;
			viewer.container.style.marginRight = `${RULER_WIDTH}px`;
		}
		viewer.root!.prepend(host);
	}

	private onPointerMove = (ev: PointerEvent) => {
		if (!this.tooltip || !this.hoverFileRect || this.slices.length === 0) return;
		const y = ev.clientY - (ev.currentTarget as Element).getBoundingClientRect().top;  // not offsetY: over a mark, Firefox measures it from the mark
		let slice = this.slices[0];
		for (const s of this.slices) {
			if (s.yStart <= y) slice = s;
			else break;
		}
		this.hoverFileRect.setAttribute("y", `${slice.yStart}`);
		this.hoverFileRect.setAttribute("height", `${Math.max(1, slice.yEnd - slice.yStart)}`);
		this.tooltip.textContent = slice.id;
		this.tooltip.hidden = false;
		const anchorY = slice.yEnd - slice.yStart > 40 ? y : (slice.yStart + slice.yEnd) / 2;
		const top = Math.min(Math.max(4, Math.round(anchorY - 10)), Math.max(4, this.height - 24));
		this.tooltip.style.top = `${top}px`;
	};

	private onPointerLeave = () => {
		if (this.tooltip) this.tooltip.hidden = true;
		this.hoverFileRect?.setAttribute("height", "0");
	};

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
		const root = viewer.root!, trackHeight = root.clientHeight, height = viewer.getHeight(), extent = viewer.getScrollHeight();
		if (this.dirty || trackHeight !== this.height) {
			this.dirty = true;
			this.height = trackHeight;
		}
		if (height <= 0 || extent <= 0 || trackHeight <= 0 || viewer.items.length === 0) {
			this.clear();
			return;
		}
		const offset = viewer.getItemTopOffset(), layoutCfg = viewer.getLayout();
		let estCursor = offset;
		const entries = viewer.items.map((record, i) => {
			const measTop = offset + record.top, measHeight = record.height;
			const estTop = estCursor;
			const estHeight = record.type === "diff" ? record.instance.getEstimatedHeight() : record.height;
			estCursor += estHeight + (i < viewer.items.length - 1 ? layoutCfg.gap : 0);
			return { record, measTop, measHeight, estTop, estHeight };
		});
		const estScrollHeight = Math.max(estCursor + layoutCfg.paddingBottom, trackHeight);
		const slices: RulerSlice[] = entries.map((e, i) => {
			const yStart = i === 0 ? 0 : Math.min(trackHeight - 1, Math.floor(e.estTop * trackHeight / estScrollHeight));
			const yEnd = i < entries.length - 1
				? Math.min(trackHeight, Math.floor(entries[i + 1].estTop * trackHeight / estScrollHeight))
				: trackHeight;
			return { id: e.record.item.id, yStart, yEnd: Math.max(yStart + 1, yEnd) };
		});
		this.slices = slices;
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
			const bands: [number, number][][] = [[], []];
			for (const { record, estTop: fileTop, slice, index } of files) {
				const [minY, maxY] = fileBounds(index, slice);
				for (const region of record.instance.getOverviewRulerRegions() ?? []) {
					const side = region.side === "deletions" ? 0 : 1;
					const [y, end] = span(fileTop + region.top, region.height, 2, minY, maxY);
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
					const d = `M${RULER_WIDTH - 7} ${y}h7v${end - y}h-7z`;
					if (mark.state === "unread") unreadPath += d;
					else openPath += d;
				}
			}
			this.paths![4].setAttribute("d", openPath);
			this.paths![5].setAttribute("d", unreadPath);
			const element = files.find(({ record }) => record.element)?.record.element;
			const style = getComputedStyle(root), theme = element ? getComputedStyle(element) : style;
			this.track!.style.colorScheme = theme.colorScheme;
			this.activeFileRect!.style.fill = style.getPropertyValue("--diffs-overview-active-bg") || (entries.length > 1 ? "#ffffff" : "#f6f8fa");
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
			this.paths![3].setAttribute("d", search ? files.flatMap(({ record, estTop: fileTop }) => {
				const keys = search.keys(record.item.id);
				return keys?.size ? record.instance.getOverviewRulerMarks(keys).map(mark => { const [y, end] = span(fileTop + mark.top, mark.height); return `M0 ${y}h8v${end - y}h-8z`; }) : [];
			}).join("") : "");
		}
		const scrollTop = viewer.getScrollTop();
		let activeIdx = 0;
		for (let i = 0; i < entries.length; i++) {
			if (entries[i].measTop <= scrollTop + 4) activeIdx = i;
			else break;
		}
		const activeSlice = slices[activeIdx];
		this.activeFileRect!.setAttribute("y", `${activeSlice.yStart}`);
		this.activeFileRect!.setAttribute("height", `${activeSlice.yEnd - activeSlice.yStart}`);
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
		this.activeFileRect?.setAttribute("height", "0");
		this.hoverFileRect?.setAttribute("height", "0");
		if (this.tooltip) this.tooltip.hidden = true;
		this.thumb?.setAttribute("height", "0");
		this.slices = [];
		this.estExtent = 0;
		this.loading = undefined;
		this.dirty = true;
	}

	cleanUp() {
		this.clear();
		this.track?.removeEventListener("pointermove", this.onPointerMove);
		this.track?.removeEventListener("pointerleave", this.onPointerLeave);
		this.host?.remove();
		if (this.viewer?.container) {
			this.viewer.container.style.marginRight = this.marginRight;
		}
		this.host = undefined;
		this.track = undefined;
		this.activeFileRect = undefined;
		this.hoverFileRect = undefined;
		this.paths = undefined;
		this.thumb = undefined;
		this.tooltip = undefined;
		this.viewer = undefined;
	}
}
