import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export function unsafeLogReferences(source, filename = 'function.ts') {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const hits = []
  const localNames = new Set()
  const declarations = node => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) localNames.add(node.name.text)
    ts.forEachChild(node, declarations)
  }
  declarations(ast)
  const literal = node => ts.isStringLiteralLike(node) ? node.text
    : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ? (literal(node.left) ?? '') + (literal(node.right) ?? '') : undefined
  const visit = node => {
    const id = ts.isIdentifier(node) ? node.text : undefined
    const computed = ts.isElementAccessExpression(node) && node.argumentExpression ? literal(node.argumentExpression) : undefined
    const module = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier ? literal(node.moduleSpecifier) : undefined
    const member = node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node ? node.parent.name.text : undefined
    if (['console', 'stdout', 'stderr', 'eval', 'Function'].includes(id)
      || (id === 'Deno' && !['env', 'serve'].includes(member) && !ts.isTypeOfExpression(node.parent))
      || (['globalThis', 'self', 'window'].includes(id) && !localNames.has(id) && !(id === 'globalThis' && member === 'EdgeRuntime'))
      || ['console', 'stdout', 'stderr'].includes(computed)
      || (module && !module.startsWith('.') && /(?:^|[/@:.-])(?:log|logger|logging|console|process|fs|io|winston|pino|bunyan)(?:$|[/@:.-])/.test(module))) {
      hits.push(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...new Set(hits)]
}

export function checkEdgeLogOutlets(root) {
  const errors = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const name = relative(root, file).replaceAll('\\', '/')
        if (name === '_shared/safe-log.ts') continue
        for (const line of unsafeLogReferences(readFileSync(file, 'utf8'), name)) errors.push(`${name}:${line}`)
      }
    }
  }
  walk(root)
  if (errors.length) throw new Error(`Only the shared safe logger may write diagnostics: ${errors.join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkEdgeLogOutlets(resolve(import.meta.dirname, '../supabase/functions'))
}
