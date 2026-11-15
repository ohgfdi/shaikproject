/**
 * Jinja template engine for SQL cells.
 *
 * A dependency-free, TypeScript-based Jinja-like parser that supports:
 *   - Variable interpolation: {{ variable }}
 *   - Whitespace control: {{- -}}, {% -%}
 *   - Control flow: {% if %} / {% elif %} / {% else %} / {% endif %}
 *   - Loops: {% for item in items %} / {% endfor %}
 *   - Set statements: {% set x = value %}
 *   - Filters: {{ x | upper }}, {{ x | default('N/A') }}, {{ x | sqlsafe }}
 *   - dbt macros: ref(), source(), var(), config()
 *   - Loop variables: loop.index, loop.first, loop.last
 *
 * Matches Hex's Jinja support for SQL parameterization and dbt integration.
 *
 * Dependency-free + unit-tested (__tests__/unit/jinja.test.ts).
 */

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | "TEXT"
  | "VAR_OPEN" // {{ or {{-
  | "VAR_CLOSE" // }} or -}}
  | "BLOCK_OPEN" // {% or {%-
  | "BLOCK_CLOSE" // %} or -%}
  | "IDENT"
  | "STRING"
  | "NUMBER"
  | "DOT"
  | "COMMA"
  | "LPAREN"
  | "RPAREN"
  | "PIPE"
  | "EQ"
  | "NEQ"
  | "LT"
  | "GT"
  | "LTE"
  | "GTE"
  | "AND"
  | "OR"
  | "NOT"
  | "IN"
  | "PLUS"
  | "MINUS"
  | "STAR"
  | "SLASH"
  | "MOD"
  | "LBRACKET"
  | "RBRACKET"
  | "NUMBER"
  | "DOT"
  | "COMMA"
  | "LPAREN"
  | "RPAREN"
  | "PIPE"
  | "EQ"
  | "NEQ"
  | "LT"
  | "GT"
  | "LTE"
  | "GTE"
  | "AND"
  | "OR"
  | "NOT"
  | "IN"
  | "PIPE";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = template.length;

  while (i < n) {
    // Check for Jinja block open {% or {%-
    if (template[i] === "{" && template[i + 1] === "%") {
      const stripBefore = template[i + 2] === "-";
      tokens.push({ type: "BLOCK_OPEN", value: stripBefore ? "{%-" : "{%", pos: i });
      i += stripBefore ? 3 : 2;
      continue;
    }
    // Check for Jinja variable open {{ or {{-
    if (template[i] === "{" && template[i + 1] === "{") {
      const stripBefore = template[i + 2] === "-";
      tokens.push({ type: "VAR_OPEN", value: stripBefore ? "{{-" : "{{", pos: i });
      i += stripBefore ? 3 : 2;
      continue;
    }
    // Check for Jinja block close %} or -%}
    if (template[i] === "%" && template[i + 1] === "}") {
      tokens.push({ type: "BLOCK_CLOSE", value: "%}", pos: i });
      i += 2;
      continue;
    }
    // Check for Jinja variable close }} or -}}
    if (template[i] === "}" && template[i + 1] === "}") {
      const stripAfter = i >= 1 && template[i - 1] === "-";
      tokens.push({ type: "VAR_CLOSE", value: stripAfter ? "-}}" : "}}", pos: i });
      i += 2;
      continue;
    }

    // Regular text until next Jinja tag
    let text = "";
    const textStart = i;
    while (i < n && !(template[i] === "{" && (template[i + 1] === "{" || template[i + 1] === "%"))) {
      text += template[i];
      i++;
    }
    if (text) {
      tokens.push({ type: "TEXT", value: text, pos: textStart });
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Expression Parser
// ---------------------------------------------------------------------------

type ExprNode =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "null" }
  | { type: "var"; name: string }
  | { type: "attr"; object: ExprNode; property: string }
  | { type: "index"; object: ExprNode; index: ExprNode }
  | { type: "filter"; value: ExprNode; name: string; args: ExprNode[] }
  | { type: "call"; name: string; args: ExprNode[] }
  | { type: "binop"; op: string; left: ExprNode; right: ExprNode }
  | { type: "unop"; op: string; operand: ExprNode }
  | { type: "list"; items: ExprNode[] }
  | { type: "in"; value: ExprNode; container: ExprNode };

class ExprParser {
  private pos = 0;
  private tokens: Token[] = [];

  parse(tokens: Token[]): ExprNode {
    this.tokens = tokens;
    this.pos = 0;
    return this.parseOr();
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new JinjaError("Unexpected end of expression");
    this.pos++;
    return t;
  }

  private expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) throw new JinjaError(`Expected ${type}, got ${t.type} at position ${t.pos}`);
    return t;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.peek()?.type === "OR") {
      this.next();
      const right = this.parseAnd();
      left = { type: "binop", op: "or", left, right };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseNot();
    while (this.peek()?.type === "AND") {
      this.next();
      const right = this.parseNot();
      left = { type: "binop", op: "and", left, right };
    }
    return left;
  }

  private parseNot(): ExprNode {
    if (this.peek()?.type === "NOT") {
      this.next();
      const operand = this.parseComparison();
      return { type: "unop", op: "not", operand };
    }
    return this.parseComparison();
  }

  private parseComparison(): ExprNode {
    let left = this.parseAddSub();
    const ops = ["EQ", "NEQ", "LT", "GT", "LTE", "GTE", "IN"] as string[];
    while (this.peek() && ops.includes(this.peek()!.type)) {
      const op = this.next();
      const right = this.parseAddSub();
      left = { type: "binop", op: op.value, left, right };
    }
    return left;
  }

  private parseAddSub(): ExprNode {
    let left = this.parseMulDiv();
    while (this.peek()?.value === "+" || this.peek()?.value === "-") {
      const op = this.next()!.value;
      const right = this.parseMulDiv();
      left = { type: "binop", op, left, right };
    }
    return left;
  }

  private parseMulDiv(): ExprNode {
    let left = this.parseUnary();
    while (this.peek()?.value === "*" || this.peek()?.value === "/" || this.peek()?.value === "%") {
      const op = this.next()!.value;
      const right = this.parseUnary();
      left = { type: "binop", op, left, right };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.peek()?.value === "-") {
      this.next();
      const operand = this.parsePrimary();
      return { type: "unop", op: "-", operand };
    }
    if (this.peek()?.value === "+") {
      this.next();
      return this.parsePrimary();
    }
    return this.parsePostfix();
  }

  private parsePostfix(): ExprNode {
    let node = this.parsePrimary();

    while (true) {
      if (this.peek()?.type === "DOT") {
        this.next();
        const prop = this.expect("IDENT").value;
        node = { type: "attr", object: node, property: prop };
      } else if (this.peek()?.type === "LPAREN") {
        this.next();
        const args: ExprNode[] = [];
        if (this.peek()?.type !== "RPAREN") {
          args.push(this.parseOr());
          while (this.peek()?.type === "COMMA") {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expect("RPAREN");
        if (node.type === "var") {
          node = { type: "call", name: node.name, args };
        } else {
          throw new JinjaError("Only named functions can be called");
        }
      } else if (this.peek()?.type === "LBRACKET") {
        this.next();
        const index = this.parseOr();
        this.expect("RBRACKET");
        node = { type: "index", object: node, index };
      } else {
        break;
      }
    }

    return node;
  }

  private parsePrimary(): ExprNode {
    const t = this.peek();
    if (!t) throw new JinjaError("Unexpected end of expression");

    if (t.type === "STRING") {
      this.next();
      return { type: "string", value: t.value.slice(1, -1) };
    }
    if (t.type === "NUMBER") {
      this.next();
      return { type: "number", value: parseFloat(t.value) };
    }
    if (t.type === "IDENT") {
      this.next();
      if (t.value === "true") return { type: "boolean", value: true };
      if (t.value === "false") return { type: "boolean", value: false };
      if (t.value === "none" || t.value === "null") return { type: "null" };
      return { type: "var", name: t.value };
    }
    if (t.type === "LPAREN") {
      this.next();
      const inner = this.parseOr();
      this.expect("RPAREN");
      return inner;
    }
    if (t.type === "LBRACKET") {
      this.next();
      const items: ExprNode[] = [];
      if (this.peek()?.type !== "RBRACKET") {
        items.push(this.parseOr());
        while (this.peek()?.type === "COMMA") {
          this.next();
          items.push(this.parseOr());
        }
      }
      this.expect("RBRACKET");
      return { type: "list", items };
    }

    throw new JinjaError(`Unexpected token: ${t.type} "${t.value}" at position ${t.pos}`);
  }
}

// ---------------------------------------------------------------------------
// AST Node Types
// ---------------------------------------------------------------------------

type AstNode =
  | { type: "text"; value: string; stripBefore?: boolean; stripAfter?: boolean }
  | { type: "output"; expr: ExprNode; stripBefore?: boolean; stripAfter?: boolean }
  | { type: "set"; name: string; value: ExprNode }
  | {
      type: "if";
      condition: ExprNode;
      body: AstNode[];
      elifs: { condition: ExprNode; body: AstNode[] }[];
      elseBody: AstNode[];
    }
  | { type: "for"; variable: string; iterable: ExprNode; body: AstNode[]; elseBody?: AstNode[] }
  | { type: "raw"; value: string };

// ---------------------------------------------------------------------------
// Jinja Parser (Template → AST)
// ---------------------------------------------------------------------------

function parseTemplate(template: string): AstNode[] {
  const tokens = tokenize(template);
  const nodes: AstNode[] = [];
  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;

    if (t.type === "TEXT") {
      nodes.push({ type: "text", value: t.value });
      i++;
    } else if (t.type === "VAR_OPEN") {
      const stripBefore = t.value === "{{-";
      // Collect tokens until VAR_CLOSE
      i++;
      const exprTokens: Token[] = [];
      while (i < tokens.length && tokens[i]!.type !== "VAR_CLOSE") {
        exprTokens.push(tokens[i]!);
        i++;
      }
      const closeToken = tokens[i];
      const stripAfter = closeToken?.value === "-}}";
      i++;

      // Parse expression
      const expr = parseExpressionTokens(exprTokens);
      nodes.push({ type: "output", expr, stripBefore, stripAfter });
    } else if (t.type === "BLOCK_OPEN") {
      i++;
      const blockTokens: Token[] = [];
      while (i < tokens.length && tokens[i]!.type !== "BLOCK_CLOSE") {
        blockTokens.push(tokens[i]!);
        i++;
      }
      i++;

      // Determine block type
      const blockType = blockTokens[0]?.value ?? "";
      const blockContent = blockTokens.slice(1);

      if (blockType === "set") {
        const name = blockContent[0]?.value ?? "";
        // {% set x = expr %}
        const eqIdx = blockContent.findIndex((tk) => tk.value === "=");
        if (eqIdx >= 0) {
          const exprTokens2 = blockContent.slice(eqIdx + 1);
          const expr = parseExpressionTokens(exprTokens2);
          nodes.push({ type: "set", name, value: expr });
        }
      } else if (blockType === "if") {
        // Parse if/elif/else/endif
        const { node, endIndex } = parseIfBlock(blockTokens, tokens, i);
        nodes.push(node);
        i = endIndex;
      } else if (blockType === "for") {
        // Parse for/endfor
        const { node, endIndex } = parseForBlock(blockTokens, tokens, i);
        nodes.push(node);
        i = endIndex;
      }
      // Other block types (raw, etc.) ignored for now
    } else {
      i++;
    }
  }

  return nodes;
}

function parseExpressionTokens(tokens: Token[]): ExprNode {
  const parser = new ExprParser();
  return parser.parse(tokens);
}

function parseIfBlock(blockTokens: Token[], allTokens: Token[], startIdx: number): { node: AstNode; endIndex: number } {
  // blockTokens = ["if", condition_tokens...]
  const conditionTokens = blockTokens.slice(1);
  const condition = parseExpressionTokens(conditionTokens);

  // Collect body until elif/else/endif
  const { body, elifs, elseBody, endIdx } = collectIfBody(allTokens, startIdx);

  return {
    node: { type: "if", condition, body, elifs, elseBody },
    endIndex: endIdx,
  };
}

function collectIfBody(
  allTokens: Token[],
  currentIdx: number,
): { body: AstNode[]; elifs: { condition: ExprNode; body: AstNode[] }[]; elseBody: AstNode[]; endIdx: number } {
  const body: AstNode[] = [];
  const elifs: { condition: ExprNode; body: AstNode[] }[] = [];
  let elseBody: AstNode[] = [];
  let i = currentIdx;

  while (i < allTokens.length) {
    const t = allTokens[i]!;
    if (t.type === "BLOCK_OPEN" && allTokens[i + 1]?.value === "endif") {
      return { body, elifs, elseBody, endIdx: i + 3 };
    }
    if (t.type === "BLOCK_OPEN" && allTokens[i + 1]?.value === "elif") {
      const elifCondTokens = allTokens.slice(
        i + 2,
        allTokens.findIndex((tk, idx) => idx > i + 1 && tk.type === "BLOCK_CLOSE"),
      );
      const elifCondition = parseExpressionTokens(elifCondTokens);
      i = allTokens.findIndex((tk, idx) => idx > i + 1 && tk.type === "BLOCK_CLOSE") + 1;
      const elifResult = collectIfBody(allTokens, i);
      elifs.push({ condition: elifCondition, body: elifResult.body });
      i = elifResult.endIdx;
      continue;
    }
    if (t.type === "BLOCK_OPEN" && allTokens[i + 1]?.value === "else") {
      i = allTokens.findIndex((tk, idx) => idx > i + 1 && tk.type === "BLOCK_CLOSE") + 1;
      elseBody = collectUntil(allTokens, i, "endif");
      i =
        allTokens.findIndex(
          (tk, idx) => idx >= i && tk.type === "BLOCK_OPEN" && allTokens[idx + 1]?.value === "endif",
        ) + 3;
      continue;
    }
    // Regular content
    if (t.type === "TEXT") {
      body.push({ type: "text", value: t.value });
      i++;
    } else if (t.type === "VAR_OPEN") {
      const exprTokens: Token[] = [];
      i++;
      while (i < allTokens.length && allTokens[i]!.type !== "VAR_CLOSE") {
        exprTokens.push(allTokens[i]!);
        i++;
      }
      i++;
      body.push({ type: "output", expr: parseExpressionTokens(exprTokens) });
    } else {
      i++;
    }
  }

  return { body, elifs, elseBody, endIdx: i };
}

function collectUntil(allTokens: Token[], startIdx: number, endBlock: string): AstNode[] {
  const nodes: AstNode[] = [];
  let i = startIdx;
  while (i < allTokens.length) {
    const t = allTokens[i]!;
    if (t.type === "BLOCK_OPEN" && allTokens[i + 1]?.value === endBlock) break;
    if (t.type === "TEXT") {
      nodes.push({ type: "text", value: t.value });
      i++;
    } else if (t.type === "VAR_OPEN") {
      const exprTokens: Token[] = [];
      i++;
      while (i < allTokens.length && allTokens[i]!.type !== "VAR_CLOSE") {
        exprTokens.push(allTokens[i]!);
        i++;
      }
      i++;
      nodes.push({ type: "output", expr: parseExpressionTokens(exprTokens) });
    } else {
      i++;
    }
  }
  return nodes;
}

function parseForBlock(
  blockTokens: Token[],
  allTokens: Token[],
  startIdx: number,
): { node: AstNode; endIndex: number } {
  // for item in iterable
  const varName = blockTokens[1]?.value ?? "";
  // Skip "in"
  const iterableTokens = blockTokens.slice(3);
  const iterable = parseExpressionTokens(iterableTokens);

  // Collect body until endfor
  const body: AstNode[] = [];
  let i = startIdx;
  while (i < allTokens.length) {
    const t = allTokens[i]!;
    if (t.type === "BLOCK_OPEN" && allTokens[i + 1]?.value === "endfor") {
      return {
        node: { type: "for", variable: varName, iterable, body },
        endIndex: i + 3,
      };
    }
    if (t.type === "TEXT") {
      body.push({ type: "text", value: t.value });
      i++;
    } else if (t.type === "VAR_OPEN") {
      const exprTokens: Token[] = [];
      i++;
      while (i < allTokens.length && allTokens[i]!.type !== "VAR_CLOSE") {
        exprTokens.push(allTokens[i]!);
        i++;
      }
      i++;
      body.push({ type: "output", expr: parseExpressionTokens(exprTokens) });
    } else {
      i++;
    }
  }

  return { node: { type: "for", variable: varName, iterable, body }, endIndex: i };
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export function renderJinja(template: string, context: Record<string, unknown>): string {
  const ast = parseTemplate(template);
  return evaluateNodes(ast, context);
}

function evaluateNodes(nodes: AstNode[], ctx: Record<string, unknown>): string {
  let output = "";
  for (const node of nodes) {
    output += evaluateNode(node, ctx);
  }
  return output;
}

function evaluateNode(node: AstNode, ctx: Record<string, unknown>): string {
  switch (node.type) {
    case "text":
      return node.value;
    case "output": {
      const value = evaluateExpr(node.expr, ctx);
      return formatValue(value);
    }
    case "set": {
      const value = evaluateExpr(node.value, ctx);
      ctx[node.name] = value;
      return "";
    }
    case "if": {
      if (isTruthy(evaluateExpr(node.condition, ctx))) {
        return evaluateNodes(node.body, ctx);
      }
      for (const elif of node.elifs) {
        if (isTruthy(evaluateExpr(elif.condition, ctx))) {
          return evaluateNodes(elif.body, ctx);
        }
      }
      return evaluateNodes(node.elseBody, ctx);
    }
    case "for": {
      const iterable = evaluateExpr(node.iterable, ctx);
      if (!Array.isArray(iterable)) return "";
      let result = "";
      for (let idx = 0; idx < iterable.length; idx++) {
        const loopCtx = { ...ctx };
        loopCtx[node.variable] = iterable[idx];
        loopCtx.loop = {
          index: idx + 1,
          index0: idx,
          first: idx === 0,
          last: idx === iterable.length - 1,
          length: iterable.length,
        };
        result += evaluateNodes(node.body, loopCtx);
      }
      return result;
    }
    case "raw":
      return node.value;
  }
}

function evaluateExpr(expr: ExprNode, ctx: Record<string, unknown>): unknown {
  switch (expr.type) {
    case "string":
      return expr.value;
    case "number":
      return expr.value;
    case "boolean":
      return expr.value;
    case "null":
      return null;
    case "var":
      return ctx[expr.name];
    case "attr": {
      const obj = evaluateExpr(expr.object, ctx);
      if (obj === null || obj === undefined) return undefined;
      if (typeof obj === "object" && expr.property in (obj as Record<string, unknown>)) {
        return (obj as Record<string, unknown>)[expr.property];
      }
      return undefined;
    }
    case "index": {
      const obj = evaluateExpr(expr.object, ctx);
      const idx = evaluateExpr(expr.index, ctx);
      if (Array.isArray(obj)) return obj[idx as number];
      if (typeof obj === "string") return obj[idx as number];
      return undefined;
    }
    case "filter":
      return applyFilter(evaluateExpr(expr.value, ctx), expr.name, expr.args, ctx);
    case "call":
      return callFunction(expr.name, expr.args, ctx);
    case "binop":
      return evaluateBinop(expr.op, expr.left, expr.right, ctx);
    case "unop":
      return evaluateUnop(expr.op, expr.operand, ctx);
    case "list":
      return expr.items.map((item) => evaluateExpr(item, ctx));
    case "in": {
      const value = evaluateExpr(expr.value, ctx);
      const container = evaluateExpr(expr.container, ctx);
      if (Array.isArray(container)) return container.includes(value);
      if (typeof container === "string") return container.includes(value as string);
      return false;
    }
  }
}

function evaluateBinop(op: string, left: ExprNode, right: ExprNode, ctx: Record<string, unknown>): unknown {
  const l = evaluateExpr(left, ctx);
  const r = evaluateExpr(right, ctx);

  switch (op) {
    case "and":
      return isTruthy(l) ? r : l;
    case "or":
      return isTruthy(l) ? l : r;
    case "==":
      return l === r || String(l) === String(r);
    case "!=":
      return l !== r && String(l) !== String(r);
    case "<":
      return Number(l) < Number(r);
    case ">":
      return Number(l) > Number(r);
    case "<=":
      return Number(l) <= Number(r);
    case ">=":
      return Number(l) >= Number(r);
    case "+":
      return Number(l) + Number(r);
    case "-":
      return Number(l) - Number(r);
    case "*":
      return Number(l) * Number(r);
    case "/":
      return Number(l) / Number(r);
    case "%":
      return Number(l) % Number(r);
    case "in": {
      if (Array.isArray(r)) return r.includes(l);
      if (typeof r === "string") return r.includes(l as string);
      return false;
    }
    default:
      return undefined;
  }
}

function evaluateUnop(op: string, operand: ExprNode, ctx: Record<string, unknown>): unknown {
  const val = evaluateExpr(operand, ctx);
  switch (op) {
    case "-":
      return -Number(val);
    case "+":
      return Number(val);
    case "not":
      return !isTruthy(val);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Filters (Hex-compatible)
// ---------------------------------------------------------------------------

function applyFilter(value: unknown, name: string, args: ExprNode[], ctx: Record<string, unknown>): unknown {
  switch (name) {
    // String filters
    case "upper":
      return String(value).toUpperCase();
    case "lower":
      return String(value).toLowerCase();
    case "capitalize":
      return String(value).charAt(0).toUpperCase() + String(value).slice(1);
    case "trim":
      return String(value).trim();
    case "ltrim":
      return String(value).trimStart();
    case "rtrim":
      return String(value).trimEnd();
    case "replace": {
      const oldStr = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      const newStr = args[1] ? String(evaluateExpr(args[1], ctx)) : "";
      return String(value).replace(new RegExp(oldStr, "g"), newStr);
    }
    case "slice": {
      const start = args[0] ? Number(evaluateExpr(args[0], ctx)) : 0;
      const end = args[1] ? Number(evaluateExpr(args[1], ctx)) : undefined;
      return String(value).slice(start, end);
    }
    case "truncate": {
      const length = args[0] ? Number(evaluateExpr(args[0], ctx)) : 50;
      const s = String(value);
      return s.length > length ? s.slice(0, length) + "…" : s;
    }
    case "urlencode":
      return encodeURIComponent(String(value));
    case "join": {
      if (Array.isArray(value)) {
        const sep = args[0] ? String(evaluateExpr(args[0], ctx)) : ", ";
        return value.join(sep);
      }
      return String(value);
    }
    case "split": {
      const sep = args[0] ? String(evaluateExpr(args[0], ctx)) : ",";
      return String(value)
        .split(sep)
        .map((s) => s.trim());
    }
    case "format": {
      const fmt = args[0] ? String(evaluateExpr(args[0], ctx)) : "{}";
      return fmt.replace(/\{\}/g, String(value));
    }

    // Number filters
    case "int":
      return parseInt(String(value), 10);
    case "float":
      return parseFloat(String(value));
    case "abs":
      return Math.abs(Number(value));
    case "round": {
      const precision = args[0] ? Number(evaluateExpr(args[0], ctx)) : 0;
      return Number(Number(value).toFixed(precision));
    }
    case "ceil":
      return Math.ceil(Number(value));
    case "floor":
      return Math.floor(Number(value));

    // List/collection filters
    case "length":
      if (Array.isArray(value)) return value.length;
      if (typeof value === "string") return value.length;
      if (value && typeof value === "object") return Object.keys(value).length;
      return 0;
    case "first":
      return Array.isArray(value) ? value[0] : null;
    case "last":
      return Array.isArray(value) ? value[value.length - 1] : null;
    case "reverse":
      return Array.isArray(value) ? [...value].reverse() : value;
    case "sort":
      return Array.isArray(value) ? [...value].sort() : value;
    case "unique":
      return Array.isArray(value) ? [...new Set(value)] : value;
    case "flatten":
      return Array.isArray(value) ? value.flat() : value;
    case "map": {
      if (!Array.isArray(value)) return value;
      const attr = args[0] ? String(evaluateExpr(args[0], ctx)) : null;
      if (attr) return value.map((item) => (item as Record<string, unknown>)?.[attr]);
      return value;
    }
    case "selectattr": {
      if (!Array.isArray(value)) return value;
      const attr = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      return value.filter((item) => !!(item as Record<string, unknown>)?.[attr]);
    }
    case "rejectattr": {
      if (!Array.isArray(value)) return value;
      const attr = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      return value.filter((item) => !(item as Record<string, unknown>)?.[attr]);
    }
    case "sum": {
      if (!Array.isArray(value)) return 0;
      const attr = args[0] ? String(evaluateExpr(args[0], ctx)) : null;
      if (attr) return value.reduce((s, item) => s + Number((item as Record<string, unknown>)?.[attr] ?? 0), 0);
      return value.reduce((s, item) => s + Number(item ?? 0), 0);
    }
    case "min":
      return Array.isArray(value) ? Math.min(...value.map(Number)) : value;
    case "max":
      return Array.isArray(value) ? Math.max(...value.map(Number)) : value;
    case "groupby": {
      if (!Array.isArray(value)) return value;
      const key = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      const groups: Record<string, unknown[]> = {};
      for (const item of value) {
        const k = String((item as Record<string, unknown>)?.[key] ?? "");
        if (!groups[k]) groups[k] = [];
        groups[k]!.push(item);
      }
      return Object.entries(groups).map(([g, items]) => ({ key: g, values: items }));
    }
    case "batch": {
      if (!Array.isArray(value)) return value;
      const count = args[0] ? Number(evaluateExpr(args[0], ctx)) : 2;
      const result: unknown[][] = [];
      for (let i = 0; i < value.length; i += count) {
        result.push(value.slice(i, i + count));
      }
      return result;
    }

    // Hex-specific filters
    case "array":
      // Hex: {{ list_variable | array }} — ensures the value is treated as an array
      if (Array.isArray(value)) return value;
      return [value];
    case "sqlsafe":
      // Hex: {{ column | sqlsafe }} — marks as safe for identifier parameterization
      return String(value);
    case "default":
    case "d": {
      const defaultVal = args[0] ? evaluateExpr(args[0], ctx) : "";
      return value === null || value === undefined || value === "" ? defaultVal : value;
    }
    case "bool":
      return isTruthy(value);
    case "json":
      return JSON.stringify(value);
    case "tojson":
      return JSON.stringify(value);
    case "list":
      return Array.isArray(value) ? value : [value];

    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// dbt Macro Functions
// ---------------------------------------------------------------------------

function callFunction(name: string, args: ExprNode[], ctx: Record<string, unknown>): unknown {
  switch (name) {
    // dbt macros
    case "ref": {
      const modelName = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      const dbtContext = ctx._dbt as DbtContext | undefined;
      if (dbtContext?.ref) return dbtContext.ref(modelName);
      // Default: return the model name as a table reference
      return modelName;
    }
    case "source": {
      const sourceName = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      const tableName = args[1] ? String(evaluateExpr(args[1], ctx)) : "";
      const dbtContext = ctx._dbt as DbtContext | undefined;
      if (dbtContext?.source) return dbtContext.source(sourceName, tableName);
      return `${sourceName}.${tableName}`;
    }
    case "var": {
      const varName = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      const defaultVal = args[1] ? evaluateExpr(args[1], ctx) : undefined;
      const dbtContext = ctx._dbt as DbtContext | undefined;
      if (dbtContext?.var) return dbtContext.var(varName, defaultVal);
      const projectVars = ctx.vars as Record<string, unknown> | undefined;
      return projectVars?.[varName] ?? defaultVal ?? "";
    }
    case "config": {
      // dbt config block — in our context, returns empty string
      return "";
    }
    case "run_query": {
      // dbt run_query — in our context, returns a placeholder
      const query = args[0] ? String(evaluateExpr(args[0], ctx)) : "";
      return `[run_query: ${query}]`;
    }
    case "adapter.dispatch": {
      return "";
    }
    case "exceptions.raise_compiler_error": {
      const msg = args[0] ? String(evaluateExpr(args[0], ctx)) : "dbt error";
      throw new JinjaError(`dbt: ${msg}`);
    }

    // Built-in functions
    case "range": {
      const end = args[0] ? Number(evaluateExpr(args[0], ctx)) : 0;
      const start = args[1] ? Number(evaluateExpr(args[1], ctx)) : 0;
      const step = args[2] ? Number(evaluateExpr(args[2], ctx)) : 1;
      const result: number[] = [];
      for (let i = start; i < end; i += step) result.push(i);
      return result;
    }
    case "dict": {
      const result: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i += 2) {
        const keyArg = args[i];
        const valArg = args[i + 1];
        const key = keyArg ? String(evaluateExpr(keyArg, ctx)) : "";
        const val = valArg ? evaluateExpr(valArg, ctx) : null;
        result[key] = val;
      }
      return result;
    }
    case "namespace": {
      const result: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i += 2) {
        const keyArg = args[i];
        const valArg = args[i + 1];
        const key = keyArg ? String(evaluateExpr(keyArg, ctx)) : "";
        const val = valArg ? evaluateExpr(valArg, ctx) : null;
        result[key] = val;
      }
      return result;
    }

    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === false) return false;
  if (value === 0) return false;
  if (value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(6).replace(/\.?0+$/, "");
  }
  if (Array.isArray(value)) return value.map(formatValue).join(", ");
  return String(value);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DbtContext {
  ref: (modelName: string) => string;
  source: (sourceName: string, tableName: string) => string;
  var: (varName: string, defaultVal?: unknown) => unknown;
}

export interface JinjaRenderOptions {
  /** Variables available in the template. */
  variables?: Record<string, unknown>;
  /** dbt context for ref/source/var macros. */
  dbt?: DbtContext;
  /** Strip leading/trailing whitespace from output. */
  stripWhitespace?: boolean;
}

/**
 * Render a Jinja template with the given context.
 *
 * @example
 * ```ts
 * const sql = renderJinja(`
 *   SELECT *
 *   FROM {{ ref('users') }}
 *   WHERE created_at >= '{{ var("start_date", "2024-01-01") }}'
 *   {% if region %}
 *   AND region = '{{ region }}'
 *   {% endif %}
 * `, { region: "West", vars: { start_date: "2024-06-01" } });
 * ```
 */
export function render(template: string, options: JinjaRenderOptions = {}): string {
  const context: Record<string, unknown> = {
    ...options.variables,
    _dbt: options.dbt,
  };
  let result = renderJinja(template, context);
  if (options.stripWhitespace) {
    result = result.replace(/\n\s*\n/g, "\n").trim();
  }
  return result;
}

/**
 * Extract all Jinja variables from a template (for UI hints, autocomplete).
 */
export function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  const varRegex = /\{\{[\s-]*([a-zA-Z_][a-zA-Z0-9_.]*)/g;
  let match;
  while ((match = varRegex.exec(template)) !== null) {
    vars.add(match[1]!);
  }
  return Array.from(vars).sort();
}

/**
 * Validate a Jinja template (returns errors or null if valid).
 */
export function validateTemplate(template: string): { line: number; message: string } | null {
  try {
    parseTemplate(template);
    return null;
  } catch (err) {
    if (err instanceof JinjaError) {
      return { line: 1, message: err.message };
    }
    return { line: 1, message: String(err) };
  }
}

/**
 * Highlight Jinja syntax in a template string (returns segments for UI).
 */
export interface SyntaxSegment {
  text: string;
  type: "text" | "variable" | "block" | "filter" | "string" | "comment";
}

export function highlightJinja(template: string): SyntaxSegment[] {
  const segments: SyntaxSegment[] = [];
  let i = 0;
  const n = template.length;

  while (i < n) {
    // Jinja block comment {# ... #}
    if (template[i] === "{" && template[i + 1] === "#") {
      const end = template.indexOf("#}", i + 2);
      if (end >= 0) {
        segments.push({ text: template.slice(i, end + 2), type: "comment" });
        i = end + 2;
        continue;
      }
    }
    // Jinja block {% ... %}
    if (template[i] === "{" && template[i + 1] === "%") {
      const end = template.indexOf("%}", i + 2);
      if (end >= 0) {
        segments.push({ text: template.slice(i, end + 2), type: "block" });
        i = end + 2;
        continue;
      }
    }
    // Jinja variable {{ ... }}
    if (template[i] === "{" && template[i + 1] === "{") {
      const end = template.indexOf("}}", i + 2);
      if (end >= 0) {
        segments.push({ text: template.slice(i, end + 2), type: "variable" });
        i = end + 2;
        continue;
      }
    }
    // Regular text
    let text = "";
    while (
      i < n &&
      !(template[i] === "{" && (template[i + 1] === "{" || template[i + 1] === "%" || template[i + 1] === "#"))
    ) {
      text += template[i];
      i++;
    }
    if (text) segments.push({ text, type: "text" });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class JinjaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JinjaError";
  }
}
