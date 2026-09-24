/**
 * PDF 解析测试（docs/10 §5.6.10「正常样本 / 异常样本 / 知识投影样本」的 PDF 部分）。
 *
 * 直接对 `defaultParserRegistry()` 断言——CLI、Web、Harness 三个入口用的就是它
 * （§5.6.11 第 9 条），所以这里覆盖的就是三个入口的真实行为。
 *
 * fixture 的文本一律用 ASCII：`assemblePdf` 按 PDF 的 latin1 字节语义拼装，
 * 中文会被截成低字节，解析出来必然是另一个字符。中文覆盖由 DOCX/XLSX/Markdown
 * 测试承担，那里走的是真正的 UTF-8 部件。
 *
 * @module test/documents-pdf
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaultParserRegistry, type DocumentParseInput, type ParsedDocument } from '../src/documents/index.ts'
import {
  asNodeBuffer,
  brokenPdf,
  buildEncryptedPdf,
  buildPdf,
  buildPdfWithJavaScript,
  buildScannedPdf,
} from './document-fixtures.ts'

const signal = new AbortController().signal

function parse(
  path: string,
  bytes: Uint8Array,
  extra: Partial<DocumentParseInput> = {},
): Promise<ParsedDocument> {
  return defaultParserRegistry().parse({ path, absolutePath: `/w/${path}`, bytes, signal, ...extra })
}

function codes(doc: ParsedDocument): string[] {
  return doc.diagnostics.map(item => item.code)
}

// ── 正常样本 ─────────────────────────────────────────────────────────────────

test('多页可复制文本 PDF：每页一个带 #page=N 的 section', async () => {
  const bytes = buildPdf({
    pages: [
      { lines: ['Login requirement', 'The token expires in 60 seconds.'] },
      { lines: ['Reset requirement', 'One SMS per minute.'] },
    ],
  })
  const doc = await parse('requirements.pdf', bytes)

  assert.equal(doc.status, 'parsed')
  assert.equal(doc.format, 'pdf')
  assert.equal(doc.mediaType, 'application/pdf')
  assert.equal(doc.confidence, 'structure-preserved')
  assert.equal(doc.pageCount, 2)
  assert.equal(doc.sections.length, 2)

  assert.deepEqual(doc.sections.map(section => section.page), [1, 2])
  assert.deepEqual(doc.sections.map(section => section.sourceRef), [
    'requirements.pdf#page=1',
    'requirements.pdf#page=2',
  ])
  assert.match(doc.sections[0]!.text, /Login requirement/)
  assert.match(doc.sections[1]!.text, /One SMS per minute/)
  assert.equal(doc.sections[0]!.title, '第 1 页')

  assert.match(doc.plainText, /Login requirement/)
  assert.match(doc.plainText, /One SMS per minute/)

  assert.equal(doc.limits.pagesRead, 2)
  assert.equal(doc.limits.bytesRead, bytes.byteLength)
  assert.equal(doc.metadata.pdfVersion, '1.7')
  assert.equal(doc.metadata.pageCount, 2)
  // sha256 是 source identity，必须是对**原始文件**算的。
  assert.match(doc.sha256, /^[0-9a-f]{64}$/)
})

test('PDF 不产出表格，但明确说明这是能力边界而不是漏读', async () => {
  const doc = await parse('spec.pdf', buildPdf({ pages: [{ lines: ['| a | b |', '| 1 | 2 |'] }] }))

  // docs/10 §5.6.5 A 禁止把布局不稳定的文本硬拼成"准确表格"。
  assert.deepEqual(doc.tables, [])
  const diagnostic = doc.diagnostics.find(item => item.code === 'TABLE_EXTRACTION_UNAVAILABLE')
  assert.ok(diagnostic !== undefined, '缺少 TABLE_EXTRACTION_UNAVAILABLE 诊断')
  // info 而不是 error：tables 为空是设计选择，不是解析失败。
  assert.equal(diagnostic.severity, 'info')
  assert.match(diagnostic.message, /不产出结构化表格/)
  assert.equal(doc.status, 'parsed')
})

test('PDF 字节可以重复解析，且解析不会让调用方的字节失效', async () => {
  const bytes = buildPdf({ pages: [{ lines: ['idempotent check'] }] })
  const before = bytes.byteLength

  const first = await parse('a.pdf', bytes)
  // pdfjs 会 detach 传入的 ArrayBuffer；不传副本的话这里会静默变成 0，
  // 之后任何对同一份字节的读取都会拿到空数据。见 pdf-parser.ts 的 isolatedCopy。
  assert.equal(bytes.byteLength, before, '解析后调用方字节被清空（ArrayBuffer 被 detach）')
  assert.equal(first.limits.bytesRead, before)

  const second = await parse('a.pdf', bytes)
  assert.equal(second.status, 'parsed')
  assert.equal(second.sha256, first.sha256)
  assert.equal(second.sections.length, first.sections.length)
})

test('PDF 解析器接受 Node Buffer（fs.readFile 的真实返回类型）', async () => {
  // pdfjs 显式拒绝 Buffer，尽管它是 Uint8Array 的子类。而真实调用方读文件拿到的
  // 正是 Buffer——不测这条路径，"真实文件能不能解析"就没有任何覆盖。
  const doc = await parse('buffer.pdf', asNodeBuffer(buildPdf({ pages: [{ lines: ['from a node buffer'] }] })))

  assert.equal(doc.status, 'parsed')
  assert.match(doc.plainText, /from a node buffer/)
})

test('pageRange 只读指定页，但 pageCount 仍报告文档真实页数', async () => {
  const bytes = buildPdf({
    pages: [{ lines: ['page one'] }, { lines: ['page two'] }, { lines: ['page three'] }],
  })
  const doc = await parse('big.pdf', bytes, { pageRange: { from: 2, to: 3 } })

  assert.equal(doc.pageCount, 3)
  assert.equal(doc.limits.pagesRead, 2)
  assert.deepEqual(doc.sections.map(section => section.sourceRef), ['big.pdf#page=2', 'big.pdf#page=3'])
  assert.doesNotMatch(doc.plainText, /page one/)
})

// ── 异常样本 ─────────────────────────────────────────────────────────────────

test('没有文本层的扫描 PDF 返回 partial + NO_TEXT_LAYER，绝不假装解析成功', async () => {
  const doc = await parse('scan.pdf', buildScannedPdf(2))

  assert.equal(doc.status, 'partial')
  assert.equal(doc.pageCount, 2)
  assert.deepEqual(doc.sections, [])
  assert.equal(doc.plainText, '')

  const diagnostic = doc.diagnostics.find(item => item.code === 'NO_TEXT_LAYER')
  assert.ok(diagnostic !== undefined, '缺少 NO_TEXT_LAYER 诊断')
  assert.equal(diagnostic.severity, 'error')
  assert.match(diagnostic.message, /OCR/)
  // 本环境没接 OCR，因此不能声称能读出内容。
  assert.equal(doc.confidence, 'structure-preserved')
})

test('部分页无文本层时同样降为 partial，并说明是哪几页', async () => {
  const bytes = buildPdf({ pages: [{ lines: ['has text layer'] }, { lines: [] }] })
  const doc = await parse('mixed.pdf', bytes)

  assert.equal(doc.status, 'partial')
  assert.equal(doc.sections.length, 1)
  assert.equal(doc.sections[0]!.sourceRef, 'mixed.pdf#page=1')
  const diagnostic = doc.diagnostics.find(item => item.code === 'NO_TEXT_LAYER')
  assert.equal(diagnostic?.severity, 'warning')
  assert.match(diagnostic?.message ?? '', /有 1 页没有可提取文本（共 2 页）/)
})

test('损坏的 PDF 返回 parse-failed，不返回被截断的假内容', async () => {
  const doc = await parse('broken.pdf', brokenPdf())

  assert.equal(doc.status, 'parse-failed')
  assert.equal(doc.format, 'pdf')
  assert.deepEqual(doc.sections, [])
  assert.equal(doc.plainText, '')
  assert.ok(codes(doc).includes('STRUCTURED_PARSE_FAILED'))
})

test('加密 PDF 明确返回 unsupported + DOCUMENT_ENCRYPTED，而不是空内容', async () => {
  const doc = await parse('locked.pdf', buildEncryptedPdf('user-pw', 'owner-pw', 'Confidential clause'))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'pdf')
  assert.deepEqual(doc.sections, [])
  const diagnostic = doc.diagnostics.find(item => item.code === 'DOCUMENT_ENCRYPTED')
  assert.ok(diagnostic !== undefined, '缺少 DOCUMENT_ENCRYPTED 诊断')
  assert.match(diagnostic.message, /密码保护/)
})

test('含 JavaScript 的 PDF 只被诊断，不被执行，正文照常解析', async () => {
  const doc = await parse('scripted.pdf', buildPdfWithJavaScript())

  assert.equal(doc.status, 'parsed')
  const diagnostic = doc.diagnostics.find(item => item.code === 'DANGEROUS_PART_REMOVED')
  assert.ok(diagnostic !== undefined, '缺少 DANGEROUS_PART_REMOVED 诊断')
  assert.equal(diagnostic.severity, 'warning')
  assert.match(diagnostic.message, /PDF JavaScript 动作/)
  assert.match(diagnostic.message, /打开时自动执行的动作/)
  assert.match(diagnostic.message, /不会生效/)
  // 关键：脚本没有被执行，提取到的仍然是文档文字。
  assert.match(doc.plainText, /Click to run script/)
})

test('扩展名是 .pdf 但内容不是 PDF 时，不退回按文本读取', async () => {
  const doc = await parse('fake.pdf', new TextEncoder().encode('# 这其实是 markdown\n'))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'pdf')
  assert.equal(doc.plainText, '')
  assert.deepEqual(doc.sections, [])
  assert.ok(codes(doc).includes('FORMAT_MAGIC_BYTES_MISMATCH'))
})

test('超出页数上限返回 limit-exceeded，而不是只读前几页后声称成功', async () => {
  const bytes = buildPdf({ pages: [{ lines: ['p1'] }, { lines: ['p2'] }, { lines: ['p3'] }] })
  const doc = await parse('many.pdf', bytes, { limits: { maxPages: 2 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.ok(codes(doc).includes('LIMIT_EXCEEDED'))
  assert.deepEqual(doc.sections, [])
})

test('pageRange 完全落在文档之外时返回 limit-exceeded，而不是静默返回空结果', async () => {
  const bytes = buildPdf({ pages: [{ lines: ['only page'] }] })
  const doc = await parse('one.pdf', bytes, { pageRange: { from: 5, to: 9 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.ok(codes(doc).includes('LIMIT_EXCEEDED'))
})

test('页内基线多次回跳时给出 TEXT_ORDER_SUSPECT，提示行序可能不等于阅读顺序', async () => {
  const lines = Array.from({ length: 10 }, (_value, index) => `column line ${index + 1}`)
  const doc = await parse('columns.pdf', buildPdf({ pages: [{ lines, reversedOrder: true }] }))

  assert.equal(doc.status, 'parsed')
  const diagnostic = doc.diagnostics.find(item => item.code === 'TEXT_ORDER_SUSPECT')
  assert.ok(diagnostic !== undefined, '缺少 TEXT_ORDER_SUSPECT 诊断')
  assert.equal(diagnostic.severity, 'warning')
  assert.match(diagnostic.message, /第 1 页/)
})

test('行数太少时不报顺序异常，避免把正常单行页判成多栏', async () => {
  const doc = await parse('short.pdf', buildPdf({ pages: [{ lines: ['a', 'b'], reversedOrder: true }] }))
  assert.equal(doc.diagnostics.some(item => item.code === 'TEXT_ORDER_SUSPECT'), false)
})

test('解析被取消时返回结构化失败，不挂起也不抛异常', async () => {
  const controller = new AbortController()
  controller.abort()
  const bytes = buildPdf({ pages: [{ lines: ['cancelled'] }] })

  const doc = await defaultParserRegistry().parse({
    path: 'cancel.pdf',
    absolutePath: '/w/cancel.pdf',
    bytes,
    signal: controller.signal,
  })

  assert.notEqual(doc.status, 'parsed')
  assert.ok(codes(doc).includes('PARSE_ABORTED'), `期望 PARSE_ABORTED，实际 ${codes(doc).join(', ')}`)
})
