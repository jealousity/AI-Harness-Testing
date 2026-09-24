/**
 * XLSX 解析测试（docs/10 §5.6.10 的 Excel 部分）。
 *
 * 重点覆盖 §5.6.5 C 的每一条：多 sheet 与 sheet 选择、日期/布尔/错误/公式的
 * 显示值与原始类型、隐藏 sheet 默认不读、合并单元格、空行策略，以及
 * `sourceRef` 细化到 `#sheet=接口!A2:F20`。
 *
 * @file 中的日期序列号期望值由 Excel 规则推算并经实测确认：
 * 45292 → 2024-01-01、45293 → 2024-01-02、45292.5 → 2024-01-01 12:00:00。
 *
 * @module test/documents-xlsx
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { defaultParserRegistry, type DocumentParseInput, type ParsedDocument } from '../src/documents/index.ts'
import { buildDocx, buildXlsx, buildZip, truncatedZip, type XlsxCell, type XlsxSpec } from './document-fixtures.ts'

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

/** OLE2 复合文档头（`.xls`）。 */
const OLE2_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]

/** 主样本：日期 / 布尔 / 错误 / 内联字符串 / 空行 / 筛选 / 冻结 / 表格定义 / 隐藏 sheet。 */
const MAIN: XlsxSpec = {
  sheets: [
    {
      name: '接口需求',
      rows: [
        ['用例ID', '接口', '创建日期', '优先级', '自动化', '结果'],
        ['TC-1', '/api/login', { number: 45292, numFmtId: 14 }, 1, { boolean: true }, { error: '#DIV/0!' }],
        ['TC-2', '/api/reset', { number: 45293, numFmtId: 14 }, 2, { boolean: false }, '通过'],
        // 内部空行必须保留：否则行号与原始 sheet 就对不上了。
        null,
        ['TC-3', { inline: '/api/logout' }, { number: 45292.5, numFmtId: 22 }, 3, { boolean: true }, '通过'],
      ],
      autoFilter: 'A1:F5',
      freezePane: 'A2',
      table: { name: '接口用例', ref: 'A1:F5' },
    },
    {
      name: '公式',
      rows: [
        ['名称', '公式', '备注'],
        ['合计', { formula: 'SUM(1,2,3)', cached: 6 }, '有缓存值'],
        ['平均', { formula: 'AVERAGE(1,2,3)' }, '无缓存值'],
      ],
    },
    {
      // 真实 Excel 里合并区域只有左上角单元格有值，其余位置在 XML 里根本不存在。
      name: '合并',
      rows: [
        ['标题', null, '备注'],
        ['合并值', null, 'x'],
        [null, null, 'y'],
      ],
      merges: ['A2:C2'],
    },
    { name: '隐藏数据', hidden: true, rows: [['内部', '过程数据'], ['x', 'y']] },
    { name: '空表', rows: [null] },
  ],
  title: '接口用例集',
  creator: '李四',
}

// ── 正常样本 ─────────────────────────────────────────────────────────────────

test('XLSX 多 sheet：默认只读可见 sheet，隐藏 sheet 被跳过并说明原因', async () => {
  const doc = await parse('cases.xlsx', buildXlsx(MAIN))

  assert.equal(doc.status, 'parsed')
  assert.equal(doc.format, 'xlsx')
  assert.equal(doc.confidence, 'structure-preserved')
  assert.equal(doc.mediaType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

  // sheetNames 报告工作簿的**全部** sheet，包括没读的那个——否则调用方无法知道漏了什么。
  assert.deepEqual([...doc.sheetNames!], ['接口需求', '公式', '合并', '隐藏数据', '空表'])
  assert.equal(doc.metadata.sheetCount, 5)
  assert.equal(doc.metadata.sheetsRead, 4)
  assert.equal(doc.metadata.hiddenSheetsSkipped, '隐藏数据')

  const diagnostic = doc.diagnostics.find(item => item.code === 'HIDDEN_SHEET_SKIPPED')
  assert.ok(diagnostic !== undefined, '缺少 HIDDEN_SHEET_SKIPPED 诊断')
  assert.match(diagnostic.message, /隐藏数据/)
  assert.match(diagnostic.message, /includeHiddenSheets=true/)

  // 隐藏 sheet 的内容绝不能混进结果。
  assert.equal(doc.tables.some(table => table.sheet === '隐藏数据'), false)
  assert.equal(doc.sections.some(section => section.sheet === '隐藏数据'), false)
  assert.doesNotMatch(doc.plainText, /过程数据/)
  // 但"有哪些 sheet 没读"本身要成为可检索的知识。
  const skipped = doc.sections.find(section => section.title === '跳过的隐藏 sheet')
  assert.ok(skipped !== undefined)
  assert.match(skipped.text, /隐藏数据/)
  assert.equal(skipped.sourceRef, 'cases.xlsx#sheet=#hidden')
})

test('XLSX sourceRef 细化到 sheet + 区域，rowRefs 细化到行', async () => {
  const doc = await parse('cases.xlsx', buildXlsx(MAIN))
  const table = doc.tables.find(item => item.sheet === '接口需求')!

  assert.equal(table.title, '接口需求')
  assert.equal(table.sourceRef, 'cases.xlsx#sheet=接口需求!A1:F5')
  assert.deepEqual([...table.rowRefs!], [
    'cases.xlsx#sheet=接口需求!A2:F2',
    'cases.xlsx#sheet=接口需求!A3:F3',
    'cases.xlsx#sheet=接口需求!A4:F4',
    'cases.xlsx#sheet=接口需求!A5:F5',
  ])
})

test('XLSX 日期/布尔/错误/内联字符串：显示值与原始类型同时保留', async () => {
  const doc = await parse('cases.xlsx', buildXlsx(MAIN))
  const table = doc.tables.find(item => item.sheet === '接口需求')!

  assert.deepEqual([...table.headers], ['用例ID', '接口', '创建日期', '优先级', '自动化', '结果'])
  assert.deepEqual(table.rows.map(row => [...row]), [
    ['TC-1', '/api/login', '2024-01-01', '1', 'TRUE', '#DIV/0!'],
    ['TC-2', '/api/reset', '2024-01-02', '2', 'FALSE', '通过'],
    // 内部空行保留（行号不能漂移）。
    ['', '', '', '', '', ''],
    ['TC-3', '/api/logout', '2024-01-01 12:00:00', '3', 'TRUE', '通过'],
  ])

  // §5.6.5 C：显示值与原始类型必须区分——文本 '2024-01-01' 与日期单元格显示值完全相同。
  assert.deepEqual([...table.headerTypes!], ['string', 'string', 'string', 'string', 'string', 'string'])
  assert.deepEqual(table.cellTypes!.map(row => [...row]), [
    ['string', 'string', 'date', 'number', 'boolean', 'error'],
    ['string', 'string', 'date', 'number', 'boolean', 'string'],
    ['empty', 'empty', 'empty', 'empty', 'empty', 'empty'],
    ['string', 'string', 'datetime', 'number', 'boolean', 'string'],
  ])
})

test('XLSX 1900 假闰日：序列号 60 不伪造出不存在的 1900-02-29', async () => {
  const doc = await parse('serial.xlsx', buildXlsx({
    sheets: [{
      name: 'S',
      rows: [
        ['名称', '日期'],
        ['59', { number: 59, numFmtId: 14 }],
        ['60', { number: 60, numFmtId: 14 }],
        ['61', { number: 61, numFmtId: 14 }],
      ],
    }],
  }))
  const table = doc.tables[0]!

  // Excel 为兼容 Lotus 1-2-3 把 1900 当闰年，于是序列号 60 指向一个不存在的日期。
  // 解析器按真实日历处理：60 与 59 都落在 1900-02-28，61 才是 1900-03-01。
  assert.deepEqual(table.rows.map(row => [...row]), [
    ['59', '1900-02-28'],
    ['60', '1900-02-28'],
    ['61', '1900-03-01'],
  ])
})

test('XLSX 公式只读缓存值，无缓存值时明确报 FORMULA_VALUE_UNAVAILABLE 且绝不自行计算', async () => {
  const doc = await parse('formula.xlsx', buildXlsx(MAIN))
  const table = doc.tables.find(item => item.sheet === '公式')!

  assert.deepEqual(table.rows.map(row => [...row]), [
    ['合计', '6', '有缓存值'],
    // 无缓存值 → 按空值处理，绝不猜出 2 这个平均值。
    ['平均', '', '无缓存值'],
  ])
  assert.deepEqual([...table.cellTypes![1]!], ['string', 'empty', 'string'])

  const diagnostic = doc.diagnostics.find(item => item.code === 'FORMULA_VALUE_UNAVAILABLE')
  assert.ok(diagnostic !== undefined, '缺少 FORMULA_VALUE_UNAVAILABLE 诊断')
  assert.match(diagnostic.message, /1 个公式单元格没有缓存计算值/)
  assert.match(diagnostic.message, /不会自行计算公式/)

  // §5.6.5 C「同时可保留公式文本」：无论有无缓存值，公式原文都保留。
  assert.equal(doc.metadata.formulaCellsWithoutCache, 1)
  assert.equal(
    doc.metadata.formulaCells,
    '公式!B2=SUM(1,2,3); 公式!B3=AVERAGE(1,2,3)',
  )
})

test('XLSX 合并单元格：只有左上角有值，范围写进 metadata 与诊断', async () => {
  const doc = await parse('merge.xlsx', buildXlsx(MAIN))
  const table = doc.tables.find(item => item.sheet === '合并')!

  assert.deepEqual(table.rows.map(row => [...row]), [
    ['合并值', '', 'x'],
    ['', '', 'y'],
  ])
  assert.equal(doc.metadata.mergedCells, '合并!A2:C2')
  assert.equal(doc.metadata.mergedCellCount, 1)

  const diagnostic = doc.diagnostics.find(item => item.code === 'MERGED_CELLS')
  assert.ok(diagnostic !== undefined, '缺少 MERGED_CELLS 诊断')
  assert.match(diagnostic.message, /sheet「合并」含 1 处合并单元格（A2:C2）/)
  assert.match(diagnostic.message, /只有左上角单元格有值/)
})

test('XLSX 筛选范围/冻结窗格/表格定义成为可检索的知识与 metadata', async () => {
  const doc = await parse('cases.xlsx', buildXlsx(MAIN))

  assert.equal(doc.metadata.autoFilters, '接口需求!A1:F5')
  assert.equal(doc.metadata.frozenPanes, '接口需求=A2')
  assert.equal(doc.metadata.tableDefinitions, '接口需求: 接口用例(A1:F5)')
  assert.equal(doc.metadata.sheetDimensions, '接口需求!A1:F5; 公式!A1:C3; 合并!A1:C3')

  const section = doc.sections.find(item => item.sheet === '接口需求')!
  assert.equal(section.title, 'sheet: 接口需求')
  assert.equal(section.sourceRef, 'cases.xlsx#sheet=接口需求')
  assert.match(section.text, /表格定义：接口用例\(A1:F5\)/)
  assert.match(section.text, /自动筛选范围：A1:F5/)
  assert.match(section.text, /冻结窗格：A2/)
})

test('XLSX 空 sheet 不产出表格，但仍登记它的存在与尺寸', async () => {
  const doc = await parse('cases.xlsx', buildXlsx(MAIN))

  assert.equal(doc.tables.some(table => table.sheet === '空表'), false)
  const section = doc.sections.find(item => item.sheet === '空表')!
  assert.match(section.text, /有效区域 0 行 × 0 列，共 0 个非空单元格。/)
})

test('XLSX sheetNames 只读指定 sheet，名字不存在只警告不报错', async () => {
  const bytes = buildXlsx(MAIN)

  const only = await parse('cases.xlsx', bytes, { sheetNames: ['公式'] })
  assert.equal(only.limits.sheetsRead, 1)
  assert.deepEqual(only.tables.map(table => table.sheet), ['公式'])
  assert.equal(only.sections.length, 1)

  const missing = await parse('cases.xlsx', bytes, { sheetNames: ['不存在'] })
  assert.equal(missing.limits.sheetsRead, 0)
  assert.match(messages(missing), /请求的 sheet 不存在，已忽略：不存在/)
  // 警告里必须列出实际有哪些 sheet，否则调用方无从修正。
  assert.match(messages(missing), /工作簿实际含 接口需求, 公式, 合并, 隐藏数据, 空表/)
})

test('XLSX includeHiddenSheets=true 时才读隐藏 sheet', async () => {
  const doc = await parse('cases.xlsx', buildXlsx(MAIN), { includeHiddenSheets: true })

  assert.equal(doc.limits.sheetsRead, 5)
  assert.equal(codes(doc).includes('HIDDEN_SHEET_SKIPPED'), false)
  assert.equal(doc.metadata.hiddenSheetsSkipped, undefined)

  // 隐藏 sheet 的行数据只有在显式要求时才进入 tables。
  const hidden = doc.tables.find(table => table.sheet === '隐藏数据')!
  assert.deepEqual(hidden.rows.map(row => [...row]), [['x', 'y']])
})

test('XLSX sheet 名含空格时 sourceRef 按 Excel 规则加单引号', async () => {
  const doc = await parse('space.xlsx', buildXlsx({
    sheets: [{ name: '接口 需求', rows: [['a', 'b'], ['1', '2']] }],
  }))

  assert.equal(doc.tables[0]!.sourceRef, "space.xlsx#sheet='接口 需求'!A1:B2")
  assert.equal(doc.tables[0]!.rowRefs![0], "space.xlsx#sheet='接口 需求'!A2:B2")
  assert.equal(doc.sections[0]!.sourceRef, "space.xlsx#sheet='接口 需求'")
})

test('XLSX date1904 工作簿按 1904 纪元换算', async () => {
  const doc = await parse('mac.xlsx', buildXlsx({
    date1904: true,
    sheets: [{ name: 'S', rows: [['名称', '日期'], ['x', { number: 45000, numFmtId: 14 }]] }],
  }))

  assert.equal(doc.metadata.date1904, true)
  assert.deepEqual([...doc.tables[0]!.rows[0]!], ['x', '2027-03-16'])
})

test('XLSX 文档属性取的是文档自己声明的值', async () => {
  const doc = await parse('cases.xlsx', buildXlsx(MAIN))
  assert.equal(doc.metadata.title, '接口用例集')
  assert.equal(doc.metadata.creator, '李四')
  assert.equal(doc.metadata.company, '示例公司')
})

test('XLSX 尾部空行裁掉、内部空行保留（即 Excel 的"已用区域"）', async () => {
  const doc = await parse('tail.xlsx', buildXlsx({
    sheets: [{ name: 'S', rows: [['a'], ['1'], null, null, null] }],
  }))
  const table = doc.tables[0]!

  // 只有 A1:A2 有内容，因此有效区域是 2 行——尾部空行不进入表格。
  assert.deepEqual(table.rows.map(row => [...row]), [['1']])
  assert.equal(table.sourceRef, 'tail.xlsx#sheet=S!A1:A2')
})

test('XLSX 只保留引用到的 sheet 部件，未选中的 sheet 字节从不被解压', async () => {
  // 隐藏 sheet 的 XML 本身是 4 MiB 高压缩比内容。默认不读隐藏 sheet，
  // 因此它不该被解压——这是"两趟解包"的直接证据（§5.6.5 C 的主要防线）。
  const bomb = new Uint8Array(4 * 1024 * 1024)
  const bytes = buildXlsx({
    sheets: [
      { name: '可见', rows: [['a', 'b'], ['1', '2']] },
      { name: '隐藏炸弹', hidden: true, rows: [['x']] },
    ],
    extraParts: { 'xl/worksheets/sheet2.xml': bomb },
  })

  const skipped = await parse('bomb.xlsx', bytes, { limits: { maxZipEntryBytes: 64 * 1024 } })
  assert.equal(skipped.status, 'parsed')
  assert.deepEqual(skipped.tables.map(table => table.sheet), ['可见'])

  // 显式要求读隐藏 sheet 时才会碰到它——此时必须被硬上限拦下。
  const included = await parse('bomb.xlsx', bytes, {
    includeHiddenSheets: true,
    limits: { maxZipEntryBytes: 64 * 1024 },
  })
  assert.equal(included.status, 'limit-exceeded')
  assert.ok(codes(included).includes('LIMIT_EXCEEDED'))
})

test('XLSX includeTables=false / includeMetadata=false 时对应字段为空', async () => {
  const bytes = buildXlsx(MAIN)

  const noTables = await parse('cases.xlsx', bytes, { includeTables: false })
  assert.deepEqual(noTables.tables, [])
  assert.equal(noTables.sections.length, 5)

  const noMetadata = await parse('cases.xlsx', bytes, { includeMetadata: false })
  assert.deepEqual(noMetadata.metadata, {})
  assert.equal(noMetadata.tables.length, 3)
})

// ── 异常样本 ─────────────────────────────────────────────────────────────────

test('截断的 XLSX 返回 parse-failed，不基于残缺文件头"成功"解出半截内容', async () => {
  const doc = await parse('truncated.xlsx', truncatedZip({ '[Content_Types].xml': '<Types/>' }))

  assert.equal(doc.status, 'parse-failed')
  assert.equal(doc.format, 'xlsx')
  assert.ok(codes(doc).includes('STRUCTURED_PARSE_FAILED'))
})

test('缺 [Content_Types].xml 的 ZIP 不算有效工作簿', async () => {
  const doc = await parse('nocontenttypes.xlsx', buildZip({ 'xl/workbook.xml': '<workbook/>' }))
  assert.equal(doc.status, 'parse-failed')
  assert.match(messages(doc), /缺少 \[Content_Types\]\.xml/)
})

test('缺 Excel 主工作簿内容类型时返回 parse-failed', async () => {
  const doc = await parse('wrongtype.xlsx', buildZip({
    '[Content_Types].xml': '<Types><Default Extension="xml" ContentType="application/xml"/></Types>',
    'xl/workbook.xml': '<workbook/>',
  }))
  assert.equal(doc.status, 'parse-failed')
  assert.match(messages(doc), /没有 Excel 主工作簿内容类型/)
})

test('.xlsx 里装的是 Word 文档时以内容为准报 FORMAT_MAGIC_BYTES_MISMATCH', async () => {
  const doc = await parse('actually-docx.xlsx', buildDocx({ body: [{ kind: 'paragraph', text: '正文' }] }))

  assert.equal(doc.status, 'unsupported')
  assert.ok(codes(doc).includes('FORMAT_MAGIC_BYTES_MISMATCH'))
  assert.match(messages(doc), /实际是 Word 文档/)
})

test('.xlsx 共享 ZIP 签名但内容不是 ZIP 时，不能因为签名相同就路由到 docx', async () => {
  // 扩展名必须参与消歧：ZIP 签名同时属于 docx 与 xlsx（document-detect 的
  // resolveContainerFormat）。这里内容是纯文本，两个格式都不该接受它。
  const doc = await parse('fake.xlsx', new TextEncoder().encode('a,b,c\n1,2,3\n'))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'xlsx')
  assert.equal(doc.plainText, '')
  assert.ok(codes(doc).includes('FORMAT_MAGIC_BYTES_MISMATCH'))
})

test('.xls 老二进制格式在未配置适配器时明确 unsupported 并提示转换', async () => {
  const doc = await parse('old.xls', new Uint8Array(OLE2_HEADER))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'xls')
  assert.match(messages(doc), /转换为 \.xlsx/)
  assert.ok(codes(doc).includes('FORMAT_NOT_SUPPORTED'))
})

test('XLSX 超行数上限时截断并降为 partial，同时明确标出截断', async () => {
  const rows: (readonly XlsxCell[] | null)[] = [['id', 'value']]
  for (let index = 1; index <= 6; index += 1) rows.push([`r${index}`, index])
  const doc = await parse('many.xlsx', buildXlsx({ sheets: [{ name: 'S', rows }] }), {
    limits: { maxRowsPerSheet: 3 },
  })

  assert.equal(doc.status, 'partial')
  assert.equal(doc.limits.truncated, true)
  assert.ok(codes(doc).includes('TRUNCATED'))
  assert.match(messages(doc), /超出解析上限/)
  // 截断后不得声称拿到了完整数据。
  assert.equal(doc.tables[0]!.rows.length, 2)
})

test('XLSX 超列数上限时同样截断，且不静默丢列', async () => {
  const doc = await parse('wide.xlsx', buildXlsx({
    sheets: [{ name: 'S', rows: [['a', 'b', 'c', 'd'], ['1', '2', '3', '4']] }],
  }), { limits: { maxColumnsPerSheet: 2 } })

  assert.equal(doc.status, 'partial')
  assert.equal(doc.limits.truncated, true)
  assert.deepEqual([...doc.tables[0]!.headers], ['a', 'b'])
})

test('XLSX 工作簿里没有任何 sheet 时给出 EMPTY_CONTENT 而不是静默空结果', async () => {
  const doc = await parse('nosheets.xlsx', buildXlsx({ sheets: [] }))

  assert.equal(doc.status, 'partial')
  assert.ok(codes(doc).includes('EMPTY_CONTENT'))
  assert.deepEqual([...doc.sheetNames!], [])
})

test('XLSX 解析被取消时返回结构化失败', async () => {
  const controller = new AbortController()
  controller.abort()
  const doc = await defaultParserRegistry().parse({
    path: 'cancel.xlsx',
    absolutePath: '/w/cancel.xlsx',
    bytes: buildXlsx(MAIN),
    signal: controller.signal,
  })

  assert.notEqual(doc.status, 'parsed')
  assert.ok(codes(doc).includes('PARSE_ABORTED'), `期望 PARSE_ABORTED，实际 ${codes(doc).join(', ')}`)
})

test('同一份 XLSX 重复解析结果一致，内容变更后 sha256 与表格都变', async () => {
  const first = buildXlsx({ sheets: [{ name: 'S', rows: [['a'], ['1']] }] })
  const second = buildXlsx({ sheets: [{ name: 'S', rows: [['a'], ['2']] }] })

  const a1 = await parse('same.xlsx', first)
  const a2 = await parse('same.xlsx', first)
  assert.equal(a1.sha256, a2.sha256)
  assert.deepEqual(a1.tables, a2.tables)

  const b = await parse('same.xlsx', second)
  assert.notEqual(b.sha256, a1.sha256)
  assert.notDeepEqual(b.tables[0]!.rows, a1.tables[0]!.rows)
})
