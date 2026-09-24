/**
 * OOXML 解包安全矩阵（docs/10 §5.6.5 B/C、§5.6.8、§5.6.10「异常样本」、ADR-0001 §6）。
 *
 * 这一组测试针对的是**与格式无关**的安全性质，因此放在单独文件里：
 * - 部件白名单（不读的字节不可能造成危害）——主要防线；
 * - 逐块实际字节硬上限（不信任 ZIP 声明值）；
 * - 路径穿越即拒绝整个归档；
 * - 危险部件（宏/嵌入对象/ActiveX/外链）与 XML 外部实体；
 * - 日志摘要不泄露正文。
 *
 * @module test/documents-ooxml-safety
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertSafeArchiveEntry,
  classifyDangerousPart,
  defaultParserRegistry,
  documentLogSummary,
  DocumentParseError,
  resolveRelationshipTarget,
  type DocumentParseInput,
  type ParsedDocument,
} from '../src/documents/index.ts'
import {
  asNodeBuffer,
  buildDocx,
  buildTraversalZip,
  buildZip,
  buildZipBomb,
  buildZipBombOutsideWhitelist,
  notAZip,
  patchDeclaredUncompressedSize,
} from './document-fixtures.ts'

const signal = new AbortController().signal

function parse(path: string, bytes: Uint8Array, extra: Partial<DocumentParseInput> = {}): Promise<ParsedDocument> {
  return defaultParserRegistry().parse({ path, absolutePath: `/w/${path}`, bytes, signal, ...extra })
}

function codes(doc: ParsedDocument): string[] {
  return doc.diagnostics.map(item => item.code)
}

function messages(doc: ParsedDocument): string {
  return doc.diagnostics.map(item => item.message).join(' | ')
}

/** 一份结构合法、正文可读的 DOCX。 */
function validDocx(): Uint8Array {
  return buildDocx({
    body: [{ kind: 'heading', level: 1, text: '需求' }, { kind: 'paragraph', text: '业务事实。' }],
  })
}

// ── 白名单是主要防线 ─────────────────────────────────────────────────────────

test('炸弹位于白名单外时解析照常成功——不读的字节不可能造成危害', async () => {
  // 炸弹在 word/bomb.xml，不在 DOCX 白名单里，因此**根本不会被解压**。
  // 这与"撞上限"是两件不同的事：白名单让解压根本不会发生。
  const doc = await parse('outside.docx', buildZipBombOutsideWhitelist(4), {
    limits: { maxZipEntryBytes: 64 * 1024 },
  })

  assert.equal(doc.status, 'parsed')
  assert.match(doc.plainText, /正文很短/)
  assert.equal(codes(doc).includes('LIMIT_EXCEEDED'), false)
})

test('炸弹位于白名单内时被逐块实际字节上限拦下', async () => {
  // word/document.xml 本身是 4 MiB 全零，在白名单内 → 必须撞硬上限。
  const doc = await parse('inside.docx', buildZipBomb(4), { limits: { maxZipEntryBytes: 64 * 1024 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.deepEqual(doc.sections, [])
  assert.equal(doc.plainText, '')
})

test('伪造 ZIP 头里声明的解压大小不能绕过逐块硬上限', async () => {
  // 真实 Excel/恶意工具都可以把中央目录里的"解压后大小"改小。若实现采信声明值，
  // 上限就会被绕过。这里把声明值改成 16 字节，实际仍是 4 MiB。
  const forged = patchDeclaredUncompressedSize(buildZipBomb(4), 16)
  const doc = await parse('forged.docx', forged, { limits: { maxZipEntryBytes: 64 * 1024 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.ok(codes(doc).includes('LIMIT_EXCEEDED'))
  assert.match(messages(doc), /实际解压/)
})

test('条目数超过上限时整体拒绝，而不是只处理前几个条目', async () => {
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<Types>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    'word/document.xml': '<w:document xmlns:w="x"><w:body/></w:document>',
  }
  for (let index = 1; index <= 8; index += 1) entries[`word/extra${index}.xml`] = `<x/>`

  const doc = await parse('many.docx', buildZip(entries), { limits: { maxZipEntries: 3 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.match(messages(doc), /压缩包条目数超过上限 3/)
})

test('累计解压总量超过上限时整体拒绝', async () => {
  const doc = await parse('big.docx', validDocx(), { limits: { maxUncompressedBytes: 512 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.match(messages(doc), /压缩包解压总量/)
})

// ── 路径穿越 ─────────────────────────────────────────────────────────────────

test('归档含路径穿越条目时拒绝整个归档', async () => {
  // 本模块只解压到内存、从不落盘，因此路径穿越不可利用；但拒绝畸形归档能避免
  // "把恶意文档当正常文档解析"。
  const doc = await parse('evil.docx', buildTraversalZip())

  assert.equal(doc.status, 'parse-failed')
  assert.ok(codes(doc).includes('DANGEROUS_PART_REMOVED'))
  assert.deepEqual(doc.sections, [])
})

test('归档条目名校验：绝对路径/..//反斜杠/控制字符/空段一律拒绝', () => {
  for (const name of ['/absolute.xml', '../escaped.xml', 'a/../../b.xml', 'dir\\file.xml', 'a//b.xml', 'a/./b.xml', '']) {
    assert.throws(() => assertSafeArchiveEntry(name), DocumentParseError, `应拒绝：${name}`)
  }
  assert.throws(() => assertSafeArchiveEntry(`${'x'.repeat(600)}.xml`), DocumentParseError)
  // 正常部件名必须放行，否则白名单形同虚设。
  for (const name of ['word/document.xml', '[Content_Types].xml', 'xl/worksheets/sheet1.xml']) {
    assert.doesNotThrow(() => assertSafeArchiveEntry(name), `应放行：${name}`)
  }
})

test('关系目标解析：越出归档根即返回 undefined，不猜测不修正', () => {
  assert.equal(resolveRelationshipTarget('xl', 'worksheets/sheet1.xml'), 'xl/worksheets/sheet1.xml')
  assert.equal(resolveRelationshipTarget('xl/worksheets', '../tables/table1.xml'), 'xl/tables/table1.xml')
  assert.equal(resolveRelationshipTarget('', '/xl/workbook.xml'), 'xl/workbook.xml')
  // 逃逸：不修正成归档内的某个路径，直接放弃。
  assert.equal(resolveRelationshipTarget('xl', '../../evil.xml'), undefined)
  assert.equal(resolveRelationshipTarget('xl', '../..'), undefined)
  assert.equal(resolveRelationshipTarget('xl', ''), undefined)
})

// ── 危险部件与外部实体 ───────────────────────────────────────────────────────

test('危险部件按固定 OPC 路径识别：宏/嵌入对象/ActiveX/外链', () => {
  assert.equal(classifyDangerousPart('word/vbaProject.bin')?.kind, 'macro')
  assert.equal(classifyDangerousPart('word/vbaData.xml')?.kind, 'macro')
  assert.equal(classifyDangerousPart('word/embeddings/oleObject1.bin')?.kind, 'ole-object')
  assert.equal(classifyDangerousPart('word/activeX/activeX1.xml')?.kind, 'activex')
  assert.equal(classifyDangerousPart('xl/ctrlProps/ctrlProp1.xml')?.kind, 'activex')
  assert.equal(classifyDangerousPart('xl/externalLinks/externalLink1.xml')?.kind, 'external-link')
  // 正常部件绝不能被误判，否则正文会被整段丢掉。
  assert.equal(classifyDangerousPart('word/document.xml'), undefined)
  assert.equal(classifyDangerousPart('xl/worksheets/sheet1.xml'), undefined)
  assert.equal(classifyDangerousPart('docProps/core.xml'), undefined)
})

test('危险部件诊断按类别聚合，不产生几十条重复警告', async () => {
  const entries: Record<string, string> = {
    '[Content_Types].xml': '<Types>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>',
    'word/vbaProject.bin': 'M',
    'word/vbaData.xml': 'D',
  }
  const doc = await parse('macro.docx', buildZip(entries))

  assert.equal(doc.status, 'parsed')
  const removed = doc.diagnostics.filter(item => item.code === 'DANGEROUS_PART_REMOVED')
  assert.equal(removed.length, 1, '两个宏部件应聚合成一条诊断')
  assert.match(removed[0]!.message, /已跳过 2 个宏部件（macro）/)
  // 类别内命中了不同规则时，原因必须全部列出，否则诊断会声称一个只对部分部件成立的原因。
  assert.match(removed[0]!.message, /VBA 宏工程、VBA 宏数据/)
})

test('XML 外部实体与实体爆炸在构造上不可能（DTD 整段跳过）', async () => {
  const rawDocumentXml = '<?xml version="1.0"?>'
    // Billion Laughs 的经典构造：多层内部实体互相引用。
    + '<!DOCTYPE w:document ['
    + '<!ENTITY a "aaaaaaaaaa">'
    + '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">'
    + '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">'
    + ']>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>&c;</w:t></w:r></w:p>'
    + '</w:body></w:document>'

  const doc = await parse('billion.docx', buildDocx({ body: [], rawDocumentXml }))

  assert.equal(doc.status, 'parsed')
  // 实体没有被展开：拿到的是字面量 `&c;`，而不是 1000 个 a。
  assert.match(doc.sections[0]!.text, /^&c;$/)
  assert.doesNotMatch(doc.plainText, /aaaaa/)
  assert.match(messages(doc), /DOCTYPE\/DTD 声明，已整段跳过/)
})

// ── 字节归一化与日志 ─────────────────────────────────────────────────────────

test('OOXML 解析器接受 Node Buffer（fs.readFile 的真实返回类型）', async () => {
  const doc = await parse('buffer.docx', asNodeBuffer(validDocx()))
  assert.equal(doc.status, 'parsed')
  assert.match(doc.plainText, /业务事实。/)
})

test('不是 ZIP 的内容即使扩展名是 .docx 也不按文本读', async () => {
  const doc = await parse('notzip.docx', notAZip())

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.plainText, '')
  assert.ok(codes(doc).includes('FORMAT_MAGIC_BYTES_MISMATCH'))
})

test('日志摘要只含计数与 hash，不含任何正文片段', async () => {
  const secret = '身份证号 110101199001011234'
  const doc = await parse('secret.docx', buildDocx({
    body: [{ kind: 'heading', level: 1, text: '敏感' }, { kind: 'paragraph', text: secret }],
  }))
  // 前提：正文确实被解析出来了，否则"摘要不含正文"是空话。
  assert.match(doc.plainText, /110101199001011234/)

  const summary = documentLogSummary(doc)
  const serialized = JSON.stringify(summary)
  assert.doesNotMatch(serialized, /110101199001011234/)
  assert.doesNotMatch(serialized, /敏感/)
  assert.equal(summary.format, 'docx')
  assert.equal(summary.status, 'parsed')
  assert.equal(summary.sha256, doc.sha256)
  assert.equal(summary.sectionCount, doc.sections.length)
  assert.deepEqual([...summary.diagnosticCodes], [...new Set(doc.diagnostics.map(item => item.code))].sort())
  // 结构上也不该存在正文/原始字节字段。
  assert.equal('plainText' in summary, false)
  assert.equal('rawSource' in summary, false)
})
