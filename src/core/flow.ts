import ts from "typescript";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { LoadedWorkflow } from "./types.ts";

/**
 * Derives a node graph — the n8n view — from a workflow's source.
 *
 * Nothing here runs the workflow or asks the runtime anything: it parses the
 * file with the TypeScript compiler, finds the `run()` handed to
 * `defineWorkflow`, and walks its statements. `ctx.step(...)` becomes a node,
 * a loop or an `if` becomes a group around the nodes inside it, `ctx.run()`
 * becomes an edge to another workflow, and a `return` is where the flow ends.
 * A helper called with `ctx` is followed into — one that contains steps is
 * inlined where it is called, one that only makes calls is folded into the
 * step's "uses" line — so a workflow built by a factory in a `_` file still
 * draws.
 *
 * What it says is what the code *can* do, not what a given run did. That is
 * on purpose and it is the difference from the run page: the run page shows
 * one path through this graph, and this shows every path.
 *
 * It is best effort by construction. Static analysis of arbitrary TypeScript
 * cannot be complete — a step name computed at runtime, a helper reached
 * through a variable, a call behind `Promise.all` — and the failure mode is
 * always *omission* rather than invention: a node that is not drawn, never a
 * node that does not exist. `notes` lists what it could not follow.
 */

/** One thing a node does — an integration call, a state key, a workflow. */
export interface FlowUse {
  /** `http.post`, `telegram.send`, `state.set`, … — the `ctx` path minus `ctx.`. */
  name: string;
  /** A hostname for http, a key for state. Only when it was a literal. */
  target?: string;
  /**
   * The same call in words, for a reader who does not know that
   * `http.patch api.notion.com` is "updates Notion": `verb` is what it does
   * and `service` is what it does it to. See `describeUse()`.
   */
  verb: string;
  service: string;
}

export type FlowNode =
  /**
   * A `ctx.step()`. `doc` is the first sentence of the comment above it.
   * `body` is present when the step's callback has steps of its own — a
   * step that calls a helper full of steps — and holds only those: the plain
   * calls inside are already in `uses`.
   */
  | { kind: "step"; label: string; doc?: string; uses: FlowUse[]; runs: string[]; body?: FlowNode[] }
  /** A `ctx.<client>` call outside any step. */
  | { kind: "action"; label: string; uses: FlowUse[]; runs: string[] }
  /** A `ctx.run()` outside any step — an edge to another workflow. */
  | { kind: "run"; workflow: string }
  /**
   * An `if`. `label` is the condition in words where the shape allowed it
   * ("no stage", "pages is empty"); `code` is the condition as written;
   * `doc` is the first sentence of the comment above it, when there is one.
   */
  | { kind: "branch"; label: string; code: string; doc?: string; body: FlowNode[]; else: FlowNode[] }
  | { kind: "switch"; label: string; cases: { label: string; body: FlowNode[] }[] }
  /** A loop. `label` is "each page in pages" or "while …". */
  | { kind: "loop"; label: string; body: FlowNode[] }
  | { kind: "catch"; label: string; body: FlowNode[] }
  /**
   * A helper that was followed into and had steps of its own: its nodes,
   * boxed under its name. `doc` is the first sentence of its comment.
   */
  | { kind: "helper"; name: string; doc?: string; body: FlowNode[] }
  /**
   * A `return` (or `throw`). In a helper it leaves the helper, not the run;
   * inside a step's callback it ends that step. `helper` names the innermost.
   */
  | { kind: "end"; label: string; helper?: string; step?: string; throws?: boolean };

export interface Flow {
  nodes: FlowNode[];
  /**
   * What a poll trigger's `fetch()` touches — the query that decides whether
   * a run happens at all, which is the first thing the workflow does and the
   * one thing `run()` does not contain. Null for every other trigger.
   */
  poll: { uses: FlowUse[]; runs: string[] } | null;
  /** The `onFailure` hook, walked the same way. Null when there is none. */
  onFailure: FlowNode[] | null;
  /** Every file read, relative to the workflows directory. */
  files: string[];
  /** What the analysis could not follow. Empty is the normal case. */
  notes: string[];
  /** Set when the run() could not be found at all; `nodes` is then empty. */
  error?: string;
}

/* ------------------------------------------------------------------ cache */

interface Cached {
  hash: string;
  stamps: [string, number][];
  flow: Flow;
}

const cache = new Map<string, Cached>();

/**
 * The flow for a workflow, derived once per version of its source. Keyed on
 * the workflow's own hash and on the mtime of every file the derivation read,
 * so an edit to a `_` helper re-derives even though it does not move the
 * workflow's hash — the one place that wart is closed.
 */
export function flowFor(wf: LoadedWorkflow, root = "./workflows"): Flow {
  const hit = cache.get(wf.name);
  if (hit && hit.hash === wf.hash && hit.stamps.every(([f, m]) => mtime(f) === m)) {
    return hit.flow;
  }
  const dir = resolve(root);
  const derivation = derive(resolve(dir, wf.file), dir);
  cache.set(wf.name, {
    hash: wf.hash,
    stamps: derivation.paths.map((p) => [p, mtime(p)]),
    flow: derivation.flow,
  });
  return derivation.flow;
}

/**
 * Workflows whose flow calls `name` with `ctx.run()` — the callers a trigger
 * line cannot show. Derives (and caches) every workflow's flow, which is a
 * few milliseconds each the first time and a map lookup after.
 */
export function callersOf(name: string, workflows: LoadedWorkflow[], root = "./workflows"): string[] {
  return workflows
    .filter((wf) => wf.name !== name && runsWorkflow(flowFor(wf, root).nodes, name))
    .map((wf) => wf.name)
    .sort();
}

function runsWorkflow(nodes: FlowNode[], name: string): boolean {
  return nodes.some((n) => {
    switch (n.kind) {
      case "step":
        return n.runs.includes(name) || (n.body ? runsWorkflow(n.body, name) : false);
      case "action":
        return n.runs.includes(name);
      case "run":
        return n.workflow === name;
      case "branch":
        return runsWorkflow(n.body, name) || runsWorkflow(n.else, name);
      case "switch":
        return n.cases.some((c) => runsWorkflow(c.body, name));
      case "loop":
      case "catch":
      case "helper":
        return runsWorkflow(n.body, name);
      case "end":
        return false;
    }
  });
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/* ---------------------------------------------------------------- modules */

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface Module {
  path: string;
  sf: ts.SourceFile;
  /** Every named function in the file, at any depth. */
  fns: Map<string, FnLike>;
  /** Top-level `const X = <non-function>`; used to resolve a URL constant. */
  consts: Map<string, ts.Expression>;
  /** Named imports from relative modules: local name → where it came from. */
  imports: Map<string, { from: string; name: string }>;
}

class Analysis {
  readonly modules = new Map<string, Module>();
  readonly notes: string[] = [];

  constructor(readonly root: string) {}

  module(path: string): Module | null {
    const known = this.modules.get(path);
    if (known) return known;
    if (!existsSync(path)) return null;

    const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const mod: Module = { path, sf, fns: new Map(), consts: new Map(), imports: new Map() };

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        mod.fns.set(node.name.text, node);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          mod.fns.set(node.name.text, init);
        } else if (node.parent?.parent?.parent === sf) {
          mod.consts.set(node.name.text, init);
        }
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        const named = node.importClause?.namedBindings;
        if (spec.startsWith(".") && named && ts.isNamedImports(named)) {
          const from = resolve(dirname(path), spec);
          for (const el of named.elements) {
            mod.imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    this.modules.set(path, mod);
    return mod;
  }

  /** A function by name, following one relative import if it is not local. */
  fn(mod: Module, name: string): { fn: FnLike; mod: Module } | null {
    const local = mod.fns.get(name);
    if (local) return { fn: local, mod };
    const imported = mod.imports.get(name);
    // Only within the workflows directory: `defineWorkflow` and the
    // integrations are relative imports too, and they are not the flow.
    if (!imported || !imported.from.startsWith(this.root)) return null;
    const other = this.module(imported.from);
    if (!other) return null;
    const fn = other.fns.get(imported.name);
    return fn ? { fn, mod: other } : null;
  }

  note(text: string) {
    if (!this.notes.includes(text)) this.notes.push(text);
  }
}

/* --------------------------------------------------------- the definition */

/**
 * The object literal handed to `defineWorkflow`. Either it is right there in
 * `export default defineWorkflow({...})`, or the default export calls a
 * factory — possibly in another file — and the literal is inside that.
 */
function findDefinition(
  a: Analysis,
  mod: Module,
): { obj: ts.ObjectLiteralExpression; mod: Module } | null {
  const exported = mod.sf.statements.find(
    (s): s is ts.ExportAssignment => ts.isExportAssignment(s) && !s.isExportEquals,
  );
  if (!exported) return null;
  return resolveDefinition(a, mod, exported.expression, 0);
}

function resolveDefinition(
  a: Analysis,
  mod: Module,
  expr: ts.Expression,
  depth: number,
): { obj: ts.ObjectLiteralExpression; mod: Module } | null {
  if (depth > 4) return null;

  if (ts.isCallExpression(expr)) {
    const first = expr.arguments[0];
    if (first && ts.isObjectLiteralExpression(first) && property(first, "run")) {
      return { obj: first, mod };
    }
    if (ts.isIdentifier(expr.expression)) {
      const target = a.fn(mod, expr.expression.text);
      if (target) return definitionInside(a, target.mod, target.fn, depth + 1);
    }
    return null;
  }

  if (ts.isIdentifier(expr)) {
    const target = a.fn(mod, expr.text);
    if (target) return definitionInside(a, target.mod, target.fn, depth + 1);
    const c = mod.consts.get(expr.text);
    if (c) return resolveDefinition(a, mod, c, depth + 1);
    return null;
  }

  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
    return resolveDefinition(a, mod, expr.expression, depth + 1);
  }
  return null;
}

/** The first `something({ ..., run })` call inside a factory's body. */
function definitionInside(
  a: Analysis,
  mod: Module,
  fn: FnLike,
  depth: number,
): { obj: ts.ObjectLiteralExpression; mod: Module } | null {
  let found: { obj: ts.ObjectLiteralExpression; mod: Module } | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const hit = resolveDefinition(a, mod, node, depth);
      if (hit) {
        found = hit;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function property(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);
}

/** The function behind an object property: a method, an arrow, or a name. */
function propertyFn(a: Analysis, mod: Module, obj: ts.ObjectLiteralExpression, name: string): FnLike | null {
  const p = property(obj, name);
  if (!p) return null;
  if (ts.isMethodDeclaration(p)) return p;
  if (ts.isPropertyAssignment(p)) {
    const init = p.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    if (ts.isIdentifier(init)) return a.fn(mod, init.text)?.fn ?? null;
  }
  if (ts.isShorthandPropertyAssignment(p)) return a.fn(mod, p.name.text)?.fn ?? null;
  return null;
}

/* ---------------------------------------------------------------- walking */

/**
 * What the walker knows while inside one function body. `aliases` maps a
 * local name to the `ctx` path it stands for — `ctx` itself, or `http` for a
 * helper that was handed `ctx.http` — which is how a call three helpers down
 * still reads as `http.post`.
 */
interface Scope {
  mod: Module;
  /** The function whose body is being walked. A closure defined inside it shares its aliases. */
  fn: FnLike;
  aliases: Map<string, string>;
  /**
   * Parameters that were handed a URL: `publish(ctx.http, GRAPH_TH, …)`
   * binds `base` to graph.threads.net inside `publish`, so `${base}/${id}`
   * three helpers down still says which service it is.
   */
  hosts: Map<string, string>;
  /** The helper being inlined, or null in the run body itself. */
  helper: string | null;
  /** The step whose callback is being walked, or null outside one. */
  step: string | null;
  depth: number;
  /** Functions on the inlining stack, so recursion stops. */
  stack: Set<ts.Node>;
}

const MAX_DEPTH = 8;
const LABEL_MAX = 72;

function derive(file: string, root: string): { flow: Flow; paths: string[] } {
  const a = new Analysis(root);
  const rel = (p: string) => p.slice(root.length + 1);
  const finish = (flow: Omit<Flow, "files" | "notes" | "poll"> & { poll?: Flow["poll"] }): { flow: Flow; paths: string[] } => {
    const paths = [...a.modules.keys()];
    return { flow: { poll: null, ...flow, files: paths.map(rel), notes: a.notes }, paths };
  };

  let mod: Module | null;
  try {
    mod = a.module(file);
  } catch (err) {
    return finish({ nodes: [], onFailure: null, error: `could not parse: ${String(err)}` });
  }
  if (!mod) return finish({ nodes: [], onFailure: null, error: "file not found" });

  const def = findDefinition(a, mod);
  if (!def) {
    return finish({
      nodes: [],
      onFailure: null,
      error: "could not find the defineWorkflow({ run }) behind the default export",
    });
  }

  const run = propertyFn(a, def.mod, def.obj, "run");
  if (!run) return finish({ nodes: [], onFailure: null, error: "the definition has no run()" });

  const nodes = walkFunction(a, def.mod, run, aliasesFor(run), null, 0, new Set());
  const failure = propertyFn(a, def.mod, def.obj, "onFailure");
  const onFailure = failure
    ? walkFunction(a, def.mod, failure, aliasesFor(failure), null, 0, new Set())
    : null;

  return finish({ nodes, onFailure, poll: pollFetch(a, def.mod, def.obj) });
}

/**
 * The `fetch()` inside `trigger: poll(expr, { fetch })`, summarised the way
 * a step's callback is. It is not walked into nodes: what it decides is
 * whether there is a run, and the graph starts at the trigger either way —
 * but *what it asks* is the answer to "new what, from where?".
 */
function pollFetch(a: Analysis, mod: Module, def: ts.ObjectLiteralExpression): Flow["poll"] {
  const trigger = property(def, "trigger");
  if (!trigger || !ts.isPropertyAssignment(trigger)) return null;
  let call: ts.Expression = trigger.initializer;
  while (ts.isAsExpression(call) || ts.isParenthesizedExpression(call) || ts.isSatisfiesExpression(call)) {
    call = call.expression;
  }
  if (!ts.isCallExpression(call)) return null;
  const opts = call.arguments.find(ts.isObjectLiteralExpression);
  if (!opts || !property(opts, "fetch")) return null;
  const fetch = propertyFn(a, mod, opts, "fetch");
  if (!fetch) return null;
  const scope: Scope = {
    mod,
    fn: fetch,
    aliases: aliasesFor(fetch),
    hosts: new Map(),
    helper: null,
    step: null,
    depth: 0,
    stack: new Set([fetch]),
  };
  return summarise(a, scope, fetch);
}

/** `run(ctx)` → ctx is ctx; `run({ step, http })` → each name is a path. */
function aliasesFor(fn: FnLike): Map<string, string> {
  const aliases = new Map<string, string>();
  const first = fn.parameters[0];
  if (!first) return aliases;
  if (ts.isIdentifier(first.name)) {
    aliases.set(first.name.text, "ctx");
  } else if (ts.isObjectBindingPattern(first.name)) {
    for (const el of first.name.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      aliases.set(el.name.text, `ctx.${prop}`);
    }
  }
  return aliases;
}

function walkFunction(
  a: Analysis,
  mod: Module,
  fn: FnLike,
  aliases: Map<string, string>,
  helper: string | null,
  depth: number,
  stack: Set<ts.Node>,
  step: string | null = null,
  hosts: Map<string, string> = new Map(),
): FlowNode[] {
  const scope: Scope = { mod, fn, aliases, hosts, helper, step, depth, stack: new Set(stack).add(fn) };
  const out: FlowNode[] = [];
  if (!fn.body) return out;
  if (ts.isBlock(fn.body)) {
    walkStatements(a, scope, fn.body.statements, out, true);
  } else {
    visitExpression(a, scope, fn.body, out);
  }
  return out;
}

function walkStatements(
  a: Analysis,
  scope: Scope,
  statements: readonly ts.Statement[],
  out: FlowNode[],
  isBody: boolean,
) {
  statements.forEach((st, i) => {
    // A helper's own final `return` is the helper handing its value back, not
    // a place the flow stops — and a step callback's is the step's result.
    // The run body's final return is the output.
    const tail = isBody && (scope.helper !== null || scope.step !== null) && i === statements.length - 1;
    if (tail && ts.isReturnStatement(st)) {
      visitExpression(a, scope, st, out);
      return;
    }
    // `try { …; return x } catch { return y }` as the last statement is the
    // same shape wearing a try: the return in the try block is the tail.
    if (tail && ts.isTryStatement(st)) {
      walkStatements(a, scope, st.tryBlock.statements, out, true);
      if (st.catchClause) {
        const body = walkStatements2(a, scope, st.catchClause.block.statements);
        if (body.length) out.push({ kind: "catch", label: "if that fails", body });
      }
      if (st.finallyBlock) walkStatements(a, scope, st.finallyBlock.statements, out, false);
      return;
    }
    walkStatement(a, scope, st, out);
  });
}

function walkStatement(a: Analysis, scope: Scope, st: ts.Statement, out: FlowNode[]) {
  if (ts.isBlock(st)) {
    walkStatements(a, scope, st.statements, out, false);
    return;
  }

  if (ts.isIfStatement(st)) {
    visitExpression(a, scope, st.expression, out);
    const body = walkInto(a, scope, st.thenStatement);
    const alt = st.elseStatement ? walkInto(a, scope, st.elseStatement) : [];
    if (body.length || alt.length) {
      const doc = docOf(scope, st);
      out.push({
        kind: "branch",
        label: describe(scope, st.expression),
        code: text(scope, st.expression),
        ...(doc ? { doc } : {}),
        body,
        else: alt,
      });
    }
    return;
  }

  if (ts.isForOfStatement(st) || ts.isForInStatement(st)) {
    visitExpression(a, scope, st.expression, out);
    const body = walkInto(a, scope, st.statement);
    if (body.length) {
      const item = ts.isVariableDeclarationList(st.initializer)
        ? text(scope, st.initializer.declarations[0]?.name ?? st.initializer)
        : text(scope, st.initializer);
      const over = text(scope, st.expression);
      out.push({ kind: "loop", label: ts.isForOfStatement(st) ? `each ${item} in ${over}` : `each key in ${over}`, body });
    }
    return;
  }

  if (ts.isForStatement(st) || ts.isWhileStatement(st) || ts.isDoStatement(st)) {
    const body = walkInto(a, scope, st.statement);
    if (body.length) {
      const cond = ts.isForStatement(st) ? st.condition : st.expression;
      out.push({ kind: "loop", label: cond ? `while ${text(scope, cond)}` : "loop", body });
    }
    return;
  }

  if (ts.isTryStatement(st)) {
    walkStatements(a, scope, st.tryBlock.statements, out, false);
    if (st.catchClause) {
      const body = walkStatements2(a, scope, st.catchClause.block.statements);
      if (body.length) out.push({ kind: "catch", label: "if that fails", body });
    }
    if (st.finallyBlock) walkStatements(a, scope, st.finallyBlock.statements, out, false);
    return;
  }

  if (ts.isSwitchStatement(st)) {
    visitExpression(a, scope, st.expression, out);
    const cases: { label: string; body: FlowNode[] }[] = [];
    let pending: string[] = [];
    for (const clause of st.caseBlock.clauses) {
      pending.push(ts.isCaseClause(clause) ? text(scope, clause.expression) : "otherwise");
      const body = walkStatements2(a, scope, clause.statements);
      // A clause with no statements falls through: its label joins the next.
      if (clause.statements.length === 0) continue;
      if (body.length) cases.push({ label: pending.join(", "), body });
      pending = [];
    }
    if (cases.length) out.push({ kind: "switch", label: `switch ${text(scope, st.expression)}`, cases });
    return;
  }

  if (ts.isReturnStatement(st)) {
    if (st.expression) visitExpression(a, scope, st.expression, out);
    out.push(leaving(scope, returnLabel(scope, st.expression), false));
    return;
  }

  if (ts.isThrowStatement(st)) {
    visitExpression(a, scope, st.expression, out);
    out.push(leaving(scope, throwLabel(scope, st.expression), true));
    return;
  }

  // Everything else — an expression, a const, a labelled statement — is only
  // interesting for the calls inside it.
  visitExpression(a, scope, st, out);
}

/** An `end` node, saying what it leaves: the innermost helper, else the step, else the run. */
function leaving(scope: Scope, label: string, throws: boolean): FlowNode {
  const node: FlowNode = { kind: "end", label };
  if (scope.helper !== null) node.helper = scope.helper;
  else if (scope.step !== null) node.step = scope.step;
  if (throws) node.throws = true;
  return node;
}

function walkInto(a: Analysis, scope: Scope, st: ts.Statement): FlowNode[] {
  const out: FlowNode[] = [];
  walkStatement(a, scope, st, out);
  return out;
}

function walkStatements2(a: Analysis, scope: Scope, statements: readonly ts.Statement[]): FlowNode[] {
  const out: FlowNode[] = [];
  walkStatements(a, scope, statements, out, false);
  return out;
}

/**
 * Finds the calls in an expression, in evaluation order. A `ctx.step` is a
 * node and its callback is summarised rather than walked; a `ctx.run` is an
 * edge; any other `ctx.*` call is an action; a call to a helper we can find
 * is followed. A function *defined* here (`const reply = () => …`) is not
 * walked — it runs when it is called, and the call is what we follow.
 */
function visitExpression(a: Analysis, scope: Scope, node: ts.Node, out: FlowNode[]) {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    // Passed straight to a call — `.map(async (x) => …)`, `Promise.all([…])`
    // — it is as good as run here. Assigned to a name, it is a definition.
    const inline = node.parent && (ts.isCallExpression(node.parent) || ts.isArrayLiteralExpression(node.parent));
    if (!inline) return;
    if (node.body) {
      if (ts.isBlock(node.body)) walkStatements(a, scope, node.body.statements, out, false);
      else visitExpression(a, scope, node.body, out);
    }
    return;
  }

  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const path = pathOf(scope, callee);

    if (path === "ctx.step") {
      // The name and the callback are what matter; the options are not.
      const name = node.arguments[0];
      const fn = node.arguments[1];
      const label = name ? labelOf(scope, name) : "step";
      const summary = fn ? summarise(a, scope, fn) : { uses: [], runs: [] };
      const inner = fn ? stepsInside(a, scope, fn, label) : null;
      const doc = docOf(scope, node) ?? inner?.doc;
      // What the step does *itself*: a call that belongs to one of the
      // steps inside it is drawn there, and drawing it twice says nothing.
      const within = inner ? usesInside(inner.body) : [];
      const own = (u: FlowUse) => !within.some((w) => w.name === u.name && w.target === u.target);
      out.push({
        kind: "step",
        label,
        ...(doc ? { doc } : {}),
        uses: inner ? summary.uses.filter(own) : summary.uses,
        runs: summary.runs,
        ...(inner ? { body: inner.body } : {}),
      });
      return;
    }

    // Arguments first: `foo(await ctx.step(…))` runs the step before foo.
    for (const arg of node.arguments) visitExpression(a, scope, arg, out);
    if (!ts.isIdentifier(callee)) visitExpression(a, scope, callee, out);

    if (path === "ctx.run") {
      out.push({ kind: "run", workflow: literal(scope, node.arguments[0]) ?? "?" });
      return;
    }

    if (path && path.startsWith("ctx.")) {
      const use = useFor(scope, path, node);
      if (use) {
        out.push({ kind: "action", label: use.name, uses: [use], runs: [] });
      }
      return;
    }

    if (ts.isIdentifier(callee)) {
      followHelper(a, scope, callee.text, node, out);
    }
    return;
  }

  ts.forEachChild(node, (child) => visitExpression(a, scope, child, out));
}

/**
 * The steps inside a step's callback — `ctx.step("cross-post", () =>
 * crossPost(ctx, …))` where `crossPost` publishes to each platform in a step
 * of its own. Those are real steps, recorded on the run page under their own
 * names, and a graph that folds them into the outer step's pills disagrees
 * with the run that shows them. Walked like a helper body, then cut down to
 * the steps and the shape around them: a plain call in here is already one
 * of the step's `uses`, and a check that guards nothing but plain calls is
 * the step's own business. Null when there are no steps inside, which is the
 * ordinary step.
 */
function stepsInside(
  a: Analysis,
  scope: Scope,
  fn: ts.Node,
  label: string,
): { body: FlowNode[]; doc?: string } | null {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  if (scope.depth >= MAX_DEPTH) return null;
  // A closure: it sees the caller's names, so it starts from them.
  const nodes = walkFunction(a, scope.mod, fn, new Map(scope.aliases), null, scope.depth + 1, scope.stack, label, new Map(scope.hosts));
  const body = stepsOnly(nodes);
  if (body.length === 0) return null;
  // `() => crossPost(ctx, …)` — the callback is the helper, and a box named
  // after the helper inside a box named after the step says the same thing
  // twice. The helper's comment becomes the step's, if the step has none.
  const only = body[0];
  if (body.length === 1 && only?.kind === "helper") {
    return { body: only.body, ...(only.doc ? { doc: only.doc } : {}) };
  }
  return { body };
}

/** Every use of every step in a list, at any depth. */
function usesInside(nodes: FlowNode[], out: FlowUse[] = []): FlowUse[] {
  for (const n of nodes) {
    switch (n.kind) {
      case "step":
        out.push(...n.uses);
        if (n.body) usesInside(n.body, out);
        break;
      case "action":
        out.push(...n.uses);
        break;
      case "branch":
        usesInside(n.body, out);
        usesInside(n.else, out);
        break;
      case "switch":
        for (const c of n.cases) usesInside(c.body, out);
        break;
      case "loop":
      case "catch":
      case "helper":
        usesInside(n.body, out);
        break;
      case "run":
      case "end":
        break;
    }
  }
  return out;
}

/** The steps in a list and the boxes that hold them; nothing else. */
function stepsOnly(nodes: FlowNode[]): FlowNode[] {
  const out: FlowNode[] = [];
  for (const n of nodes) {
    switch (n.kind) {
      case "step":
      case "run":
      case "end":
        out.push(n);
        break;
      case "action":
        break;
      case "branch": {
        const body = stepsOnly(n.body);
        const alt = stepsOnly(n.else);
        if (body.length || alt.length) out.push({ ...n, body, else: alt });
        break;
      }
      case "switch": {
        const cases = n.cases.map((c) => ({ ...c, body: stepsOnly(c.body) })).filter((c) => c.body.length);
        if (cases.length) out.push({ ...n, cases });
        break;
      }
      case "loop":
      case "catch":
      case "helper": {
        const body = stepsOnly(n.body);
        if (body.length) out.push({ ...n, body });
        break;
      }
    }
  }
  // An `end` on its own is a return from a callback with no steps around it.
  return out.some((n) => n.kind !== "end") ? out : [];
}

/**
 * Inlines a helper at its call site. Only what it produces survives: a helper
 * that turns out to be pure — a formatter with a `switch` of returns — is
 * dropped whole, because a branch made only of "returns from format()" says
 * nothing about the flow.
 */
function followHelper(a: Analysis, scope: Scope, name: string, call: ts.CallExpression, out: FlowNode[]) {
  const target = a.fn(scope.mod, name);
  if (!target) return;
  if (scope.stack.has(target.fn)) return;
  if (scope.depth >= MAX_DEPTH) {
    a.note(`${name}() is nested too deep to follow`);
    return;
  }
  const aliases = aliasesForCall(scope, target.fn, call);
  if (aliases.size === 0) return; // not handed ctx or anything from it: not part of the flow
  const hosts = hostsForCall(scope, target.fn, call);
  const nodes = walkFunction(a, target.mod, target.fn, aliases, name, scope.depth + 1, scope.stack, scope.step, hosts);
  if (!hasWork(nodes)) return;
  const doc = docOf({ ...scope, mod: target.mod }, target.fn);
  out.push({ kind: "helper", name, ...(doc ? { doc } : {}), body: nodes });
}

/**
 * Parameter names bound to the `ctx` paths the caller passed in. A closure —
 * `const reply = (text) => ctx.telegram.send(…)` defined inside the function
 * being walked — was never handed ctx and does not need to be: it sees the
 * caller's names, so it starts from the caller's aliases.
 */
function aliasesForCall(scope: Scope, fn: FnLike, call: ts.CallExpression): Map<string, string> {
  const aliases = within(fn, scope.fn) ? new Map(scope.aliases) : new Map<string, string>();
  fn.parameters.forEach((param, i) => {
    const arg = call.arguments[i];
    if (!arg || !ts.isIdentifier(param.name)) return;
    const path = pathOf(scope, arg);
    if (path) aliases.set(param.name.text, path);
  });
  return aliases;
}

/** Parameters bound to the hostname of the URL the caller passed in. */
function hostsForCall(scope: Scope, fn: FnLike, call: ts.CallExpression): Map<string, string> {
  const hosts = within(fn, scope.fn) ? new Map(scope.hosts) : new Map<string, string>();
  fn.parameters.forEach((param, i) => {
    const arg = call.arguments[i];
    if (!arg || !ts.isIdentifier(param.name)) return;
    const host = hostOf(scope, arg);
    if (host) hosts.set(param.name.text, host);
  });
  return hosts;
}

function within(node: ts.Node, ancestor: ts.Node): boolean {
  return node.getSourceFile() === ancestor.getSourceFile() && node.pos >= ancestor.pos && node.end <= ancestor.end;
}

function hasWork(nodes: FlowNode[]): boolean {
  return nodes.some((n) => {
    switch (n.kind) {
      case "step":
      case "action":
      case "run":
        return true;
      case "branch":
        return hasWork(n.body) || hasWork(n.else);
      case "switch":
        return n.cases.some((c) => hasWork(c.body));
      case "loop":
      case "catch":
      case "helper":
        return hasWork(n.body);
      case "end":
        return false;
    }
  });
}

/* ------------------------------------------------------------ summarising */

/**
 * What a step's callback touches: every `ctx.*` call inside it, and inside
 * every helper it calls that we can find, de-duplicated and in order.
 */
function summarise(a: Analysis, scope: Scope, fn: ts.Node): { uses: FlowUse[]; runs: string[] } {
  const uses: FlowUse[] = [];
  const runs: string[] = [];
  collect(a, scope, fn, uses, runs, new Set());
  return { uses, runs };
}

/**
 * `seen` is keyed on the helper *and* the hosts it was handed: `publish(…,
 * GRAPH_FB)` and `publish(…, GRAPH_TH)` are the same function and two
 * different services, and walking it once would lose one of them.
 */
function collect(a: Analysis, scope: Scope, node: ts.Node, uses: FlowUse[], runs: string[], seen: Set<string>) {
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const path = pathOf(scope, n.expression);
      if (path === "ctx.run") {
        const name = literal(scope, n.arguments[0]) ?? "?";
        if (!runs.includes(name)) runs.push(name);
      } else if (path && path.startsWith("ctx.")) {
        const use = useFor(scope, path, n);
        if (use && !uses.some((u) => u.name === use.name && u.target === use.target)) uses.push(use);
      } else if (ts.isIdentifier(n.expression)) {
        const target = a.fn(scope.mod, n.expression.text);
        if (target && !scope.stack.has(target.fn) && seen.size < 32) {
          const aliases = aliasesForCall(scope, target.fn, n);
          const hosts = hostsForCall(scope, target.fn, n);
          const key = `${target.mod.path}:${target.fn.pos}:${[...hosts].join()}`;
          if (aliases.size > 0 && target.fn.body && !seen.has(key)) {
            seen.add(key);
            const inner: Scope = { ...scope, mod: target.mod, fn: target.fn, aliases, hosts };
            collect(a, inner, target.fn.body, uses, runs, seen);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

/** Parts of `ctx` that are not integrations: calling them is not a node. */
const NOT_WORK = new Set(["log", "step", "run", "input", "signal", "meta", "runId", "workflow"]);

/** The use a `ctx.*` call amounts to, or null for the ones that are not work. */
function useFor(scope: Scope, path: string, call: ts.CallExpression): FlowUse | null {
  const parts = path.split(".").slice(1); // drop "ctx"
  const client = parts[0];
  if (!client || NOT_WORK.has(client)) return null;
  // `ctx.http` is also a function in its own right; a bare `ctx.http(...)`
  // and `ctx.http.get(...)` are both http.
  const name = parts.join(".");
  let target: string | undefined;
  const first = call.arguments[0];
  if (client === "http" && first) {
    target = hostOf(scope, first) ?? undefined;
  } else if (client === "state" && first) {
    target = literal(scope, first) ?? undefined;
  } else if (client === "table") {
    // The bare handle is not work; `table.insert` and friends are.
    if (parts.length === 1) return null;
    target = tableNameOf(scope, call) ?? undefined;
  }
  const words = describeUse(name, target);
  return { name, ...(target ? { target } : {}), ...words };
}

/* ---------------------------------------------------------------- in words */

/** A hostname a workflow talks to, and what it is called on the box. */
const SERVICES: [RegExp, string][] = [
  [/(^|\.)notion\.(com|so)$/, "Notion"],
  [/(^|\.)threads\.net$/, "Threads"],
  [/(^|\.)facebook\.com$/, "Facebook / Instagram"],
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)telegram\.org$/, "Telegram"],
  [/(^|\.)slack\.com$/, "Slack"],
  [/(^|\.)discord(app)?\.com$/, "Discord"],
  [/^sheets\.googleapis\.com$/, "Google Sheets"],
  [/(^|\.)googleapis\.com$/, "Google"],
  [/(^|\.)google\.com$/, "Google"],
  [/(^|\.)github\.com$/, "GitHub"],
  [/(^|\.)monday\.com$/, "Monday.com"],
  [/(^|\.)brevo\.com$/, "Brevo"],
  [/(^|\.)openai\.com$/, "OpenAI"],
  [/(^|\.)anthropic\.com$/, "Anthropic"],
  [/(^|\.)whatsapp\.com$/, "WhatsApp"],
  [/(^|\.)tiktok(apis)?\.com$/, "TikTok"],
  [/(^|\.)stripe\.com$/, "Stripe"],
  [/(^|\.)shopify\.com$/, "Shopify"],
  [/(^|\.)airtable\.com$/, "Airtable"],
  [/(^|\.)cloudflare\.com$/, "Cloudflare"],
];

/** What a `ctx.<client>` is, when the client itself names the service. */
const CLIENTS: Record<string, string> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  whatsapp: "WhatsApp",
  monday: "Monday.com",
  email: "email",
  sheets: "Google Sheets",
  drive: "Google Drive",
  s3: "S3/R2 storage",
  sql: "the database",
  ai: "the AI model",
  scrape: "a web page",
  state: "saved state",
  table: "a data table",
};

/** What a method does, as the verb of a short sentence: "updates Notion". */
const VERBS: Record<string, string> = {
  "http.get": "reads",
  "http.post": "sends to",
  "http.put": "updates",
  "http.patch": "updates",
  "http.delete": "deletes from",
  "http.paginate": "reads all of",
  "http": "calls",
  "telegram.send": "messages",
  "telegram.reply": "replies on",
  "telegram.sendPhoto": "sends a photo on",
  "slack.send": "messages",
  "slack.reply": "replies on",
  "discord.send": "messages",
  "whatsapp.text": "messages",
  "whatsapp.template": "sends a template on",
  "email.send": "sends",
  "monday.item": "reads",
  "monday.itemsByName": "searches",
  "monday.fields": "reads",
  "monday.assets": "reads files from",
  "monday.createItem": "adds an item to",
  "monday.setColumn": "updates",
  "monday.query": "queries",
  "ai.claude": "asks",
  "ai.openai": "asks",
  "drive.meta": "reads",
  "sheets.read": "reads",
  "sheets.append": "appends to",
  "sheets.update": "updates",
  "drive.download": "downloads from",
  "drive.upload": "uploads to",
  "s3.put": "uploads to",
  "s3.get": "reads from",
  "s3.delete": "deletes from",
  "state.get": "reads",
  "state.set": "writes",
  "state.delete": "clears",
  "table.insert": "adds a row to",
  "table.update": "updates",
  "table.delete": "deletes from",
  "table.where": "reads",
  "table.find": "reads",
  "table.aggregate": "sums up",
  "scrape.page": "scrapes",
  "scrape.text": "scrapes",
  "scrape.textAll": "scrapes",
  "sql.query": "queries",
};

/**
 * `http.patch` + `api.notion.com` → "updates" + "Notion". The verb comes
 * from the method and the service from the host, or from the client when the
 * client *is* the service (`telegram.send`). A host nobody has named is
 * shown as itself, which is still better than nothing; an http call with no
 * literal host at all is "a URL".
 */
export function describeUse(name: string, target?: string): { verb: string; service: string } {
  const parts = name.split(".");
  const client = parts[0] ?? "";
  const method = parts[parts.length - 1];
  const verb =
    VERBS[name] ??
    (parts.length > 2 ? VERBS[`${client}.${method}`] : undefined) ??
    (client === "ai" ? "asks" : "uses");
  let service: string;
  if (client === "http") {
    service = target ? (SERVICES.find(([re]) => re.test(target))?.[1] ?? target) : "a URL";
  } else if (client === "table" && target) {
    service = `the ${target} table`;
  } else if (client === "state" && target) {
    service = `saved state "${target}"`;
  } else {
    service = CLIENTS[client] ?? client;
  }
  return { verb, service };
}

/* ------------------------------------------------------------------- text */

/** `ctx.http.post` → "ctx.http.post"; `http.post` where http is ctx.http → the same. */
function pathOf(scope: Scope, expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return scope.aliases.get(expr.text) ?? null;
  if (ts.isPropertyAccessExpression(expr)) {
    const base = pathOf(scope, expr.expression);
    return base ? `${base}.${expr.name.text}` : null;
  }
  if (ts.isNonNullExpression(expr) || ts.isParenthesizedExpression(expr)) return pathOf(scope, expr.expression);
  // `ctx.table("expenses").insert(…)` — the handle is a call, and the method
  // on it is the work.
  if (ts.isCallExpression(expr) && pathOf(scope, expr.expression) === "ctx.table") return "ctx.table";
  return null;
}

/** The `"expenses"` in `ctx.table("expenses").insert(…)`, from the outer call. */
function tableNameOf(scope: Scope, call: ts.CallExpression): string | null {
  let e: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isCallExpression(e) ? literal(scope, e.arguments[0]) : null;
}

/** Source text, whitespace collapsed and cut to a label's length. */
function text(scope: Scope, node: ts.Node, max = LABEL_MAX): string {
  const raw = node.getText(scope.mod.sf).replace(/\s+/g, " ").trim();
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/** A step's name: the string, or the template with its holes shown as `{expr}`. */
function labelOf(scope: Scope, node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans.map((s) => `{${text(scope, s.expression, 24)}}${s.literal.text}`).join("")
    );
  }
  return `{${text(scope, node, 40)}}`;
}

/** A string, if the expression is one — directly or through a top-level const. */
function literal(scope: Scope, node: ts.Expression | undefined, depth = 0): string | null {
  if (!node || depth > 2) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const c = scope.mod.consts.get(node.text);
    return c ? literal(scope, c, depth + 1) : null;
  }
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literal(scope, node.expression, depth);
  return null;
}

/** The hostname of a URL argument, when its start is literal enough to have one. */
function hostOf(scope: Scope, node: ts.Expression, depth = 0): string | null {
  if (depth > 2) return null;
  let head: string | null = null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) head = node.text;
  else if (ts.isTemplateExpression(node)) {
    head = node.head.text;
    // `${BASE}/path` — the host is inside the first hole.
    if (head === "" && node.templateSpans[0]) return hostOf(scope, node.templateSpans[0].expression, depth + 1);
  } else if (ts.isIdentifier(node)) {
    const bound = scope.hosts.get(node.text);
    if (bound) return bound;
    const c = scope.mod.consts.get(node.text);
    return c ? hostOf(scope, c, depth + 1) : null;
  } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    // `GRAPH.ig` where `const GRAPH = { ig: "https://…" }`.
    const c = scope.mod.consts.get(node.expression.text);
    if (c && ts.isObjectLiteralExpression(c)) {
      const p = property(c, node.name.text);
      if (p && ts.isPropertyAssignment(p)) return hostOf(scope, p.initializer, depth + 1);
    }
    return null;
  }
  if (!head || !/^https?:\/\//.test(head)) return null;
  const m = head.match(/^https?:\/\/([^/?#]+)/);
  return m?.[1] ?? null;
}

/**
 * A condition in words, for the shapes that have an obvious reading:
 * `!stage` is "no stage", `pages.length === 0` is "pages is empty",
 * `a && b` is "a and b". Anything else is the source, which is at least
 * honest. The reader of the flow is not necessarily the person who wrote the
 * code, and `!outcome.allOk` asks them to parse a bang.
 */
function describe(scope: Scope, expr: ts.Expression): string {
  const d = (e: ts.Expression): string => describe(scope, e);

  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return d(expr.expression);
  }

  const ref = refText(expr);
  if (ref !== null) return cut(ref, 40);

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = expr.operand;
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
      return d(inner.operand);
    }
    const plain = refText(inner);
    if (plain !== null) return `no ${cut(plain, 40)}`;
    return `not ${d(inner)}`;
  }

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const K = ts.SyntaxKind;
    const left = expr.left;
    const right = expr.right;
    const isLength = ts.isPropertyAccessExpression(left) && left.name.text === "length";
    const zero = ts.isNumericLiteral(right) && right.text === "0";
    if (isLength && zero && (op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken)) {
      return `${d((left as ts.PropertyAccessExpression).expression)} is empty`;
    }
    if (isLength && zero && (op === K.GreaterThanToken || op === K.ExclamationEqualsEqualsToken)) {
      return `${d((left as ts.PropertyAccessExpression).expression)} is not empty`;
    }
    const words: Partial<Record<ts.SyntaxKind, string>> = {
      [K.EqualsEqualsEqualsToken]: "is",
      [K.EqualsEqualsToken]: "is",
      [K.ExclamationEqualsEqualsToken]: "is not",
      [K.ExclamationEqualsToken]: "is not",
      [K.AmpersandAmpersandToken]: "and",
      [K.BarBarToken]: "or",
      [K.GreaterThanToken]: ">",
      [K.GreaterThanEqualsToken]: "≥",
      [K.LessThanToken]: "<",
      [K.LessThanEqualsToken]: "≤",
      [K.InKeyword]: "in",
    };
    const word = words[op];
    if (word) return `${d(left)} ${word} ${d(right)}`;
  }

  return text(scope, expr, 48);
}

/**
 * A name or a property chain, with the casts and bangs the type checker
 * wanted taken out: `(error as AlertedError).alerted` is `error.alerted` to
 * anyone reading a diagram. Null for anything that is not a plain reference.
 */
function refText(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return "this";
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr)
  ) {
    return refText(expr.expression);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = refText(expr.expression);
    return base === null ? null : `${base}.${expr.name.text}`;
  }
  if (ts.isElementAccessExpression(expr)) {
    const base = refText(expr.expression);
    const key = expr.argumentExpression;
    const shown = ts.isStringLiteral(key) ? key.text : ts.isNumericLiteral(key) ? key.text : (refText(key) ?? "…");
    return base === null ? null : `${base}[${shown}]`;
  }
  return null;
}

/**
 * The first sentence of the comment above a node — the `//` block or the
 * `/** *\/` — which in this repository is usually the one line that says
 * what the step is for. Found from the statement the node sits in, since a
 * comment attaches to `const x = await ctx.step(…)`, not to the call.
 */
function docOf(scope: Scope, node: ts.Node): string | null {
  let at: ts.Node = node;
  while (at.parent && !ts.isSourceFile(at.parent) && !ts.isBlock(at.parent)) at = at.parent;
  const source = scope.mod.sf.text;
  const ranges = ts.getLeadingCommentRanges(source, at.getFullStart()) ?? [];
  const last = ranges[ranges.length - 1];
  if (!last) return null;
  // Directly above the statement. A comment with a blank line between it and
  // the code is about something else.
  if (/\n[ \t]*\n/.test(source.slice(last.end, at.getStart(scope.mod.sf)))) return null;

  // Each `//` line is its own range; the block is the trailing run of them.
  let first = ranges.length - 1;
  if (last.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    while (first > 0) {
      const prev = ranges[first - 1]!;
      const cur = ranges[first]!;
      if (prev.kind !== last.kind || /\n[ \t]*\n/.test(source.slice(prev.end, cur.pos))) break;
      first--;
    }
  }
  const body = ranges
    .slice(first)
    .map((r) => source.slice(r.pos, r.end))
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, "").replace(/\s*\*\/\s*$/, "").trimEnd())
    .join("\n")
    .trim();
  if (!body || /^[-=—_ ]{4,}/.test(body)) return null;
  // The first paragraph, then its first sentence. A JSDoc `@tag` line is not a sentence.
  const para = body.split(/\n\s*\n/)[0]!.split("\n").filter((l) => !l.startsWith("@")).join(" ").trim();
  const sentence = para.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? para;
  const clean = sentence.replace(/\s+/g, " ").replace(/[`*]/g, "");
  if (clean.length < 8) return null;
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

function returnLabel(scope: Scope, expr: ts.Expression | undefined): string {
  if (!expr) return "return";
  if (ts.isObjectLiteralExpression(expr)) {
    const keys = expr.properties.map((p) =>
      p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "…",
    );
    const shown = keys.slice(0, 6).join(", ") + (keys.length > 6 ? ", …" : "");
    return `return { ${shown} }`;
  }
  return `return ${text(scope, expr, 48)}`;
}

function throwLabel(scope: Scope, expr: ts.Expression): string {
  // `throw new Error("message")` → the message; anything else, the source.
  if (ts.isNewExpression(expr) && expr.arguments?.[0]) {
    const msg = stringish(scope, expr.arguments[0]);
    // The first sentence: a message here says what is wrong and then how to
    // fix it, and the diagram wants the first half.
    if (msg !== null) return `fail: ${cut(msg.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? msg, 140)}`;
  }
  // `throw err` — passing on a failure caught above.
  if (ts.isIdentifier(expr)) return `fail with ${expr.text}`;
  return `fail: ${text(scope, expr, 48)}`;
}

/** A string built from literals, templates and `+` — with holes as `{expr}`. */
function stringish(scope: Scope, node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    return labelOf(scope, node);
  }
  if (ts.isParenthesizedExpression(node)) return stringish(scope, node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringish(scope, node.left);
    const right = stringish(scope, node.right);
    if (left === null && right === null) return null;
    return (left ?? `{${text(scope, node.left, 24)}}`) + (right ?? `{${text(scope, node.right, 24)}}`);
  }
  return null;
}

function cut(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* ------------------------------------------------------------ one run's path */

/** What one run did at one node of the graph. */
export interface RunMark {
  /** Recorded steps that matched this node — more than one inside a loop. */
  count: number;
  failed: number;
  /** Steps reused from an earlier run's checkpoint rather than run again. */
  reused: number;
  /** Total time across the matches, when every match had a duration. */
  ms: number | null;
}

export interface RunStep {
  name: string;
  status: "ok" | "failed";
  duration_ms: number | null;
  /** The run that actually executed it; differs from the run shown when reused. */
  run_id: string;
}

/**
 * Lays one run's recorded steps over the graph, by name. A step node named
 * `lock {page.id}` matches every recorded `lock abc…`; one named `answer`
 * matches `answer` exactly. Each recorded step is spent on the first node in
 * reading order that matches it, so a name two branches share is credited
 * to the first — a known imprecision, and the note under the graph says the
 * match is by name. A node whose label is nothing but a hole (`{label}`)
 * would match everything and so matches nothing.
 */
export interface RunTrace {
  marks: Map<FlowNode, RunMark>;
  /** Recorded steps no node claimed — a name the analyser could only see as `{label}`. */
  unplaced: RunStep[];
}

export function traceRun(flow: Flow, steps: RunStep[], runId: string): RunTrace {
  const marks = new Map<FlowNode, RunMark>();
  const spent = new Set<number>();

  const visit = (nodes: FlowNode[]) => {
    for (const n of nodes) {
      switch (n.kind) {
        case "step": {
          const test = matcher(n.label);
          if (!test) break;
          const mark: RunMark = { count: 0, failed: 0, reused: 0, ms: 0 };
          steps.forEach((s, i) => {
            if (spent.has(i) || !test(s.name)) return;
            spent.add(i);
            mark.count++;
            if (s.status === "failed") mark.failed++;
            if (s.run_id !== runId) mark.reused++;
            if (mark.ms !== null) mark.ms = s.duration_ms === null ? null : mark.ms + s.duration_ms;
          });
          if (mark.count > 0) marks.set(n, mark);
          if (n.body) visit(n.body);
          break;
        }
        case "branch":
          visit(n.body);
          visit(n.else);
          break;
        case "switch":
          for (const c of n.cases) visit(c.body);
          break;
        case "loop":
        case "catch":
        case "helper":
          visit(n.body);
          break;
        case "action":
        case "run":
        case "end":
          break;
      }
    }
  };
  visit(flow.nodes);
  if (flow.onFailure) visit(flow.onFailure);
  return { marks, unplaced: steps.filter((_, i) => !spent.has(i)) };
}

function matcher(label: string): ((name: string) => boolean) | null {
  if (!label.includes("{")) return (name) => name === label;
  const parts = label.split(/\{[^}]*\}/);
  if (parts.every((p) => p.trim() === "")) return null;
  const re = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]+?")}$`);
  return (name) => re.test(name);
}
