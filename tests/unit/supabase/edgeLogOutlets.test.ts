import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { checkEdgeLogOutlets, unsafeLogReferences } from '../../../scripts/check-edge-log-outlets.mjs'

it('all function diagnostics use the single validated logger', () => {
  expect(() => checkEdgeLogOutlets(resolve(import.meta.dirname, '../../../supabase/functions'))).not.toThrow()
})
it.each([
  'console.log(request)', 'const c = console; c.error(error)', 'const { log } = console; log(body)',
  'globalThis["console"].log(body)', 'globalThis["con" + "sole"]["log"](body)',
  'Deno.stdout.write(bytes)', 'const { stderr } = Deno; stderr.write(bytes)',
  'const d = Deno; d[channel].write(bytes)', 'const root = globalThis; root[key].log(body)',
  'import log from "jsr:@std/log"', 'import { Console } from "node:console"',
  'eval(source)', 'new Function(source)',
])('detects diagnostic aliases and alternate outlets: %s', source => {
  expect(unsafeLogReferences(source)).not.toEqual([])
})
it('does not mistake comments or fixed event calls for an outlet', () => {
  expect(unsafeLogReferences('// console.log(error)\nlog("failed", { count: 1 })')).toEqual([])
})
