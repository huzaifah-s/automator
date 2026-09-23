import { matcher, type FlowNode, type RunMark, type RunStep } from "../core/flow.ts";

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
  /**
   * The nodes whose output this wire carries — more than one where wires
   * merge before a node — and the node it runs into. A wire is drawn in
   * pieces (a lane, a frame's entry, a curve across a gap); every piece of
   * one connection carries the same ends, so a run lights it whole.
   */
  from: number[];
  to?: number;
  /** Which output of `from` it leaves by, when that node has more than one. */
  port?: number;
  /** Words along it, where no port says what the wire is. */
  label?: { x: number; y: number; text: string };
}

/** One connection between two nodes, for working out the path a run took. */
export interface Link {
  from: number;
  to: number;
  port: number;
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
  links: Link[];
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

/**
 * One connection while it is being built. Its source is known when it is
 * made — a node's output — but where it goes is only known when the block
 * it came out of is wired to the next one, which happens one level up. So
 * both ends are filled in late, and resolved once the canvas is done:
 * `ins` are connections that run into this one without a node between (a
 * wire into a frame, which carries on inside it), `next` is the connection
 * this one runs on into when it reaches a lane rather than a node.
 */
interface Edge {
  from: { id: number; port: number }[];
  ins: Edge[];
  to?: number;
  next?: Edge;
}

const edge = (id?: number, port = 0): Edge => ({ from: id === undefined ? [] : [{ id, port }], ins: [] });

/** A wire as it is drawn: a piece of one connection. */
interface Piece {
  d: string;
  tone: Wire["tone"];
  edge: Edge;
  label?: Wire["label"];
}

/** An open end: where a connection is, and which connection it is. */
interface Pt {
  x: number;
  y: number;
  edge: Edge;
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
  wires: Piece[];
  frames: Frame[];
  /** What is taken, for stacking another block under this one without a collision. */
  rects: Rect[];
  /** The first node of this block — where a wire into it ends. */
  first?: number;
  /** Connections that start at this block's entry, before any node: whatever wires into the block feeds them. */
  entry: Edge[];
  /** Open ends that run straight through from the entry with no node on the way — an empty side of a check. */
  through: Pt[];
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
  entry: [],
  through: [],
  ...(first !== undefined ? { first } : {}),
});

/** A wire between two points, bent into an S with horizontal ends like n8n's. */
function curve(a: { x: number; y: number }, b: { x: number; y: number }): string {
  if (Math.abs(a.y - b.y) < 0.5) return `M${a.x} ${a.y}H${b.x}`;
  const k = Math.max(24, Math.min(80, (b.x - a.x) / 2));
  return `M${a.x} ${a.y}C${a.x + k} ${a.y} ${b.x - k} ${b.y} ${b.x} ${b.y}`;
}

/** A path through right-angled points with rounded corners. For wires that go backwards. */
function rounded(pts: { x: number; y: number }[], r = 12): string {
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
  const p: Pt = { x: 0, y: 0, edge: edge() };
  return { ...blank(), top: -10, bottom: 10, outs: [p], through: [p] };
}

/**
 * Moves `b` by (dx, dy) and adds it to `into`. In place: a block is placed
 * exactly once, and its open ends are the same objects the connections
 * being built hold on to.
 */
function place(into: Block, b: Block, dx: number, dy: number): { outs: Pt[]; escapes: Pt[] } {
  for (const n of b.nodes) {
    n.x += dx;
    n.y += dy;
    into.nodes.push(n);
  }
  for (const w of b.wires) {
    w.d = shiftPath(w.d, dx, dy);
    if (w.label) w.label = { ...w.label, x: w.label.x + dx, y: w.label.y + dy };
    into.wires.push(w);
  }
  for (const f of b.frames) into.frames.push({ ...f, x: f.x + dx, y: f.y + dy });
  for (const r of b.rects) into.rects.push({ x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy });
  for (const p of new Set([...b.outs, ...b.escapes, ...b.through])) {
    p.x += dx;
    p.y += dy;
  }
  into.top = Math.min(into.top, b.top + dy);
  into.bottom = Math.max(into.bottom, b.bottom + dy);
  return { outs: b.outs, escapes: b.escapes };
}

/**
 * Wires open ends into a block whose entry is at `at`: the wire across the
 * gap, and both ends of every connection that now runs into it.
 */
function connect(into: Block, ends: Pt[], at: { x: number; y: number }, b: Block, tone: Wire["tone"] = "main") {
  for (const e of ends) {
    into.wires.push({ d: curve(e, at), tone, edge: e.edge });
    join(e.edge, b);
  }
}

/** `e` now runs into `b`: it ends at b's first node, or carries on through b's empty lane. */
function join(e: Edge, b: Block) {
  if (b.first !== undefined) e.to = b.first;
  else if (b.through[0]) e.next = b.through[0].edge;
  for (const x of b.entry) x.ins.push(e);
  for (const p of b.through) p.edge.ins.push(e);
}

/** Runs every open end out to the block's right edge, so the next wire only crosses the gap. */
function extend(b: Block, ends: Pt[]): Pt[] {
  for (const p of ends) {
    if (p.x < b.w) {
      b.wires.push({ d: `M${p.x} ${p.y}H${b.w}`, tone: "main", edge: p.edge });
      b.rects.push({ x0: p.x, x1: b.w, y0: p.y - 10, y1: p.y + 10 });
      p.x = b.w;
    }
  }
  return ends;
}

/**
 * After `ends` were wired onward, a lane among them no longer runs through
 * to the block's exit — but it still starts at the entry, so what wires in
 * later has to reach it.
 */
function close(out: Block, ends: Pt[]) {
  for (const p of out.through) if (ends.includes(p)) out.entry.push(p.edge);
  out.through = out.through.filter((p) => !ends.includes(p));
}

/** Two blocks with a wire between: one thing, then the next. */
function chainAll(a: Block, b: Block): Block {
  if (b.nodes.length === 0) return a;
  if (a.nodes.length === 0 && a.escapes.length === 0) return b;
  const out = blank(a.first);
  out.entry = a.entry;
  out.through = a.through;
  const ma = place(out, a, 0, 0);
  const x = a.w + GAP;
  connect(out, ma.outs, { x, y: 0 }, b);
  close(out, ma.outs);
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
      outs: card.kind === "end" || card.kind === "done" ? [] : [{ x: w, y: 0, edge: edge(id) }],
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
      if (i === 0) {
        if (b.first !== undefined) out.first = b.first;
        out.entry = b.entry;
        out.through = b.through;
      } else {
        connect(out, ends, { x, y: 0 }, b);
        close(out, ends);
      }
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
        if ((n.helper || n.step) && !n.throws) b.escapes = [{ x: b.w, y: 0, edge: edge(b.first) }];
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
    // The short wire from the frame's edge to its first node is part of
    // whatever wires into the frame.
    const lead = edge();
    out.entry = [lead];
    out.through = body.through;
    out.wires.push({ d: `M0 0H${FPX}`, tone: "main", edge: lead });
    join(lead, body);
    const m = place(out, body, FPX, 0);
    const top = body.top - FPT;
    const bottom = body.bottom + FPB;
    // The frame goes first so frames nested in it draw over it.
    out.frames.unshift({ ...f, x: 6, y: top, w: out.w - 12, h: bottom - top });
    out.rects.push({ x0: 6, x1: out.w - 6, y0: top, y1: bottom });
    out.top = top;
    out.bottom = bottom;
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
      const port: Pt = { x: NW, y: ports[i]!.dy, edge: edge(head.first, i) };
      connect(out, [port], { x, y: dy }, s.block);
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
    connect(out, [{ x: NW, y: 14, edge: edge(head.first, 1) }], { x, y: dy }, body);
    const m = place(out, body, x, dy);
    const right = x + body.w + 26;
    const floor = dy + body.bottom + 8;
    for (const e of m.outs) {
      out.wires.push({
        d: rounded([e, { x: right, y: e.y }, { x: right, y: floor }, { x: -30, y: floor }, { x: -30, y: 0 }, { x: 0, y: 0 }]),
        tone: "back",
        edge: e.edge,
      });
      e.edge.to = head.first;
    }
    out.w = right + 14;
    out.bottom = floor + 12;
    out.rects.push({ x0: -30, x1: out.w, y0: -24, y1: out.bottom });
    const done: Pt = { x: out.w, y: -14, edge: edge(head.first, 0) };
    out.wires.push({ d: `M${NW} -14H${out.w}`, tone: "main", edge: done.edge });
    out.outs = [done];
    out.escapes = extend(out, m.escapes);
    return out;
  }

  /** `try { … } catch { … }`: the line carries straight on, and a red wire forks down to the catch. */
  private catcher(body: Block): Block {
    const out = { ...blank(), top: -10, bottom: 10 };
    const x = 40;
    const dy = 34 - body.top;
    const fault = edge();
    out.wires.push({ d: curve({ x: 0, y: 0 }, { x, y: dy }), tone: "error", edge: fault, label: { x: 8, y: 18, text: "on error" } });
    join(fault, body);
    const m = place(out, body, x, dy);
    out.w = x + body.w;
    const straight: Pt = { x: out.w, y: 0, edge: edge() };
    out.wires.push({ d: `M0 0H${out.w}`, tone: "main", edge: straight.edge });
    out.rects.push({ x0: 0, x1: out.w, y0: -10, y1: 10 });
    out.entry = [fault];
    out.through = [straight];
    out.outs = [straight, ...extend(out, m.outs)];
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

  // Every connection's two ends, now that everything is wired.
  const ends = new Map<Edge, { from: { id: number; port: number }[]; to: number | undefined }>();
  const resolve = (e: Edge) => {
    const hit = ends.get(e);
    if (hit) return hit;
    const seen = new Set<Edge>();
    const from: { id: number; port: number }[] = [];
    const gather = (x: Edge) => {
      if (seen.has(x)) return;
      seen.add(x);
      from.push(...x.from);
      x.ins.forEach(gather);
    };
    gather(e);
    let to = e.to;
    for (let x: Edge | undefined = e, hops = 0; to === undefined && x && hops < 64; x = x.next, hops++) to = x.to;
    const r = { from, to };
    ends.set(e, r);
    return r;
  };
  const wires: Wire[] = all.wires.map((w) => {
    const r = resolve(w.edge);
    const ports = new Set(r.from.map((f) => f.port));
    return {
      d: w.d,
      tone: w.tone,
      from: [...new Set(r.from.map((f) => f.id))],
      ...(r.to !== undefined ? { to: r.to } : {}),
      ...(ports.size === 1 ? { port: [...ports][0]! } : {}),
      ...(w.label ? { label: w.label } : {}),
    };
  });
  const links = new Map<string, Link>();
  for (const w of all.wires) {
    const r = resolve(w.edge);
    if (r.to === undefined) continue;
    for (const f of r.from) links.set(`${f.id}:${f.port}:${r.to}`, { from: f.id, to: r.to, port: f.port });
  }

  const pad = 36;
  const minX = -pad - 40;
  const minY = all.top - pad;
  return {
    nodes: all.nodes,
    wires,
    links: [...links.values()],
    frames: all.frames,
    minX,
    minY,
    width: all.w + pad + 40 - minX,
    height: all.bottom + pad - minY,
    mainY: 0,
  };
}

/* -------------------------------------------------------- one run's path */

/**
 * Every node one run went through, and which wires it went along.
 *
 * Only a `ctx.step()` leaves a record, so a run says outright that it
 * passed "read the order" and "notify teacher" and nothing about the IF
 * between them, the Filter before them, or the Done it ended on. Those are
 * worked out from the canvas's own wiring:
 *
 * - A node is on the path when it lies between the trigger and a step that
 *   ran, on a route that passes no step that did not run — an IF whose
 *   `false` side leads to a step that ran was decided, and went `false`.
 * - After the last step that ran, the run carried on to exactly one end —
 *   a Done when it succeeded, a Fail when it failed without a step failing.
 *   If only one end is reachable from where the record stops, without
 *   passing a step that did not run, the way there is on the path too. If
 *   more than one is — two sides of a check that both only return — nothing
 *   past the record is lit, because which one it was is not known.
 *
 * `ran` is the step nodes the run recorded, true where one failed. A wire is
 * lit when both its ends are on the path; out of an IF, only the side the
 * run took.
 */
export function runPath(
  layout: Layout,
  ran: Map<number, boolean>,
  status: "running" | "success" | "failed" | "skipped" | string,
): { nodes: Set<number>; wires: Set<Wire> } {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const isStep = (id: number) => {
    const c = byId.get(id)?.card;
    return c?.kind === "node" && c.node.kind === "step";
  };
  const decides = (id: number) => {
    const k = byId.get(id)?.card.kind;
    return k === "if" || k === "switch" || k === "loop";
  };
  const can = (id: number) => !isStep(id) || ran.has(id);
  const succ = new Map<number, Link[]>();
  const pred = new Map<number, Link[]>();
  for (const l of layout.links) {
    (succ.get(l.from) ?? succ.set(l.from, []).get(l.from)!).push(l);
    (pred.get(l.to) ?? pred.set(l.to, []).get(l.to)!).push(l);
  }
  const walk = (start: number[], next: (id: number) => number[]) => {
    const seen = new Set(start);
    const queue = [...start];
    while (queue.length > 0) {
      for (const n of next(queue.shift()!)) {
        if (!seen.has(n) && can(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen;
  };

  const trigger = layout.nodes.find((n) => n.card.kind === "trigger")!.id;
  const starts = [trigger];
  // The failure hook runs after a failed run's last retry.
  const hook = layout.nodes.find((n) => n.card.kind === "error-trigger");
  if (hook && status === "failed") starts.push(hook.id);
  const forward = walk(starts, (id) => (succ.get(id) ?? []).map((l) => l.to));
  const back = walk(
    [...ran.keys()],
    (id) => (pred.get(id) ?? []).map((l) => l.from),
  );
  const path = new Set([...forward].filter((id) => back.has(id)));
  for (const s of starts) path.add(s);

  // Past the last record: to the one end the run can have finished on.
  const failedStep = [...ran.values()].some(Boolean);
  if ((status === "success" || status === "failed") && !failedStep) {
    const wanted = (id: number) => {
      const c = byId.get(id)?.card;
      if (!c) return false;
      if (status === "success") return c.kind === "done" || (c.kind === "end" && !c.node.throws && !c.node.helper && !c.node.step);
      return c.kind === "end" && c.node.throws === true;
    };
    const onward = (id: number): number[] => {
      const out = succ.get(id) ?? [];
      // A decision the run is known to have taken one side of took that side.
      if (path.has(id) && decides(id)) {
        const k = byId.get(id)!.card.kind;
        if (k === "loop") return out.filter((l) => l.port === 0).map((l) => l.to);
        if (out.some((l) => path.has(l.to))) return [];
      }
      return out.map((l) => l.to);
    };
    const seen = new Set<number>(path);
    const came = new Map<number, number[]>();
    const queue = [...path];
    const found = new Set<number>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const n of onward(id)) {
        if (path.has(n) || isStep(n)) continue;
        (came.get(n) ?? came.set(n, []).get(n)!).push(id);
        if (seen.has(n)) continue;
        seen.add(n);
        if (wanted(n)) found.add(n);
        queue.push(n);
      }
    }
    if (found.size === 1) {
      const stack = [...found];
      while (stack.length > 0) {
        const n = stack.pop()!;
        if (path.has(n)) continue;
        path.add(n);
        stack.push(...(came.get(n) ?? []));
      }
    }
  }

  const wires = new Set<Wire>();
  for (const w of layout.wires) {
    if (w.to === undefined || !path.has(w.to)) continue;
    const from = w.from.filter((f) => path.has(f));
    if (from.length === 0) continue;
    // Out of a decision, a side is lit only when nothing else on the path
    // runs into the node it reaches — a lane that meets the other side
    // again is not proof the run went along it.
    const lit = from.some((f) => {
      if (!decides(f)) return true;
      const others = (pred.get(w.to!) ?? []).filter((l) => path.has(l.from) && !(l.from === f && l.port === w.port));
      return others.length === 0 || (w.port !== undefined && byId.get(f)?.card.kind === "loop" && w.port === 1);
    });
    if (lit) wires.add(w);
  }
  return { nodes: path, wires };
}

/**
 * Which node each recorded step of one run belongs to.
 *
 * By name, like `traceRun()` — but a name can be on more than one node:
 * `remember what we sent` is in `remember()`, and `remember()` is called on
 * two different lines. `traceRun()` has only the tree and credits the first
 * in reading order, which lit the wrong line whenever the run took the
 * other. Here the wires are known and the steps are in the order they were
 * recorded, so a name that matches several nodes goes to the one the wires
 * reach soonest from the node of the step recorded before it.
 */
export function placeRun(layout: Layout, steps: RunStep[], runId: string): Map<number, RunMark> {
  const tests: { id: number; test: (name: string) => boolean }[] = [];
  for (const p of layout.nodes) {
    if (p.card.kind !== "node" || p.card.node.kind !== "step") continue;
    const test = matcher(p.card.node.label);
    if (test) tests.push({ id: p.id, test });
  }
  const succ = new Map<number, number[]>();
  for (const l of layout.links) (succ.get(l.from) ?? succ.set(l.from, []).get(l.from)!).push(l.to);
  const distances = new Map<number, Map<number, number>>();
  const from = (start: number) => {
    const hit = distances.get(start);
    if (hit) return hit;
    const dist = new Map([[start, 0]]);
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const n of succ.get(id) ?? []) {
        if (dist.has(n)) continue;
        dist.set(n, dist.get(id)! + 1);
        queue.push(n);
      }
    }
    distances.set(start, dist);
    return dist;
  };

  const marks = new Map<number, RunMark>();
  let at = layout.nodes.find((n) => n.card.kind === "trigger")!.id;
  for (const s of steps) {
    const hits = tests.filter((t) => t.test(s.name)).map((t) => t.id);
    if (hits.length === 0) continue;
    const dist = from(at);
    // Ties, and no route at all, fall back to reading order — ids are.
    const id = hits.reduce((best, h) => ((dist.get(h) ?? Infinity) < (dist.get(best) ?? Infinity) ? h : best));
    const mark = marks.get(id) ?? { count: 0, failed: 0, reused: 0, ms: 0 };
    mark.count++;
    if (s.status === "failed") mark.failed++;
    if (s.run_id !== runId) mark.reused++;
    if (mark.ms !== null) mark.ms = s.duration_ms === null ? null : mark.ms + s.duration_ms;
    marks.set(id, mark);
    at = id;
  }
  return marks;
}
