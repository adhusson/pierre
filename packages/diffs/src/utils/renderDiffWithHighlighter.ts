import { type ChangeObject, diffChars, diffWordsWithSpace } from 'diff';
import type { ElementContent } from 'hast';
import type { GrammarState } from 'shiki';

import { DEFAULT_COLLAPSED_CONTEXT_THRESHOLD } from '../constants';
import type {
  CodeToHastOptions,
  DecorationItem,
  DiffsHighlighter,
  DiffsThemeNames,
  FileContents,
  FileDiffMetadata,
  ForceDiffPlainTextOptions,
  LineDiffTypes,
  LineInfo,
  SharedRenderState,
  RenderDiffFilesResult,
  RenderDiffOptions,
  SupportedLanguages,
  ThemedDiffResult,
} from '../types';
import { appendItems } from './appendItems';
import { cleanLastNewline } from './cleanLastNewline';
import { createTransformerWithState } from './createTransformerWithState';
import { formatCSSVariablePrefix } from './formatCSSVariablePrefix';
import { getFiletypeFromFileName } from './getFiletypeFromFileName';
import { getHighlighterThemeStyles } from './getHighlighterThemeStyles';
import { getLineNodes } from './getLineNodes';
import { iterateOverDiff } from './iterateOverDiff';
import {
  createDiffSpanDecoration,
  pushOrJoinSpan,
} from './parseDiffDecorations';

const DEFAULT_PLAIN_TEXT_OPTIONS: ForceDiffPlainTextOptions = {
  forcePlainText: false,
};

export function renderDiffWithHighlighter(
  diff: FileDiffMetadata,
  highlighter: DiffsHighlighter,
  options: RenderDiffOptions,
  plainTextOptions: ForceDiffPlainTextOptions = DEFAULT_PLAIN_TEXT_OPTIONS
): ThemedDiffResult {
  const steps = renderDiffWithHighlighterInSlices(
    diff,
    highlighter,
    options,
    plainTextOptions,
    Infinity
  );
  for (;;) {
    const step = steps.next();
    if (step.done === true) {
      return step.value;
    }
  }
}

// renderDiffWithHighlighter in steps. The generator stops after each slice of
// `sliceLines` lines that it tokenizes, so that the caller can give the page
// time between two slices (DiffHunksRenderer.prepareDiff). A slice
// starts from the grammar state at the end of the slice before it, so the
// result is the same as one tokenization of the whole file. It also stops after
// each hunk of a partial diff. With Infinity, each file is one slice and the
// generator does not stop.
export function* renderDiffWithHighlighterInSlices(
  diff: FileDiffMetadata,
  highlighter: DiffsHighlighter,
  options: RenderDiffOptions,
  {
    forcePlainText,
    startingLine,
    totalLines,
    expandedHunks,
    collapsedContextThreshold = DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  }: ForceDiffPlainTextOptions = DEFAULT_PLAIN_TEXT_OPTIONS,
  sliceLines: number
): Generator<void, ThemedDiffResult, void> {
  if (forcePlainText) {
    startingLine ??= 0;
    totalLines ??= Infinity;
  } else {
    // If we aren't forcing plain text, then we intentionally do not support
    // ranges for highlighting as that could break the syntax highlighting, we
    // we override any values that may have been passed in.  Maybe one day we
    // warn about this?
    startingLine = 0;
    totalLines = Infinity;
  }
  const isWindowedHighlight = startingLine > 0 || totalLines < Infinity;
  const baseThemeType =
    typeof options.theme === 'string'
      ? highlighter.getTheme(options.theme).type
      : undefined;
  const themeStyles = getHighlighterThemeStyles({
    theme: options.theme,
    highlighter,
  });

  // If we have a large file and we are rendering the WHOLE plain diff ast,
  // then we should remove the lineDiffType to make sure things render quickly.
  // For highlighted ASTs or windowed highlights, we should just inherit the
  // setting
  const lineDiffType =
    forcePlainText &&
    !isWindowedHighlight &&
    (diff.unifiedLineCount > 1000 || diff.splitLineCount > 1000)
      ? 'none'
      : options.lineDiffType;

  const code: RenderDiffFilesResult = {
    deletionLines: [],
    additionLines: [],
  };

  const { maxLineDiffLength } = options;
  const shouldGroupAll = !forcePlainText && !diff.isPartial;
  const expandedHunksForIteration = forcePlainText ? expandedHunks : undefined;
  const buckets = new Map<number, RenderBucket>();
  function getBucketForHunk(hunkIndex: number) {
    const index = shouldGroupAll ? 0 : hunkIndex;
    const bucket = buckets.get(index) ?? createBucket();
    buckets.set(index, bucket);
    return bucket;
  }

  function appendContent(
    lineContent: string,
    lineIndex: number,
    segments: HighlightSegment[],
    contentWrapper: FakeArrayType
  ) {
    if (isWindowedHighlight) {
      let segment = segments.at(-1);
      if (
        segment == null ||
        segment.targetIndex + segment.count !== lineIndex
      ) {
        segment = {
          targetIndex: lineIndex,
          originalOffset: contentWrapper.length,
          count: 0,
        };
        segments.push(segment);
      }
      segment.count++;
    }
    contentWrapper.push(lineContent);
  }

  iterateOverDiff({
    diff,
    diffStyle: 'both',
    startingLine,
    totalLines,
    expandedHunks: isWindowedHighlight ? expandedHunksForIteration : true,
    collapsedContextThreshold,
    callback: ({ hunkIndex, additionLine, deletionLine, type }) => {
      const bucket = getBucketForHunk(hunkIndex);
      const splitLineIndex =
        additionLine != null
          ? additionLine.splitLineIndex
          : deletionLine.splitLineIndex;

      if (type === 'change' && additionLine != null && deletionLine != null) {
        computeLineDiffDecorations({
          additionLine: diff.additionLines[additionLine.lineIndex],
          deletionLine: diff.deletionLines[deletionLine.lineIndex],
          deletionLineIndex: bucket.deletionContent.length,
          additionLineIndex: bucket.additionContent.length,
          deletionDecorations: bucket.deletionDecorations,
          additionDecorations: bucket.additionDecorations,
          lineDiffType,
          maxLineDiffLength,
        });
      }

      if (deletionLine != null) {
        appendContent(
          diff.deletionLines[deletionLine.lineIndex],
          deletionLine.lineIndex,
          bucket.deletionSegments,
          bucket.deletionContent
        );
        bucket.deletionInfo.push({
          type: type === 'change' ? 'change-deletion' : type,
          lineNumber: deletionLine.lineNumber,
          altLineNumber:
            type === 'change'
              ? undefined
              : (additionLine.lineNumber ?? undefined),
          lineIndex: `${deletionLine.unifiedLineIndex},${splitLineIndex}`,
        });
      }

      if (additionLine != null) {
        appendContent(
          diff.additionLines[additionLine.lineIndex],
          additionLine.lineIndex,
          bucket.additionSegments,
          bucket.additionContent
        );
        bucket.additionInfo.push({
          type: type === 'change' ? 'change-addition' : type,
          lineNumber: additionLine.lineNumber,
          altLineNumber:
            type === 'change'
              ? undefined
              : (deletionLine.lineNumber ?? undefined),
          lineIndex: `${additionLine.unifiedLineIndex},${splitLineIndex}`,
        });
      }
    },
  });

  for (const bucket of buckets.values()) {
    if (
      bucket.deletionContent.length === 0 &&
      bucket.additionContent.length === 0
    ) {
      continue;
    }

    const deletionFile = {
      name: diff.prevName ?? diff.name,
      contents: bucket.deletionContent.value,
    };
    const additionFile = {
      name: diff.name,
      contents: bucket.additionContent.value,
    };
    const { deletionLines, additionLines } = yield* renderTwoFiles({
      sliceLines,
      deletionFile,
      deletionInfo: bucket.deletionInfo,
      deletionDecorations: bucket.deletionDecorations,

      additionFile,
      additionInfo: bucket.additionInfo,
      additionDecorations: bucket.additionDecorations,

      highlighter,
      options,
      languageOverride: forcePlainText ? 'text' : diff.lang,
    });

    if (shouldGroupAll) {
      code.deletionLines = deletionLines;
      code.additionLines = additionLines;
      continue;
    }

    if (bucket.deletionSegments.length > 0) {
      for (const seg of bucket.deletionSegments) {
        for (let i = 0; i < seg.count; i++) {
          code.deletionLines[seg.targetIndex + i] =
            deletionLines[seg.originalOffset + i];
        }
      }
    } else {
      appendItems(code.deletionLines, deletionLines);
    }
    if (bucket.additionSegments.length > 0) {
      for (const seg of bucket.additionSegments) {
        for (let i = 0; i < seg.count; i++) {
          code.additionLines[seg.targetIndex + i] =
            additionLines[seg.originalOffset + i];
        }
      }
    } else {
      appendItems(code.additionLines, additionLines);
    }
    if (sliceLines !== Infinity) {
      yield;
    }
  }

  return { code, themeStyles, baseThemeType };
}

// The line indexes and decoration arrays a line diff writes its highlights to
interface LineDiffDecorationTargets {
  deletionLineIndex: number;
  additionLineIndex: number;
  deletionDecorations: DecorationItem[];
  additionDecorations: DecorationItem[];
}

interface ProcessLineDiffProps extends LineDiffDecorationTargets {
  deletionLine: string | undefined;
  additionLine: string | undefined;
  lineDiffType: LineDiffTypes;
  maxLineDiffLength: number;
}

// Push one decoration per side covering the first through last changed
// token, so each line only has one highlight. Offsets come straight from the
// diff items, skipping the span arrays the other word modes build.
function pushWordLineDecorations(
  lineDiff: ChangeObject<string>[],
  {
    deletionLineIndex,
    additionLineIndex,
    deletionDecorations,
    additionDecorations,
  }: LineDiffDecorationTargets
): void {
  let deletionOffset = 0;
  let additionOffset = 0;
  let deletionStart = -1;
  let deletionEnd = 0;
  let additionStart = -1;
  let additionEnd = 0;
  for (const { value, added, removed } of lineDiff) {
    if (removed) {
      if (deletionStart === -1) deletionStart = deletionOffset;
      deletionOffset += value.length;
      deletionEnd = deletionOffset;
    } else if (added) {
      if (additionStart === -1) additionStart = additionOffset;
      additionOffset += value.length;
      additionEnd = additionOffset;
    } else {
      deletionOffset += value.length;
      additionOffset += value.length;
    }
  }
  if (deletionStart !== -1) {
    deletionDecorations.push(
      createDiffSpanDecoration({
        line: deletionLineIndex,
        spanStart: deletionStart,
        spanLength: deletionEnd - deletionStart,
      })
    );
  }
  if (additionStart !== -1) {
    additionDecorations.push(
      createDiffSpanDecoration({
        line: additionLineIndex,
        spanStart: additionStart,
        spanLength: additionEnd - additionStart,
      })
    );
  }
}

function computeLineDiffDecorations({
  deletionLine,
  additionLine,
  deletionLineIndex,
  additionLineIndex,
  deletionDecorations,
  additionDecorations,
  lineDiffType,
  maxLineDiffLength,
}: ProcessLineDiffProps) {
  if (deletionLine == null || additionLine == null || lineDiffType === 'none') {
    return;
  }
  deletionLine = cleanLastNewline(deletionLine);
  additionLine = cleanLastNewline(additionLine);
  // If we have really long lines, we probably shouldn't compute diffs on them.
  if (
    deletionLine.length > maxLineDiffLength ||
    additionLine.length > maxLineDiffLength
  ) {
    return;
  }
  // NOTE(amadeus): Because we visually trim trailing newlines when rendering,
  // we also gotta make sure the diff parsing doesn't include the newline
  // character that could be there...
  const lineDiff =
    lineDiffType === 'char'
      ? diffChars(deletionLine, additionLine)
      : diffWordsWithSpace(deletionLine, additionLine);
  if (lineDiffType === 'word-line') {
    pushWordLineDecorations(lineDiff, {
      deletionLineIndex,
      additionLineIndex,
      deletionDecorations,
      additionDecorations,
    });
    return;
  }
  const deletionSpans: [0 | 1, string][] = [];
  const additionSpans: [0 | 1, string][] = [];
  const enableJoin = lineDiffType === 'word-alt';
  const lastItem = lineDiff.at(-1);
  for (const item of lineDiff) {
    const isLastItem = item === lastItem;
    if (!item.added && !item.removed) {
      pushOrJoinSpan({
        item,
        arr: deletionSpans,
        enableJoin,
        isNeutral: true,
        isLastItem,
      });
      pushOrJoinSpan({
        item,
        arr: additionSpans,
        enableJoin,
        isNeutral: true,
        isLastItem,
      });
    } else if (item.removed) {
      pushOrJoinSpan({ item, arr: deletionSpans, enableJoin, isLastItem });
    } else {
      pushOrJoinSpan({ item, arr: additionSpans, enableJoin, isLastItem });
    }
  }
  let spanIndex = 0;
  for (const span of deletionSpans) {
    if (span[0] === 1) {
      deletionDecorations.push(
        createDiffSpanDecoration({
          line: deletionLineIndex,
          spanStart: spanIndex,
          spanLength: span[1].length,
        })
      );
    }
    spanIndex += span[1].length;
  }
  spanIndex = 0;
  for (const span of additionSpans) {
    if (span[0] === 1) {
      additionDecorations.push(
        createDiffSpanDecoration({
          line: additionLineIndex,
          spanStart: spanIndex,
          spanLength: span[1].length,
        })
      );
    }
    spanIndex += span[1].length;
  }
}

interface HighlightSegment {
  // The where the highlighted region starts
  originalOffset: number;
  // Where to place the highlighted line in RenderDiffFilesResult
  targetIndex: number;
  // Number of highlighted lines
  count: number;
}

interface FakeArrayType {
  push(value: string): void;
  value: string;
  length: number;
}

interface RenderBucket {
  deletionContent: FakeArrayType;
  additionContent: FakeArrayType;
  deletionInfo: (LineInfo | undefined)[];
  additionInfo: (LineInfo | undefined)[];
  deletionDecorations: DecorationItem[];
  additionDecorations: DecorationItem[];
  deletionSegments: HighlightSegment[];
  additionSegments: HighlightSegment[];
}

function createBucket(): RenderBucket {
  return {
    deletionContent: {
      push(value: string) {
        this.value += value;
        this.length++;
      },
      value: '',
      length: 0,
    },
    additionContent: {
      push(value: string) {
        this.value += value;
        this.length++;
      },
      value: '',
      length: 0,
    },
    deletionInfo: [],
    additionInfo: [],
    deletionDecorations: [],
    additionDecorations: [],
    deletionSegments: [],
    additionSegments: [],
  };
}

interface RenderTwoFilesProps {
  deletionFile: FileContents;
  additionFile: FileContents;
  deletionInfo: (LineInfo | undefined)[];
  additionInfo: (LineInfo | undefined)[];
  deletionDecorations: DecorationItem[];
  additionDecorations: DecorationItem[];
  options: RenderDiffOptions;
  highlighter: DiffsHighlighter;
  languageOverride: SupportedLanguages | undefined;
  sliceLines: number;
}

function* renderTwoFiles({
  deletionFile,
  additionFile,
  deletionInfo,
  additionInfo,
  highlighter,
  deletionDecorations,
  additionDecorations,
  languageOverride,
  options: { theme: themeOrThemes, ...options },
  sliceLines,
}: RenderTwoFilesProps): Generator<void, RenderDiffFilesResult, void> {
  const deletionLang =
    languageOverride ?? getFiletypeFromFileName(deletionFile.name);
  const additionLang =
    languageOverride ?? getFiletypeFromFileName(additionFile.name);
  const { state, transformers } = createTransformerWithState(
    options.useTokenTransformer
  );
  // tokenizeTimeLimit: 0 — never trade silently-wrong token colors for
  // latency; see renderFileWithHighlighter for the full rationale.
  const hastConfig: CodeToHastOptions<DiffsThemeNames> = (() => {
    return typeof themeOrThemes === 'string'
      ? {
          ...options,
          // language will be overwritten for each highlight
          lang: 'text',
          theme: themeOrThemes,
          transformers,
          decorations: undefined,
          defaultColor: false,
          cssVariablePrefix: formatCSSVariablePrefix('token'),
          tokenizeTimeLimit: 0,
        }
      : {
          ...options,
          // language will be overwritten for each highlight
          lang: 'text',
          themes: themeOrThemes,
          transformers,
          decorations: undefined,
          defaultColor: false,
          cssVariablePrefix: formatCSSVariablePrefix('token'),
          tokenizeTimeLimit: 0,
        };
  })();

  let deletionLines: ElementContent[] = [];
  if (deletionFile.contents !== '') {
    hastConfig.lang = deletionLang;
    deletionLines = yield* highlightInSlices({
      highlighter,
      code: cleanLastNewline(deletionFile.contents),
      hastConfig,
      state,
      lineInfo: deletionInfo,
      decorations: deletionDecorations,
      sliceLines,
    });
  }
  let additionLines: ElementContent[] = [];
  if (additionFile.contents !== '') {
    hastConfig.lang = additionLang;
    additionLines = yield* highlightInSlices({
      highlighter,
      code: cleanLastNewline(additionFile.contents),
      hastConfig,
      state,
      lineInfo: additionInfo,
      decorations: additionDecorations,
      sliceLines,
    });
  }

  return { deletionLines, additionLines };
}

interface HighlightInSlicesProps {
  highlighter: DiffsHighlighter;
  code: string;
  hastConfig: CodeToHastOptions<DiffsThemeNames>;
  state: SharedRenderState;
  lineInfo: (LineInfo | undefined)[];
  decorations: DecorationItem[];
  sliceLines: number;
}

// The line nodes of one file, tokenized in slices of `sliceLines` lines
// (renderDiffWithHighlighterInSlices). The generator stops after each slice
// except the last. Each slice gets its lines' line info and decorations, with
// line numbers from the slice's first line. A file with several themes, or
// with decorations at offsets, is one slice: a grammar state is for one theme,
// and an offset counts from the file's start. If a slice does not give one line
// node for each of its lines (a line break that is not \n), the file is
// tokenized again in one slice.
function* highlightInSlices({
  highlighter,
  code,
  hastConfig,
  state,
  lineInfo,
  decorations,
  sliceLines,
}: HighlightInSlicesProps): Generator<void, ElementContent[], void> {
  const whole = () => {
    state.lineInfo = lineInfo;
    hastConfig.decorations = decorations;
    return getLineNodes(highlighter.codeToHast(code, hastConfig));
  };
  if (
    sliceLines === Infinity ||
    'themes' in hastConfig ||
    decorations.some(
      (d) => typeof d.start === 'number' || typeof d.end === 'number'
    )
  ) {
    return whole();
  }
  const lines: ElementContent[] = [];
  let start = 0;
  let firstLine = 0;
  let grammarState: GrammarState | undefined;
  try {
    for (;;) {
      let end = start;
      let count = 0;
      let last = false;
      while (count < sliceLines) {
        const next = code.indexOf('\n', end);
        count++;
        if (next === -1) {
          end = code.length;
          last = true;
          break;
        }
        end = next + 1;
      }
      const lastLine = firstLine + count;
      state.lineInfo = lineInfo.slice(firstLine, lastLine);
      hastConfig.decorations = [];
      for (const d of decorations) {
        const { start: from, end: to } = d;
        if (
          typeof from !== 'number' &&
          typeof to !== 'number' &&
          from.line >= firstLine &&
          from.line < lastLine
        ) {
          hastConfig.decorations.push({
            ...d,
            start: { ...from, line: from.line - firstLine },
            end: { ...to, line: to.line - firstLine },
          });
        }
      }
      hastConfig.grammarState = grammarState;
      const hast = highlighter.codeToHast(
        last ? code.slice(start) : cleanLastNewline(code.slice(start, end)),
        hastConfig
      );
      const nodes = getLineNodes(hast);
      if (nodes.length !== count) {
        hastConfig.grammarState = undefined;
        return whole();
      }
      appendItems(lines, nodes);
      if (last) {
        return lines;
      }
      grammarState = highlighter.getLastGrammarState(hast);
      firstLine = lastLine;
      start = end;
      yield;
    }
  } finally {
    hastConfig.grammarState = undefined;
  }
}
