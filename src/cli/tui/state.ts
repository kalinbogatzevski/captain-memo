// src/cli/tui/state.ts
//
// Pure state machine for the `top` TUI. reduce(state, event) returns the next
// state; it never touches the terminal, the clock, or the network — the shell
// (top.ts) owns all of that and feeds events in. Keeping this pure is what
// makes the navigation/sort/filter logic unit-testable without a TTY.

import type { Key } from './keys.ts';
import type { RecallView, RecallSort } from '../../worker/observations-store.ts';

export type Mode = 'dashboard' | 'table' | 'detail' | 'help' | 'sources' | 'tokens' | 'homework';

/** One homework row as the [h] panel shows it (the shell sets them in display order). */
export interface HwRow { id: string; open: boolean; claimed_by?: string }
/** A claim or done the shell runs against the worker; it clears on the 'acted' event. */
export interface HwRequest { op: 'claim' | 'done'; id: string; note?: string }

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
  // frame scroll — the panels with no row navigation of their own (scrollsFrame)
  // scroll the clipped frame body instead, as far as the panel renders.
  // max/page are measured by the shell after each render (the 'frame' event).
  frame: { scroll: number; max: number; page: number };
  // homework panel: its own selection (the table's would reset on every view switch),
  // the done-note prompt, and a takeover armed by a first `c` on someone else's claim.
  hw: { rows: HwRow[]; sel: number; scroll: number; note: { active: boolean; buffer: string; id: string }; takeover: string | null };
  hwBy: string;                 // who `top` claims and closes as (set by the shell)
  hwRequest: HwRequest | null;  // an action for the shell to run
  notice: string | null;        // one line of feedback in the homework panel
  // help overlay returns to whichever mode opened it
  helpReturn: Mode;
  // lifecycle
  quit: boolean;
}

export type Event =
  | { type: 'key'; key: Key }
  | { type: 'data'; ids: number[] }
  | { type: 'resize'; pageSize: number }
  | { type: 'frame'; max: number; page: number }
  | { type: 'homework'; rows: HwRow[] }
  | { type: 'acted'; notice: string };

const VIEWS: RecallView[] = ['surfaced', 'recalled', 'recent', 'themes'];
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
    frame: { scroll: 0, max: 0, page: 1 },
    hw: { rows: [], sel: 0, scroll: 0, note: { active: false, buffer: '', id: '' }, takeover: null },
    hwBy: 'top',
    hwRequest: null,
    notice: null,
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
  surfaced: 'total', recalled: 'drill', recent: 'recency', themes: 'recency',
};

function enterTable(s: TopState, view: RecallView): TopState {
  return { ...s, mode: 'table', view, sort: VIEW_DEFAULT_SORT[view], selection: 0, scroll: 0 };
}

function cycle<T>(list: T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length]!;
}

export function reduce(state: TopState, event: Event): TopState {
  const next = reduceEvent(state, event);
  // Leaving a panel drops its frame scroll: the next one opens at the top. Done here,
  // once, rather than at every mode transition (enterTable, openHelp, Esc, …).
  return next.mode === state.mode ? next : { ...next, frame: { ...next.frame, scroll: 0 } };
}

function reduceEvent(state: TopState, event: Event): TopState {
  if (event.type === 'resize') return followScroll({ ...state, pageSize: Math.max(1, event.pageSize) });
  if (event.type === 'frame') {
    // Clamp rather than reset: a refresh that changes the row count keeps the view
    // where it was, and only a frame that shrank past it pulls the view back.
    return { ...state, frame: { scroll: clamp(state.frame.scroll, 0, event.max), max: event.max, page: event.page } };
  }
  if (event.type === 'homework') {
    const sel = clamp(state.hw.sel, 0, Math.max(0, event.rows.length - 1));
    return { ...state, hw: hwFollow({ ...state.hw, rows: event.rows, sel }, hwPageSize(state)) };
  }
  if (event.type === 'acted') return { ...state, hwRequest: null, notice: event.notice };
  if (event.type === 'data') {
    const rowIds = event.ids;
    const selection = clamp(state.selection, 0, Math.max(0, rowIds.length - 1));
    return followScroll({ ...state, rowIds, selection });
  }

  const key = event.key;
  if (key.type === 'ctrl-c') return { ...state, quit: true };

  if (scrollsFrame(state.mode)) {
    const scrolled = reduceFrameScroll(state, key);
    if (scrolled) return scrolled;
  }

  switch (state.mode) {
    case 'dashboard':  return reduceDashboard(state, key);
    case 'table':      return reduceTable(state, key);
    case 'detail':     return reduceDetail(state, key);
    case 'help':       return reduceHelp(state, key);
    case 'sources':    return reduceSources(state, key);
    case 'tokens':     return reduceTokens(state, key);
    case 'homework':   return reduceHomework(state, key);
  }
}

/** Panels with no row navigation of their own: a static block that clipFrame cuts at
 *  the terminal height, so their navigation keys scroll the frame body instead (the
 *  Windows report: only the table could scroll). The table pages its selection and the
 *  detail view its own body, and clipFrame must not promise them keys nobody routes. */
export function scrollsFrame(mode: Mode): boolean {
  return mode !== 'table' && mode !== 'detail' && mode !== 'homework';
}

/** j/k, ↑/↓, PgUp/PgDn, Home/End over the clipped frame body; null for any other key
 *  so the mode's own reducer sees it. */
function reduceFrameScroll(s: TopState, key: Key): TopState | null {
  const { scroll, max, page } = s.frame;
  let to: number;
  switch (key.type) {
    case 'down':     to = scroll + 1; break;
    case 'up':       to = scroll - 1; break;
    case 'pagedown': to = scroll + page; break;
    case 'pageup':   to = scroll - page; break;
    case 'home':     to = 0; break;
    case 'end':      to = max; break;
    case 'char':
      if (key.value === 'j') to = scroll + 1;
      else if (key.value === 'k') to = scroll - 1;
      else return null;
      break;
    default:
      return null;
  }
  return { ...s, frame: { ...s.frame, scroll: clamp(to, 0, max) } };
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
      case 'T': return enterTable(s, 'themes');   // uppercase: lowercase t is the type filter
      case 'a': return { ...s, mode: 'sources' };
      case 'm': return { ...s, mode: 'tokens' };
      case 'h': return openHomework(s);
      case '+': return { ...s, refreshMs: clamp(s.refreshMs + REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
      case '-': return { ...s, refreshMs: clamp(s.refreshMs - REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
      case '?': return openHelp(s);
      case 'q': return { ...s, quit: true };
    }
  }
  return s;
}

// The AI-sources tab: a static per-AI observation chart. No row navigation —
// s/r/n jump to the table views, `a`/Esc return to the dashboard.
/** Live per-session token flow. Mirrors reduceSources: 'm' toggles back out, so the
 *  key that opened the tab also closes it. */
function reduceTokens(s: TopState, key: Key): TopState {
  if (key.type === 'escape') return { ...s, mode: 'dashboard' };
  if (key.type === 'char') {
    switch (key.value) {
      case 's': return enterTable(s, 'surfaced');
      case 'r': return enterTable(s, 'recalled');
      case 'n': return enterTable(s, 'recent');
      case 'T': return enterTable(s, 'themes');   // uppercase: lowercase t is the type filter
      case 'm': return { ...s, mode: 'dashboard' };
      case 'a': return { ...s, mode: 'sources' };
      case 'h': return openHomework(s);
      case '+': return { ...s, refreshMs: clamp(s.refreshMs + REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
      case '-': return { ...s, refreshMs: clamp(s.refreshMs - REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
      case '?': return openHelp(s);
      case 'q': return { ...s, quit: true };
    }
  }
  return s;
}

function reduceSources(s: TopState, key: Key): TopState {
  if (key.type === 'escape') return { ...s, mode: 'dashboard' };
  if (key.type === 'char') {
    switch (key.value) {
      case 's': return enterTable(s, 'surfaced');
      case 'r': return enterTable(s, 'recalled');
      case 'n': return enterTable(s, 'recent');
      case 'T': return enterTable(s, 'themes');   // uppercase: lowercase t is the type filter
      case 'a': return { ...s, mode: 'dashboard' };
      case 'h': return openHomework(s);
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
        case 'T': return enterTable(s, 'themes');   // uppercase: lowercase t is the type filter
        case 'a': return { ...s, mode: 'sources' };   // AI-sources chart tab
        case 'm': return { ...s, mode: 'tokens' };    // live per-session token flow
        case 'h': return openHomework(s);             // homework panel
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

// ── homework ([h]) ──────────────────────────────────────────────────────────

/** Rows the homework list shows: the table's page size less the selected item's
 *  detail block under it, so list + detail + prompt fit the same terminal height. */
export const HW_DETAIL_ROWS = 6;
export function hwPageSize(s: TopState): number {
  return Math.max(3, s.pageSize - HW_DETAIL_ROWS);
}

function hwFollow(hw: TopState['hw'], page: number): TopState['hw'] {
  let scroll = hw.scroll;
  if (hw.sel < scroll) scroll = hw.sel;
  else if (hw.sel >= scroll + page) scroll = hw.sel - page + 1;
  return { ...hw, scroll: Math.max(0, scroll) };
}

function openHomework(s: TopState): TopState {
  return { ...s, mode: 'homework', notice: null, hw: { ...s.hw, note: { active: false, buffer: '', id: '' }, takeover: null } };
}

function reduceHomework(s0: TopState, key: Key): TopState {
  // The done-note prompt swallows keystrokes as text: Enter closes the item, Esc cancels.
  if (s0.hw.note.active) {
    const note = s0.hw.note;
    if (key.type === 'enter') {
      const text = note.buffer.trim();
      return { ...s0, hw: { ...s0.hw, note: { active: false, buffer: '', id: '' } },
        hwRequest: { op: 'done', id: note.id, ...(text ? { note: text } : {}) } };
    }
    if (key.type === 'escape') return { ...s0, hw: { ...s0.hw, note: { active: false, buffer: '', id: '' } }, notice: 'Not closed.' };
    if (key.type === 'backspace') return { ...s0, hw: { ...s0.hw, note: { ...note, buffer: note.buffer.slice(0, -1) } } };
    if (key.type === 'char' && note.buffer.length < 500) return { ...s0, hw: { ...s0.hw, note: { ...note, buffer: note.buffer + key.value } } };
    return s0;
  }

  // Any other key clears the last notice, and disarms a takeover unless it is the second `c`.
  const armed = s0.hw.takeover;
  const s: TopState = { ...s0, notice: null, hw: { ...s0.hw, takeover: null } };
  const last = Math.max(0, s.hw.rows.length - 1);
  const page = hwPageSize(s);
  const move = (sel: number): TopState => ({ ...s, hw: hwFollow({ ...s.hw, sel: clamp(sel, 0, last) }, page) });
  const row = s.hw.rows[s.hw.sel];

  switch (key.type) {
    case 'down':     return move(s.hw.sel + 1);
    case 'up':       return move(s.hw.sel - 1);
    case 'pagedown': return move(s.hw.sel + page);
    case 'pageup':   return move(s.hw.sel - page);
    case 'home':     return move(0);
    case 'end':      return move(last);
    case 'escape':   return { ...s, mode: 'dashboard' };
    case 'char':
      switch (key.value) {
        case 'j': return move(s.hw.sel + 1);
        case 'k': return move(s.hw.sel - 1);
        case 'g': return move(0);
        case 'G': return move(last);
        case 'c': {
          if (!row) return s;
          if (!row.open) return { ...s, notice: `#${row.id} is already done.` };
          // Claiming over someone else's claim takes a second `c`: the claim is advisory,
          // but taking a session's item without noticing it would be a silent surprise.
          if (row.claimed_by && row.claimed_by !== s.hwBy && armed !== row.id) {
            return { ...s, hw: { ...s.hw, takeover: row.id }, notice: `#${row.id} is claimed by ${row.claimed_by}. Press c again to take it over.` };
          }
          return { ...s, hwRequest: { op: 'claim', id: row.id } };
        }
        case 'd':
          if (!row) return s;
          if (!row.open) return { ...s, notice: `#${row.id} is already done.` };
          return { ...s, hw: { ...s.hw, note: { active: true, buffer: '', id: row.id } } };
        case 'h': return { ...s, mode: 'dashboard' };
        case 's': return enterTable(s, 'surfaced');
        case 'r': return enterTable(s, 'recalled');
        case 'n': return enterTable(s, 'recent');
        case 'T': return enterTable(s, 'themes');
        case 'a': return { ...s, mode: 'sources' };
        case 'm': return { ...s, mode: 'tokens' };
        case '+': return { ...s, refreshMs: clamp(s.refreshMs + REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
        case '-': return { ...s, refreshMs: clamp(s.refreshMs - REFRESH_STEP, MIN_REFRESH, MAX_REFRESH) };
        case '?': return openHelp(s);
        case 'q': return { ...s, quit: true };
      }
      return s;
    default:
      return s;
  }
}
