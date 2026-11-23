// 用宿主真实的 YAML dialect 校验 cordis.patch.yml
// （dsh-app-boot: JSON_SCHEMA.extend(JsExpr)）
//
// 路径来源优先级：
//   1. $DSH_HOME/profiles/desktop/cordis.patch.yml
//   2. 本仓库自带的 cordis.patch.yml
// 两者都不存在时跳过（开源仓库里没有用户的 profile 是正常的）。
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// 从宿主安装位置解析 js-yaml（和 DSH 用同一份，保证 dialect 一致）
function loadYaml() {
  const candidates = [
    process.env.DSH_INSTALL && join(process.env.DSH_INSTALL, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'),
    'D:/deepseek/resources/app/dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json',
  ].filter(Boolean)
  for (const c of candidates) {
    if (!existsSync(c)) continue
    try {
      return createRequire(c)('js-yaml')
    } catch { /* 换下一个 */ }
  }
  return null
}

const yaml = loadYaml()
if (!yaml) {
  console.log('SKIP yaml-check: 找不到宿主安装的 js-yaml（设置 DSH_INSTALL 可指定）')
  process.exit(0)
}

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (s) => ({ __js: s }),
})
const entryListSchema = yaml.JSON_SCHEMA.extend(JsExpr)

const targets = [
  process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles/desktop/cordis.patch.yml'),
  join(here, '../cordis.patch.yml'),
].filter(Boolean).filter((f) => existsSync(f))

if (targets.length === 0) {
  console.log('SKIP yaml-check: 没有可校验的 cordis.patch.yml')
  process.exit(0)
}

let failed = 0
for (const file of targets) {
  const t = readFileSync(file, 'utf8')
  try {
    const doc = yaml.load(t, { schema: entryListSchema })
    console.log(`OK   ${file}`)
    console.log(`     entries=${Array.isArray(doc) ? doc.length : typeof doc}`)
    const mine = (Array.isArray(doc) ? doc : []).filter(
      (e) => e && (e.id === 'dsh-session-bridge'
        || (Array.isArray(e.insert) && e.insert.some((x) => x.id === 'dsh-session-bridge'))),
    )
    console.log(`     session-bridge 条目: ${mine.length} 个`)
  } catch (e) {
    failed += 1
    console.log(`FAIL ${file}: ${e.message}`)
  }
}

if (failed > 0) process.exit(1)
console.log(`=== yaml-check 结果: pass=${targets.length} fail=0 ===`)
