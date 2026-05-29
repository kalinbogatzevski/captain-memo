// src/cli/tui/state.ts
//
// Pure state machine for the `top` TUI. reduce(state, event) returns the next
// state; it never touches the terminal, the clock, or the network — the shell
// (top.ts) owns all of that and feeds events in. Keeping this pure is what
// makes the navigation/sort/filter logic unit-testable without a TTY.

import type { Key } from './keys.ts';
import type { RecallView, RecallSort } from '../../worker/observations-store.ts';

export type Mode = 'dashboard' | 'table' | 'detail' | 'help';

export interface TopState {
  mode: Mode;
  refreshMs: number;
  // table query state
  view: RecallView;
  sort: RecallSort;
  typeFilter: string | null;
  query: string;
  collapse: boolean;
  // table navigation
  selection: number;        // selected row index
  scroll: number;           // first visible row index
  pageSize: number;         // visible table rows (set by resize)
  rowIds: number[];         // ids of the rows currently shown (set by data)
  // filter input
  filter: { active: boolean; buffer: string };
  // detail
  detailId: number | null;
  detailScroll: number;
  // help overlay returns to whichever mode opened it
  helpReturn: Mode;
  // lifecycle
  quit: boolean;
}

export type Event =
  | { type: 'key'; key: Key }
  | { type: 'data'; ids: number[] }
  | { type: 'resize'; pageSize: number };

const VIEWS: RecallView[] = ['surfaced', 'recalled', 'recent'];
const SORTS: RecallSort[] = ['total', 'auto', 'search', 'drill', 'recency'];
// Type filter cycle: all (null) then each observation type.
const TYPE_CYCLE: Array<string | null> =
  [null, 'bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'];

const MIN_REFRESH = 500;
const MAX_REFRESH = 10_000;
const REFRESH_STEP = 500;

export function initialState(): TopState {
  return {
    mode: 'dashboard',
    refreshMs: 2000,
    view: 'surfaced',
    sort: 'total',
    typeFilter: null,
    query: '',
    collapse: false,
    selection: 0,
    scroll: 0,
    pageSize: 10,
    rowIds: [],
    filter: { active: false, buffer: '' },
    detailId: null,
    detailScroll: 0,
    helpReturn: 'dashboard',
    quit: false,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Keep the selected row inside the visible [scroll, scroll+pageSize) window. */
function followScroll(s: TopState): TopState {
  let scroll = s.scroll;
  if (s.selection < scroll) scroll = s.selection;
  else if (s.selection >= scroll + s.pageSize) scroll = s.selection - s.pageSize + 1;
  return { ...s, scroll: Math.max(0, scroll) };
}

// Each view has a natural default ordering; entering a view adopts it.
const VIEW_DEFAULT_SORT: Record<RecallView, RecallSort> = {
  surfaced: 'total', recalled: 'drill', recent: 'recency',
};

function enterTable(s: TopState, view: RecallView): TopState {
  return { ...s, mode: 'table', view, sort: VIEW_DEFAULT_SORT[view], selection: 0, scroll: 0 };
}

function cycle<T>(list: T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length]!;
}

export function reduce(state: TopState, event: Event): TopState {
  if (event.type === 'resize') return followScroll({ ...state, pageSize: Math.max(1, event.pageSize) });
  if (event.type === 'data') {
    const rowIds = event.ids;
    const selection = clamp(state.selection, 0, Math.max(0, rowIds.length - 1));
    return followScroll({ ...state, rowIds, selection });
  }

  const key = event.key;
  if (key.type === 'ctrl-c') return { ...state, quit: true };

  switch (state.mode) {
    case 'dashboard': return reduceDashboard(state, key);
    case 'table':     return reduceTable(state, key);
    case 'detail':    return reduceDetail(state, key);
    case 'help':      return reduceHelp(state, key);
  }
}

function openHelp(s: TopState): TopState {
  return { ...s, mode: 'help', helpReturn: s.mode };
}

function reduceHelp(s: TopState, key: Key): TopState {
  if (key.type === 'escape') return { ...s, mode: s.helpReturn };
  if (key.type === 'char') {
    if (key.value === '?') return { ...s, mode: s.helpReturn };
    if (key.value === 'q') return { ...s, quit: true };
  }
  return s;
}

function reduceDashboard(s: TopState, key: Key): TopState {
  if (key.type === 'char') {
    switch (key.value) {
      case 's': return enterTable(s, 'surfaced');
      case 'r': return enterTable(s, 'recalled');
      case 'n': return enterTable(s, 'recent');
      case '+': return { ...s, refreshMs: clamp(s.refreshMs + REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
      case '-': return { ...s, refreshMs: clamp(s.refreshMs - REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
      case '?': return openHelp(s);
      case 'q': return { ...s, quit: true };
    }
  }
  return s;
}

function reduceTable(s: TopState, key: Key): TopState {
  // Filter-input mode swallows keystrokes as text.
  if (s.filter.active) {
    if (key.type === 'enter') {
      return { ...s, query: s.filter.buffer, filter: { active: false, buffer: '' }, selection: 0, scroll: 0 };
    }
    if (key.type === 'escape') return { ...s, filter: { active: false, buffer: '' } };
    if (key.type === 'backspace') return { ...s, filter: { ...s.filter, buffer: s.filter.buffer.slice(0, -1) } };
    if (key.type === 'char') return { ...s, filter: { ...s.filter, buffer: s.filter.buffer + key.value } };
    return s;
  }

  const lastIndex = Math.max(0, s.rowIds.length - 1);
  switch (key.type) {
    case 'down':     return followScroll({ ...s, selection: clamp(s.selection + 1, 0, lastIndex) });
    case 'up':       return followScroll({ ...s, selection: clamp(s.selection - 1, 0, lastIndex) });
    case 'pagedown': return followScroll({ ...s, selection: clamp(s.selection + s.pageSize, 0, lastIndex) });
    case 'pageup':   return followScroll({ ...s, selection: clamp(s.selection - s.pageSize, 0, lastIndex) });
    case 'home':     return followScroll({ ...s, selection: 0 });
    case 'end':      return followScroll({ ...s, selection: lastIndex });
    case 'tab':      return enterTable(s, cycle(VIEWS, s.view));
    case 'escape':   return { ...s, mode: 'dashboard' };
    case 'enter': {
      const id = s.rowIds[s.selection];
      if (id === undefined) return s;
      return { ...s, mode: 'detail', detailId: id, detailScroll: 0 };
    }
    case 'char':
      switch (key.value) {
        case 's': return enterTable(s, 'surfaced');   // view switch in-place,
        case 'r': return enterTable(s, 'recalled');   // consistent with the
        case 'n': return enterTable(s, 'recent');     // dashboard s/r/n keys
        case 'j': return followScroll({ ...s, selection: clamp(s.selection + 1, 0, lastIndex) });
        case 'k': return followScroll({ ...s, selection: clamp(s.selection - 1, 0, lastIndex) });
        case 'g': return followScroll({ ...s, selection: 0 });
        case 'G': return followScroll({ ...s, selection: lastIndex });
        case 'o': return { ...s, sort: cycle(SORTS, s.sort) };
        case 'c': return { ...s, collapse: !s.collapse };
        case 't': return { ...s, typeFilter: cycle(TYPE_CYCLE, s.typeFilter), selection: 0, scroll: 0 };
        case '/': return { ...s, filter: { active: true, buffer: s.query } };
        case '?': return openHelp(s);
        case 'q': return { ...s, quit: true };
      }
      return s;
    default:
      return s;
  }
}

function reduceDetail(s: TopState, key: Key): TopState {
  switch (key.type) {
    case 'escape': return { ...s, mode: 'table' };
    case 'down':   return { ...s, detailScroll: s.detailScroll + 1 };
    case 'up':     return { ...s, detailScroll: Math.max(0, s.detailScroll - 1) };
    case 'char':
      if (key.value === 'j') return { ...s, detailScroll: s.detailScroll + 1 };
      if (key.value === 'k') return { ...s, detailScroll: Math.max(0, s.detailScroll - 1) };
      if (key.value === 'q') return { ...s, quit: true };
      return s;
    default:
      return s;
  }
}
