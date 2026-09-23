import type { FlowNode } from "../core/flow.ts";

/**
 * Lays a workflow's node tree out left to right, the way n8n draws a canvas.
 *
 * `flow.ts` hands over a tree — a loop holds its body, a check holds its two
 * sides, a helper holds its steps. n8n has no nesting at all: every node sits
 * on one canvas and the structure is in the wires. So this flattens the tree
 * into positioned nodes and wires:
 *
 * - a step, a plain call or a `ctx.run()` is one node on the line;
 * - an `if` is an IF node with two outputs, a `switch` a Switch node with one
 *   per case, and both sides carry on to the right — the side that continues
 *   stays on the main line, so a check that only stops the run is a dip
 *   below the line rather than a step down the page, and the rest of the
 *   code carries on straight from the IF rather than waiting for it;
 * - two or more `if (x) return` gates in a row fold into one Filter node;
 * - a loop is a Loop node with `done` and `loop` outputs, its body below, and
 *   a wire back from the body's end to the Loop node;
 * - a `catch` is a red "on error" wire forking off the line;
 * - a helper, or a step with steps inside, stays on the line too, with a
 *   labelled frame behind its nodes — n8n's sticky note — so the reader can
 *   still tell where in the code those nodes live.
 *
 * Everything here is geometry: no HTML, no run data. `views.ts` draws it.
 *
 * Every block is laid out in its own coordinates, entered at (0, 0) from the
 * left, and extending up (`top` < 0) and down (`bottom` > 0) from that line.
 * Its open ends — where the next thing on the line gets wired from — are
 * always on its right edge, so wiring two blocks together only ever crosses
 * the gap between them and never runs through a node.
 */

/** What a placed node is. `views.ts` turns each into an icon, a name and a panel. */
export type Card =
  | { kind: "trigger" }
  | { kind: "error-trigger" }
  | { kind: "node"; node: Extract<FlowNode, { kind: "step" | "action" | "run" }> }
  | { kind: "if"; node: Extract<FlowNode, { kind: "branch" }> }
  | { kind: "filter"; gates: Extract<FlowNode, { kind: "branch" }>[] }
  | { kind: "switch"; node: Extract<FlowNode, { kind: "switch" }> }
  | { kind: "loop"; node: Extract<FlowNode, { kind: "loop" }> }
  | { kind: "end"; node: Extract<FlowNode, { kind: "end" }> }
  /** The end of a line the code falls off without a `return`. */
  | { kind: "done" };

export interface Port {
  /** Relative to the node's centre line. */
  dy: number;
  label?: string;
}

export interface Placed {
  id: number;
  card: Card;
  /** Left edge of the node's box. */
  x: number;
  /** The node's centre line — where its input is. */
  y: number;
  w: number;
  h: number;
  shape: "box" | "trigger" | "round";
  outs: Port[];
}

export interface Wire {
  /** An SVG path in canvas coordinates. */
  d: string;
  tone: "main" | "error" | "back";
  /** The node this wire runs into, for lighting the path a run took. */
  to?: number;
  /** Words along it, where no port says what the wire is. */
  label?: { x: number; y: number; text: string };
}

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  /** A helper's comment, or the step the frame is inside. */
  doc?: string;
  kind: "helper" | "step";
}

export interface Layout {
  nodes: Placed[];
  wires: Wire[];
  frames: Frame[];
  /** The canvas: everything drawn lies within it. */
  minX: number;
  minY: number;
  width: number;
  height: number;
  /** Where the main line runs, for opening the canvas on it. */
  mainY: number;
}

/* ------------------------------------------------------------- geometry */

/** A node's box. Small enough that a phone shows three or four across. */
const NW = 64;
const NH = 64;
/** A terminal — Done, Fail, Skip — is a smaller circle. */
const TW = 44;
/** Between one node's box and the next. The name under a node is 140 wide. */
const GAP = 96;
/** Between two stacked branches. */
const VGAP = 26;
/** The name and subtitle under a node, and the port labels above it. */
const LABEL = 140;
const BELOW = 58;
const ABOVE = 18;
/** Frame padding: wide enough for the name under the frame's outer nodes. */
const FPX = 44;
const FPT = 34;
const FPB = 14;

interface Pt {
  x: number;
  y: number;
}

/** Space something on the canvas takes up — a node and its name, a frame, a lane. */
interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Block {
  w: number;
  top: number;
  bottom: number;
  /** Open ends that carry on to whatever comes next. Always at x === w. */
  outs: Pt[];
  /** Open ends that leave the enclosing helper or step, not just this block. */
  escapes: Pt[];
  nodes: Placed[];
  wires: Wire[];
  frames: Frame[];
  /** What is taken, for stacking another block under this one without a collision. */
  rects: Rect[];
  /** The first node of this block, for lighting a wire that runs into it. */
  first?: number;
}

const blank = (first?: number): Block => ({
  w: 0,
  top: 0,
  bottom: 0,
  outs: [],
  escapes: [],
  nodes: [],
  wires: [],
  frames: [],
  rects: [],
  ...(first !== undefined ? { first } : {}),
});

/** A wire between two points, bent into an S with horizontal ends like n8n's. */
function curve(a: Pt, b: Pt): string {
  if (Math.abs(a.y - b.y) < 0.5) return `M${a.x} ${a.y}H${b.x}`;
  const k = Math.max(24, Math.min(80, (b.x - a.x) / 2));
  return `M${a.x} ${a.y}C${a.x + k} ${a.y} ${b.x - k} ${b.y} ${b.x} ${b.y}`;
}

/** A path through right-angled points with rounded corners. For wires that go backwards. */
function rounded(pts: Pt[], r = 12): string {
  let d = `M${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const n = pts[i + 1]!;
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const ax = c.x - ((c.x - p.x) / (d1 || 1)) * rr;
    const ay = c.y - ((c.y - p.y) / (d1 || 1)) * rr;
    const bx = c.x + ((n.x - c.x) / (d2 || 1)) * rr;
    const by = c.y + ((n.y - c.y) / (d2 || 1)) * rr;
    d += `L${ax} ${ay}Q${c.x} ${c.y} ${bx} ${by}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d}L${last.x} ${last.y}`;
}

/** Moves a wire's path. Paths here only use absolute commands, so every pair shifts. */
function shiftPath(d: string, dx: number, dy: number): string {
  return d.replace(/([MLHCQ])([^MLHCQ]*)/g, (_, cmd: string, args: string) => {
    const nums = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "H") return `H${nums.map((n) => n + dx).join(" ")}`;
    return cmd + nums.map((n, j) => (j % 2 === 0 ? n + dx : n + dy)).join(" ");
  });
}

/** Nothing: a side of a check with no nodes on it, which the caller runs a lane through. */
function empty(): Block {
  return { ...blank(), top: -10, bottom: 10, outs: [{ x: 0, y: 0 }] };
}

/** Copies `b` into `into`, moved by (dx, dy). Returns b's open ends, moved. */
function place(into: Block, b: Block, dx: number, dy: number): { outs: Pt[]; escapes: Pt[] } {
  for (const n of b.nodes) into.nodes.push({ ...n, x: n.x + dx, y: n.y + dy });
  for (const w of b.wires) {
    into.wires.push({ ...w, d: shiftPath(w.d, dx, dy), ...(w.label ? { label: { ...w.label, x: w.label.x + dx, y: w.label.y + dy } } : {}) });
  }
  for (const f of b.frames) into.frames.push({ ...f, x: f.x + dx, y: f.y + dy });
  for (const r of b.rects) into.rects.push({ x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy });
  into.top = Math.min(into.top, b.top + dy);
  into.bottom = Math.max(into.bottom, b.bottom + dy);
  return {
    outs: b.outs.map((p) => ({ x: p.x + dx, y: p.y + dy })),
    escapes: b.escapes.map((p) => ({ x: p.x + dx, y: p.y + dy })),
  };
}

/** Runs every open end out to the block's right edge, so the next wire only crosses the gap. */
function extend(b: Block, ends: Pt[]): Pt[] {
  return ends.map((p) => {
    if (p.x < b.w) {
      b.wires.push({ d: `M${p.x} ${p.y}H${b.w}`, tone: "main" });
      b.rects.push({ x0: p.x, x1: b.w, y0: p.y - 10, y1: p.y + 10 });
    }
    return { x: b.w, y: p.y };
  });
}

/** Two blocks with a wire between: one thing, then the next. */
function chainAll(a: Block, b: Block): Block {
  if (b.nodes.length === 0) return a;
  if (a.nodes.length === 0 && a.escapes.length === 0) return b;
  const out = blank(a.first);
  const ma = place(out, a, 0, 0);
  const x = a.w + GAP;
  for (const e of ma.outs) out.wires.push({ d: curve(e, { x, y: 0 }), tone: "main", ...(b.first !== undefined ? { to: b.first } : {}) });
  const mb = place(out, b, x, 0);
  out.w = x + b.w;
  out.outs = mb.outs;
  out.escapes = [...ma.escapes, ...mb.escapes];
  return out;
}

/**
 * How far down `b`, drawn from x, has to go to clear everything in `taken`
 * — only what it would actually overlap counts, so a side stacks right
 * under the line wherever the line above it is only nodes, and goes lower
 * only where something above already dips down.
 */
function clearance(taken: Rect[], b: Rect[], x: number): number {
  let dy = -Infinity;
  for (const r of b) {
    for (const q of taken) {
      if (r.x0 + x < q.x1 && r.x1 + x > q.x0) dy = Math.max(dy, q.y1 + VGAP - r.y0);
    }
  }
  return dy;
}

/* --------------------------------------------------------------- layout */

class Builder {
  private next = 0;

  node(card: Card, shape: Placed["shape"], outs: Port[], h = shape === "round" ? TW : NH): Block {
    const w = shape === "round" ? TW : NW;
    const id = this.next++;
    const top = -h / 2 - ABOVE;
    const bottom = h / 2 + BELOW;
    return {
      ...blank(id),
      w,
      top,
      bottom,
      outs: card.kind === "end" || card.kind === "done" ? [] : [{ x: w, y: 0 }],
      nodes: [{ id, card, x: 0, y: 0, w, h, shape, outs }],
      rects: [{ x0: w / 2 - LABEL / 2, x1: w / 2 + LABEL / 2, y0: top, y1: bottom }],
    };
  }

  seq(list: FlowNode[]): Block {
    return this.items(foldGates(list));
  }

  /**
   * A list of nodes, one after another along the line.
   *
   * A check one of whose sides stops — `if (x) { …; return }`, the guard
   * clause, which is most of the checks in these workflows — does not wait
   * for that side to finish before the line carries on: the rest of the list
   * becomes the check's other side, so it continues straight on from the IF
   * node and the side that stops is tucked in underneath. Drawn the plain
   * way, the line waits for the longest side, and one big guard clause
   * leaves a wire running across the whole canvas with nothing on it.
   */
  private items(items: Item[]): Block {
    if (items.length === 0) return empty();
    const out = blank();
    let ends: Pt[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      let b: Block;
      let rest = false;
      if (!("gates" in item) && item.kind === "branch") {
        const yes = this.seq(item.body);
        const no = this.seq(item.else);
        const after = items.slice(i + 1);
        if (after.length > 0 && yes.outs.length === 0 && no.outs.length > 0) {
          b = this.fork(
            { kind: "if", node: item },
            [
              { label: "true", block: yes },
              { label: "false", block: chainAll(no, this.items(after)) },
            ],
            1,
          );
          rest = true;
        } else if (after.length > 0 && no.outs.length === 0 && yes.outs.length > 0 && no.nodes.length > 0) {
          b = this.fork(
            { kind: "if", node: item },
            [
              { label: "true", block: chainAll(yes, this.items(after)) },
              { label: "false", block: no },
            ],
            0,
          );
          rest = true;
        } else {
          b = this.fork({ kind: "if", node: item }, [
            { label: "true", block: yes },
            { label: "false", block: no },
          ]);
        }
      } else {
        b = this.item(item);
      }
      const x = i === 0 ? 0 : out.w + GAP;
      for (const e of ends) out.wires.push({ d: curve(e, { x, y: 0 }), tone: "main", ...(b.first !== undefined ? { to: b.first } : {}) });
      if (i === 0 && b.first !== undefined) out.first = b.first;
      const moved = place(out, b, x, 0);
      out.w = x + b.w;
      ends = moved.outs;
      out.escapes.push(...moved.escapes);
      if (rest) break;
    }
    out.outs = ends;
    return out;
  }

  private item(item: Item): Block {
    if ("gates" in item) {
      return this.node({ kind: "filter", gates: item.gates }, "box", [{ dy: 0, label: "passes" }]);
    }
    const n = item;
    switch (n.kind) {
      case "step": {
        const head = this.node({ kind: "node", node: n }, "box", [{ dy: 0 }]);
        if (!framed(n) || !n.body) return head;
        return chainAll(head, this.frame(this.seq(n.body), { label: `inside “${n.label}”`, kind: "step" }));
      }
      case "action":
      case "run":
        return this.node({ kind: "node", node: n }, "box", [{ dy: 0 }]);
      case "end": {
        const b = this.node({ kind: "end", node: n }, "round", []);
        // A return from a helper or a step callback leaves that, not the run:
        // the flow carries on after the frame it is in.
        if ((n.helper || n.step) && !n.throws) b.escapes = [{ x: b.w, y: 0 }];
        return b;
      }
      case "helper":
        return this.frame(this.seq(n.body), { label: `${n.name}()`, ...(n.doc ? { doc: n.doc } : {}), kind: "helper" });
      case "branch":
        return this.fork({ kind: "if", node: n }, [
          { label: "true", block: this.seq(n.body) },
          { label: "false", block: this.seq(n.else) },
        ]);
      case "switch": {
        const sides = n.cases.map((c) => ({ label: short(c.label), block: this.seq(c.body) }));
        // Without a default, a value no case names falls through to what comes next.
        if (!n.cases.some((c) => c.label.split(", ").includes("otherwise"))) {
          sides.push({ label: "other", block: empty() });
        }
        return this.fork({ kind: "switch", node: n }, sides);
      }
      case "loop":
        return this.loop(n);
      case "catch":
        return this.catcher(this.seq(n.body));
    }
  }

  /** A sticky note behind a run of nodes. Returns inside it end here, so escapes become outs. */
  private frame(body: Block, f: Pick<Frame, "label" | "doc" | "kind">): Block {
    const out = { ...blank(body.first), w: body.w + FPX * 2 };
    const m = place(out, body, FPX, 0);
    const top = body.top - FPT;
    const bottom = body.bottom + FPB;
    // The frame goes first so frames nested in it draw over it.
    out.frames.unshift({ ...f, x: 6, y: top, w: out.w - 12, h: bottom - top });
    out.rects.push({ x0: 6, x1: out.w - 6, y0: top, y1: bottom });
    out.top = top;
    out.bottom = bottom;
    out.wires.push({ d: `M0 0H${FPX}`, tone: "main" });
    out.outs = extend(out, [...m.outs, ...m.escapes]);
    return out;
  }

  /**
   * A node with one output per side — IF, Switch. The first side that carries
   * on stays on the main line, unless the caller says which does — the side
   * holding the rest of the code, even when every path in it returns; the
   * rest stack below it, in order, each as high as it fits. The ports are
   * ordered the way the sides are stacked, so no two wires cross at the
   * node — the port labels say which is which.
   */
  private fork(card: Card, sides: { label: string; block: Block }[], main?: number): Block {
    const mainAt = main ?? Math.max(0, sides.findIndex((s) => s.block.outs.length > 0));
    const order = [sides[mainAt]!, ...sides.filter((_, i) => i !== mainAt)];
    const h = Math.max(NH, order.length * 22 + 12);
    const step = order.length > 1 ? Math.min(28, (h - 24) / (order.length - 1)) : 0;
    const ports: Port[] = order.map((s, i) => ({ dy: (i - (order.length - 1) / 2) * step, label: s.label }));
    const head = this.node(card, "box", ports, h);
    const out = blank(head.first);
    place(out, head, 0, 0);
    const x = NW + GAP;
    const ends: Pt[] = [];
    const escapes: Pt[] = [];
    // A side with nothing on it is a lane that extend() runs out to the
    // right edge later; stacking has to treat it as that long already.
    const lanes: Rect[] = [];
    let last = 0;
    order.forEach((s, i) => {
      const own = s.block.nodes.length === 0 ? [{ x0: 0, x1: Infinity, y0: -10, y1: 10 }] : s.block.rects;
      const dy = i === 0 ? 0 : Math.max(last + 44, clearance([...out.rects, ...lanes], own, x));
      out.wires.push({ d: curve({ x: NW, y: ports[i]!.dy }, { x, y: dy }), tone: "main", ...(s.block.first !== undefined ? { to: s.block.first } : {}) });
      if (s.block.nodes.length === 0) lanes.push({ x0: x, x1: Infinity, y0: dy - 10, y1: dy + 10 });
      const m = place(out, s.block, x, dy);
      ends.push(...m.outs);
      escapes.push(...m.escapes);
      last = dy;
    });
    out.w = x + Math.max(0, ...order.map((s) => s.block.w));
    out.outs = extend(out, ends);
    out.escapes = extend(out, escapes);
    return out;
  }

  /**
   * n8n's Loop Over Items: `done` straight on along the line, `loop` down into
   * the body, and a wire from the body's end back round to the Loop node.
   */
  private loop(n: Extract<FlowNode, { kind: "loop" }>): Block {
    const body = this.seq(n.body);
    const head = this.node({ kind: "loop", node: n }, "box", [
      { dy: -14, label: "done" },
      { dy: 14, label: "loop" },
    ]);
    const out = blank(head.first);
    place(out, head, 0, 0);
    const x = NW + GAP;
    const dy = 26 - body.top;
    out.wires.push({ d: curve({ x: NW, y: 14 }, { x, y: dy }), tone: "main", ...(body.first !== undefined ? { to: body.first } : {}) });
    const m = place(out, body, x, dy);
    const right = x + body.w + 26;
    const floor = dy + body.bottom + 8;
    for (const e of m.outs) {
      out.wires.push({
        d: rounded([e, { x: right, y: e.y }, { x: right, y: floor }, { x: -30, y: floor }, { x: -30, y: 0 }, { x: 0, y: 0 }]),
        tone: "back",
        ...(head.first !== undefined ? { to: head.first } : {}),
      });
    }
    out.w = right + 14;
    out.bottom = floor + 12;
    out.rects.push({ x0: -30, x1: out.w, y0: -24, y1: out.bottom });
    out.wires.push({ d: `M${NW} -14H${out.w}`, tone: "main" });
    out.outs = [{ x: out.w, y: -14 }];
    out.escapes = extend(out, m.escapes);
    return out;
  }

  /** `try { … } catch { … }`: the line carries straight on, and a red wire forks down to the catch. */
  private catcher(body: Block): Block {
    const out = { ...blank(), top: -10, bottom: 10 };
    const x = 40;
    const dy = 34 - body.top;
    out.wires.push({
      d: curve({ x: 0, y: 0 }, { x, y: dy }),
      tone: "error",
      label: { x: 8, y: 18, text: "on error" },
      ...(body.first !== undefined ? { to: body.first } : {}),
    });
    const m = place(out, body, x, dy);
    out.w = x + body.w;
    out.wires.push({ d: `M0 0H${out.w}`, tone: "main" });
    out.rects.push({ x0: 0, x1: out.w, y0: -10, y1: 10 });
    out.outs = [{ x: out.w, y: 0 }, ...extend(out, m.outs)];
    out.escapes = extend(out, m.escapes);
    return out;
  }
}

/**
 * Whether a step's inner steps get drawn, in a frame after it. A body of
 * nothing but `ctx.run()`s is already on the node, as "runs …", and a frame
 * around one more node saying the same thing is noise.
 */
export function framed(n: Extract<FlowNode, { kind: "step" }>): boolean {
  return !!n.body && n.body.some((b) => b.kind !== "run" && b.kind !== "end");
}

type Gate = Extract<FlowNode, { kind: "branch" }>;
type Item = FlowNode | { gates: Gate[] };

/**
 * `if (x) return` / `if (x) throw` with nothing else, that stops the run —
 * not one that only leaves a helper, which has somewhere to go.
 */
function isStopGate(n: FlowNode): n is Gate {
  if (n.kind !== "branch" || n.else.length > 0 || n.body.length !== 1) return false;
  const end = n.body[0]!;
  return end.kind === "end" && (end.throws === true || (!end.helper && !end.step));
}

/**
 * Two or more stop-gates in a row are preconditions — the credential is
 * wrong, there is nothing to do — and as a row of IF nodes each with its own
 * dead end they are the widest thing on the canvas and the least about the
 * flow. One Filter node holds them; its panel lists each.
 */
function foldGates(list: FlowNode[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j < list.length && isStopGate(list[j]!)) j++;
    if (j - i >= 2) {
      out.push({ gates: list.slice(i, j) as Gate[] });
      i = j;
    } else {
      out.push(list[i]!);
      i++;
    }
  }
  return out;
}

const short = (s: string) => (s.length > 18 ? `${s.slice(0, 17)}…` : s);

/**
 * The whole canvas: the trigger, then run(), with a Done where the code falls
 * off the end; and the `onFailure` hook as a second line under it, started by
 * an Error Trigger the way n8n draws an error workflow.
 */
export function layoutFlow(nodes: FlowNode[], onFailure: FlowNode[] | null): Layout {
  const b = new Builder();
  const lines: Block[] = [];
  for (const [start, list] of [
    [{ kind: "trigger" } as Card, nodes],
    ...(onFailure && onFailure.length > 0 ? [[{ kind: "error-trigger" } as Card, onFailure] as const] : []),
  ] as const) {
    const line = chainAll(b.node(start, "trigger", [{ dy: 0 }]), b.seq(list));
    // Where the code simply runs out, say so: n8n's line just stops, but a
    // line that stops mid-air here reads as "the drawing is missing a bit".
    lines.push(line.outs.length > 0 ? chainAll(line, b.node({ kind: "done" }, "round", [])) : line);
  }

  const all = blank();
  lines.forEach((line, i) => {
    const dy = i === 0 ? 0 : all.bottom + 70 - line.top;
    place(all, line, 0, dy);
    all.w = Math.max(all.w, line.w);
  });

  const pad = 36;
  const minX = -pad - 40;
  const minY = all.top - pad;
  return {
    nodes: all.nodes,
    wires: all.wires,
    frames: all.frames,
    minX,
    minY,
    width: all.w + pad + 40 - minX,
    height: all.bottom + pad - minY,
    mainY: 0,
  };
}
