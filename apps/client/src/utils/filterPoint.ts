/**
 * The centre of the open filter (twirl, spin blur, spherize…), shared by the filter window and the
 * handle drawn on the canvas: either side moves it, both show it. Only lives while such a filter
 * is open; never stored.
 */
export interface FilterPointState {
  x: number;
  y: number;
  /** Where 「置中」 puts it back: the selection's or the layer content's middle */
  home: { x: number; y: number };
  /** Circle drawn around the handle, in canvas pixels (null = none) */
  radius: number | null;
  /** False while the filter's settings leave the centre unused (e.g. a shift instead of a radial split) */
  shown: boolean;
  /** Keeps the handle on the canvas */
  bounds: { width: number; height: number };
}

let state: FilterPointState | null = null;
/** Bumped by every start(), so a late rehome() for an earlier filter is ignored */
let session = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const filterPoint = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** Opens a centre at `home`; returns the session that rehome() needs */
  start(home: { x: number; y: number }, bounds: { width: number; height: number }) {
    state = { x: home.x, y: home.y, home, radius: null, shown: true, bounds };
    emit();
    return ++session;
  },
  /** A better home arrived (the layer content's middle, read after opening): the centre follows unless it was moved */
  rehome(forSession: number, home: { x: number; y: number }) {
    if (!state || forSession !== session) return;
    const untouched = state.x === state.home.x && state.y === state.home.y;
    state = { ...state, home, ...(untouched ? { x: home.x, y: home.y } : {}) };
    emit();
  },
  clear() {
    if (!state) return;
    state = null;
    emit();
  },
  move(x: number, y: number) {
    if (!state) return;
    const nx = Math.round(Math.min(state.bounds.width, Math.max(0, x)));
    const ny = Math.round(Math.min(state.bounds.height, Math.max(0, y)));
    if (nx === state.x && ny === state.y) return;
    state = { ...state, x: nx, y: ny };
    emit();
  },
  recenter() {
    if (state) filterPoint.move(state.home.x, state.home.y);
  },
  show(shown: boolean, radius: number | null) {
    if (!state || (state.shown === shown && state.radius === radius)) return;
    state = { ...state, shown, radius };
    emit();
  },
};
