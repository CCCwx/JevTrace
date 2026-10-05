import ts from "typescript";

export interface RecoveredCall { name: string; arguments: Record<string, unknown> | string; result: unknown }
interface PendingCall { name: string; arguments: Record<string, unknown> | string; settled?: boolean }
const fail = () => { throw new Error("Unsupported syntax"); };

function literal(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(n => literal(n as ts.Expression));
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) fail();
      const p = property as ts.PropertyAssignment;
      value[(p.name as ts.Identifier | ts.StringLiteral).text] = literal(p.initializer);
    }
    return value;
  }
  return fail();
}

function toolCall(node: ts.Expression, settled = false): PendingCall {
  if (ts.isAwaitExpression(node)) node = node.expression;
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return fail();
  const access = node.expression;
  if (!ts.isIdentifier(access.expression) || access.expression.text !== "tools" || node.arguments.length !== 1) return fail();
  const argumentsValue = literal(node.arguments[0]!);
  if (typeof argumentsValue !== "string" && (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue))) return fail();
  return { name: access.name.text, arguments: argumentsValue as PendingCall["arguments"], settled };
}

/** Static pattern recognition only. No eval, dynamic imports, shell execution, or inferred output ordering. */
export function recoverWrapper(source: string, output: unknown): RecoveredCall[] | null {
  try {
    const ast = ts.createSourceFile("wrapper.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const emitted: PendingCall[] = [];
    const groups = new Map<string, PendingCall[]>();
    for (const statement of ast.statements) {
      if (ts.isVariableStatement(statement)) {
        if (statement.declarationList.declarations.length !== 1) return null;
        const declaration = statement.declarationList.declarations[0]!;
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isAwaitExpression(declaration.initializer)) return null;
        const initializer = declaration.initializer.expression;
        if (!ts.isCallExpression(initializer) || !ts.isPropertyAccessExpression(initializer.expression)
          || !ts.isIdentifier(initializer.expression.expression) || initializer.expression.expression.text !== "Promise"
          || initializer.expression.name.text !== "allSettled" || initializer.arguments.length !== 1
          || !ts.isArrayLiteralExpression(initializer.arguments[0]!)) return null;
        if (groups.has(declaration.name.text)) return null;
        groups.set(declaration.name.text, initializer.arguments[0].elements.map(n => toolCall(n as ts.Expression, true)));
        continue;
      }
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return null;
      const expression = statement.expression;
      if (ts.isIdentifier(expression.expression) && expression.expression.text === "text" && expression.arguments.length === 1) {
        emitted.push(toolCall(expression.arguments[0]!));
      } else if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "forEach"
        && ts.isIdentifier(expression.expression.expression) && expression.arguments.length === 1
        && ts.isIdentifier(expression.arguments[0]!) && expression.arguments[0].text === "text") {
        const name = expression.expression.expression.text;
        const group = groups.get(name);
        if (!group) return null;
        emitted.push(...group);
        groups.delete(name);
      } else return null;
    }
    if (groups.size || !emitted.length || !Array.isArray(output)) return null;
    const blocks = output.filter((item: unknown) => {
      const value = item as { type?: string; text?: string };
      return ["text", "input_text", "output_text"].includes(value.type ?? "") && typeof value.text === "string" && !/^Script (completed|running|failed)\b/.test(value.text);
    });
    if (blocks.length !== emitted.length) return null;
    return emitted.map((call, index) => {
      const parsed: unknown = JSON.parse((blocks[index] as { text: string }).text);
      if (call.settled) {
        const settled = parsed as { status: string; value?: unknown };
        if (settled.status !== "fulfilled") throw new Error("Rejected or missing tool result");
        return { name: call.name, arguments: call.arguments, result: settled.value };
      }
      return { name: call.name, arguments: call.arguments, result: parsed };
    });
  } catch { return null; }
}
