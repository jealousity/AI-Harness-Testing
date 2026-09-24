/**
 * 文本族样本与编码测试（docs/10 §5.6.10 的 Markdown / CSV / TSV / 编码部分）。
 *
 * §5.6.10 明确要求覆盖「含嵌套列表、引用、代码块和表格的 Markdown」与
 * 「CSV/TSV 含引号、换行、中文、空列和 CRLF」，以及「非 UTF-8 文本」和
 * 「magic bytes 与扩展名不一致」。这些样本的解析器在 `documents/` 里已经就位，
 * 本文件把它们的**行为**固定下来，避免后续改动静默破坏结构保留能力。
 *
 * @module test/documents-text-samples
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaultParserRegistry, type DocumentParseInput, type ParsedDocument } from '../src/documents/index.ts'
import { buildPdf } from './document-fixtures.ts'

const signal = new AbortController().signal

function parse(path: string, text: string | Uint8Array, extra: Partial<DocumentParseInput> = {}): Promise<ParsedDocument> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text
  return defaultParserRegistry().parse({ path, absolutePath: `/w/${path}`, bytes, signal, ...extra })
}

function codes(doc: ParsedDocument): string[] {
  return doc.diagnostics.map(item => item.code)
}

// ── Markdown ─────────────────────────────────────────────────────────────────

test('Markdown 中英文标题都按层级与编号路径切分', async () => {
  const doc = await parse('kb.md', [
    '# 项目知识库',
    '',
    '## Project Overview',
    '',
    '正文一。',
    '',
    '### 登录需求',
    '',
    '正文二。',
    '',
  ].join('\n'))

  assert.equal(doc.status, 'parsed')
  assert.equal(doc.format, 'markdown')
  assert.deepEqual(doc.sections.map(section => section.title), ['项目知识库', 'Project Overview', '登录需求'])
  assert.deepEqual(doc.sections.map(section => section.level), [1, 2, 3])
  assert.deepEqual(doc.sections.map(section => section.sourceRef), [
    'kb.md#heading=1',
    'kb.md#heading=1.1',
    'kb.md#heading=1.1.1',
  ])
})

test('Markdown 嵌套列表/引用/代码块/表格：结构全部保留且顺序不变', async () => {
  const doc = await parse('guide.md', [
    '# 指南',
    '',
    '## 概述',
    '',
    '> 引用：本文件描述登录需求。',
    '',
    '### 嵌套列表',
    '',
    '- 一级',
    '  - 二级',
    '    - 三级',
    '',
    '```ts',
    "const token = 'not executed'",
    '```',
    '',
    '| 字段 | 必填 |',
    '| --- | --- |',
    '| token | 是 |',
    '',
  ].join('\n'))

  assert.deepEqual(doc.sections.map(section => section.title), ['指南', '概述', '嵌套列表'])
  // blockquote 保留为文本（不下载、不重写）。
  assert.equal(doc.sections[1]!.text, '> 引用：本文件描述登录需求。')

  // 嵌套列表的缩进层级必须保留，否则"三级项"会退化成与一级项同级。
  assert.match(doc.sections[2]!.text, /- 一级\n {2}- 二级\n {4}- 三级/)
  // 代码块原样保留（含围栏与语言标记），且内容从未被执行。
  assert.match(doc.sections[2]!.text, /```ts\nconst token = 'not executed'\n```/)

  assert.equal(doc.metadata.codeBlockCount, 1)
  assert.equal(doc.metadata.codeLanguages, 'ts')

  // 表格结构进 tables，sourceRef 带 heading 编号，行级可追溯。
  assert.equal(doc.tables.length, 1)
  assert.equal(doc.tables[0]!.sourceRef, 'guide.md#heading=1.1.1,table=1')
  assert.deepEqual(doc.tables[0]!.rowRefs, ['guide.md#heading=1.1.1,table=1,row=1'])
  assert.deepEqual(doc.tables[0]!.rows.map(row => [...row]), [['token', '是']])
})

test('Markdown 未闭合代码块给出 TRUNCATED 提示，而不是静默吞掉剩余内容', async () => {
  const doc = await parse('open.md', '# 标题\n\n```ts\nconst a = 1\n')

  assert.match(doc.plainText, /const a = 1/)
  assert.ok(codes(doc).includes('TRUNCATED'))
})

// ── CSV / TSV ────────────────────────────────────────────────────────────────

test('CSV 覆盖引号、字段内换行、中文、空列与 CRLF', async () => {
  // 一行一个病理特征：内嵌分隔符、内嵌换行、双引号转义、空列、CRLF。
  const doc = await parse(
    'cases.csv',
    'id,标题,期望,备注\r\nc1,"含,逗号",200,\r\nc2,"多\n行",404,"含""引号"""\r\n',
  )

  assert.equal(doc.status, 'parsed')
  assert.equal(doc.format, 'csv')
  assert.deepEqual([...doc.tables[0]!.headers], ['id', '标题', '期望', '备注'])
  assert.deepEqual(doc.tables[0]!.rows.map(row => [...row]), [
    ['c1', '含,逗号', '200', ''],
    ['c2', '多\n行', '404', '含"引号"'],
  ])
  // 行级 ref 与原始行一一对应，包括含换行的那一行。
  assert.deepEqual(doc.tables[0]!.rowRefs, ['cases.csv#table=1,row=1', 'cases.csv#table=1,row=2'])
  assert.equal(doc.metadata.delimiter, 'comma')
  assert.equal(doc.metadata.rowCount, 2)
  assert.equal(doc.metadata.columnCount, 4)
})

test('CSV 行内列数不一致时补空并报 RAGGED_ROWS，不静默错位', async () => {
  const doc = await parse('ragged.csv', 'a,b,c\n1,2\n')

  assert.deepEqual(doc.tables[0]!.rows.map(row => [...row]), [['1', '2', '']])
  assert.ok(codes(doc).includes('RAGGED_ROWS'))
})

test('CSV 未闭合引号整体失败，不返回字段错位的假表', async () => {
  const doc = await parse('broken.csv', 'a,b\n"未闭合,2\n')

  assert.equal(doc.status, 'parse-failed')
  assert.deepEqual(doc.tables, [])
  assert.ok(codes(doc).includes('UNTERMINATED_QUOTE'))
})

test('TSV 用制表符分隔，含中文与空列', async () => {
  const doc = await parse('cases.tsv', 'id\t标题\t备注\r\nc1\t登录\t\r\n')

  assert.equal(doc.format, 'tsv')
  assert.equal(doc.metadata.delimiter, 'tab')
  assert.deepEqual([...doc.tables[0]!.headers], ['id', '标题', '备注'])
  assert.deepEqual(doc.tables[0]!.rows.map(row => [...row]), [['c1', '登录', '']])
})

// ── 编码与 magic bytes ───────────────────────────────────────────────────────

test('非 UTF-8 文本按有损解码并明确警告，绝不静默当成正常文本', async () => {
  // GBK 编码的「中文」：0xD6 0xD0 0xCE 0xC4 不是合法 UTF-8 序列。
  const doc = await parse('gbk.txt', new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))

  assert.equal(doc.status, 'parsed')
  const diagnostic = doc.diagnostics.find(item => item.code === 'ENCODING_NOT_UTF8')
  assert.ok(diagnostic !== undefined, '缺少 ENCODING_NOT_UTF8 诊断')
  assert.equal(diagnostic.severity, 'warning')
  assert.match(diagnostic.message, /U\+FFFD/)
  // 解不出来的字节变成替换字符，而不是原样当成"看起来正常"的文本。
  assert.match(doc.plainText, /\uFFFD/)
})

test('带 BOM 的 UTF-8 文本不报编码警告', async () => {
  const doc = await parse('bom.txt', new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('正文\n')]))

  assert.equal(doc.status, 'parsed')
  assert.equal(codes(doc).includes('ENCODING_NOT_UTF8'), false)
  assert.match(doc.plainText, /正文/)
})

test('扩展名与内容不一致时以内容为准，并明确报 FORMAT_MAGIC_BYTES_MISMATCH', async () => {
  // .txt 里装着真正的 PDF。扩展名不可信（§5.6.5 A 第一条）。
  const doc = await parse('disguised.txt', buildPdf({ pages: [{ lines: ['really a pdf'] }] }))

  assert.equal(doc.format, 'pdf')
  assert.equal(doc.status, 'parsed')
  assert.match(doc.plainText, /really a pdf/)
  const diagnostic = doc.diagnostics.find(item => item.code === 'FORMAT_MAGIC_BYTES_MISMATCH')
  assert.ok(diagnostic !== undefined, '缺少 FORMAT_MAGIC_BYTES_MISMATCH 诊断')
  assert.match(diagnostic.message, /但扩展名是 text；以内容为准/)
})

test('扩展名声明二进制格式但内容对不上时既不按该格式解析，也不退回按文本读', async () => {
  const doc = await parse('fake.pdf', new TextEncoder().encode('# 其实是 markdown\n'))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'pdf')
  assert.equal(doc.plainText, '')
  assert.deepEqual(doc.sections, [])
  assert.match(doc.diagnostics.map(item => item.message).join(' '), /不会按文本读取/)
})

test('无法判定格式的二进制内容返回 unsupported + FORMAT_UNKNOWN，不猜成文本', async () => {
  const doc = await parse('blob.bin', new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f]))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'unknown')
  assert.equal(doc.plainText, '')
  assert.ok(codes(doc).includes('FORMAT_UNKNOWN'))
})

test('formatHint 不能把已识别的格式说成别的格式', async () => {
  // 内容是可识别的 PDF，hint 说 markdown：检测阶段以 magic bytes 为准，
  // hint 只在"完全判不出"时兜底（§5.6.5 A）。
  const doc = await parse('hinted.pdf', buildPdf({ pages: [{ lines: ['pdf wins'] }] }), {
    formatHint: 'markdown',
  })

  assert.equal(doc.format, 'pdf')
  assert.match(doc.plainText, /pdf wins/)
})
