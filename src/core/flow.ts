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
}

export type FlowNode =
  /** A `ctx.step()`. `doc` is the first sentence of the comment above it. */
  | { kind: "step"; label: string; doc?: string; uses: FlowUse[]; runs: string[] }
  /** A `ctx.<client>` call outside any step. */
  | { kind: "action"; label: string; uses: FlowUse[]; runs: string[] }
  /** A `ctx.run()` outside any step — an edge to another workflow. */
  | { kind: "run"; workflow: string }
  /**
   * An `if`. `label` is the condition in words where the shape allowed it
   * ("no stage", "pages is empty"); `code` is the condition as written.
   */
  | { kind: "branch"; label: string; code: string; body: FlowNode[]; else: FlowNode[] }
  | { kind: "switch"; label: string; cases: { label: string; body: FlowNode[] }[] }
  /** A loop. `label` is "each page in pages" or "while …". */
  | { kind: "loop"; label: string; body: FlowNode[] }
  | { kind: "catch"; label: string; body: FlowNode[] }
  /**
   * A helper that was followed into and had steps of its own: its nodes,
   * boxed under its name. `doc` is the first sentence of its comment.
   */
  | { kind: "helper"; name: string; doc?: string; body: FlowNode[] }
  /** A `return` (or `throw`). In a helper it leaves the helper, not the run. */
  | { kind: "end"; label: string; helper?: string; throws?: boolean };

export interface Flow {
  nodes: FlowNode[];
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
  /** The helper being inlined, or null in the run body itself. */
  helper: string | null;
  depth: number;
  /** Functions on the inlining stack, so recursion stops. */
  stack: Set<ts.Node>;
}

const MAX_DEPTH = 5;
const LABEL_MAX = 72;

function derive(file: string, root: string): { flow: Flow; paths: string[] } {
  const a = new Analysis(root);
  const rel = (p: string) => p.slice(root.length + 1);
  const finish = (flow: Omit<Flow, "files" | "notes">): { flow: Flow; paths: string[] } => {
    const paths = [...a.modules.keys()];
    return { flow: { ...flow, files: paths.map(rel), notes: a.notes }, paths };
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

  return finish({ nodes, onFailure });
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
): FlowNode[] {
  const scope: Scope = { mod, fn, aliases, helper, depth, stack: new Set(stack).add(fn) };
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
    // a place the flow stops. The run body's final return is the output.
    const tail = isBody && scope.helper !== null && i === statements.length - 1;
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
      out.push({
        kind: "branch",
        label: describe(scope, st.expression),
        code: text(scope, st.expression),
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
    out.push({ kind: "end", label: returnLabel(scope, st.expression), helper: scope.helper ?? undefined });
    return;
  }

  if (ts.isThrowStatement(st)) {
    visitExpression(a, scope, st.expression, out);
    out.push({ kind: "end", label: throwLabel(scope, st.expression), helper: scope.helper ?? undefined, throws: true });
    return;
  }

  // Everything else — an expression, a const, a labelled statement — is only
  // interesting for the calls inside it.
  visitExpression(a, scope, st, out);
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
      const summary = fn ? summarise(a, scope, fn) : { uses: [], runs: [] };
      const doc = docOf(scope, node);
      out.push({
        kind: "step",
        label: name ? labelOf(scope, name) : "step",
        ...(doc ? { doc } : {}),
        uses: summary.uses,
        runs: summary.runs,
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
  const nodes = walkFunction(a, target.mod, target.fn, aliases, name, scope.depth + 1, scope.stack);
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

function collect(a: Analysis, scope: Scope, node: ts.Node, uses: FlowUse[], runs: string[], seen: Set<ts.Node>) {
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
        if (target && !seen.has(target.fn) && !scope.stack.has(target.fn) && seen.size < 24) {
          const aliases = aliasesForCall(scope, target.fn, n);
          if (aliases.size > 0 && target.fn.body) {
            seen.add(target.fn);
            const inner: Scope = { ...scope, mod: target.mod, fn: target.fn, aliases };
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
  const use: FlowUse = { name };
  const first = call.arguments[0];
  if (client === "http" && first) {
    const host = hostOf(scope, first);
    if (host) use.target = host;
  } else if (client === "state" && first) {
    const key = literal(scope, first);
    if (key) use.target = key;
  } else if (client === "table") {
    // The bare handle is not work; `table.insert` and friends are.
    if (parts.length === 1) return null;
    const table = tableNameOf(scope, call);
    if (table) use.target = table;
  }
  return use;
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
  const plain = (e: ts.Expression) =>
    ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e);

  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return d(expr.expression);
  }

  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = expr.operand;
    if (ts.isPrefixUnaryExpression(inner) && inner.operator === ts.SyntaxKind.ExclamationToken) {
      return d(inner.operand);
    }
    if (plain(inner)) return `no ${text(scope, inner, 40)}`;
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
      return `${text(scope, (left as ts.PropertyAccessExpression).expression, 40)} is empty`;
    }
    if (isLength && zero && (op === K.GreaterThanToken || op === K.ExclamationEqualsEqualsToken)) {
      return `${text(scope, (left as ts.PropertyAccessExpression).expression, 40)} is not empty`;
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
    if (msg !== null) return `fail: ${cut(msg)}`;
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
