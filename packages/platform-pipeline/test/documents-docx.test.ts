/**
 * DOCX 解析测试（docs/10 §5.6.10 的 Word 部分）。
 *
 * 覆盖 §5.6.5 B 的每条要求：标题层级、列表、表格、合并单元格（不复制内容）、
 * 页眉/页脚策略、宏与嵌入对象、外部链接、`.doc` 的不支持声明。
 *
 * @module test/documents-docx
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  defaultParserRegistry,
  DocumentParserRegistry,
  type DocumentParseInput,
  type DocumentParser,
  type ParsedDocument,
} from '../src/documents/index.ts'
import {
  buildDocx,
  buildXlsx,
  buildZip,
  buildZipBomb,
  truncatedZip,
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

/** OLE2 复合文档头（`.doc` / `.xls` 共用）。 */
const OLE2_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00]

// ── 正常样本 ─────────────────────────────────────────────────────────────────

test('DOCX 标题/段落/列表：章节按标题分组，sourceRef 用 heading 编号路径', async () => {
  const bytes = buildDocx({
    body: [
      { kind: 'heading', level: 1, text: '登录需求' },
      { kind: 'paragraph', text: '同一手机号 60s 内只能发一次验证码。' },
      { kind: 'heading', level: 2, text: '令牌有效期' },
      { kind: 'paragraph', text: '令牌 30 分钟过期。' },
      { kind: 'paragraph', text: '超时后必须重新登录。', listLevel: 1 },
      { kind: 'heading', level: 2, text: '重置规则' },
      { kind: 'paragraph', text: '重置链接一次性有效。' },
    ],
  })
  const doc = await parse('spec.docx', bytes)

  assert.equal(doc.status, 'parsed')
  assert.equal(doc.format, 'docx')
  assert.equal(doc.confidence, 'structure-preserved')
  assert.equal(doc.fileName, 'spec.docx')

  assert.deepEqual(doc.sections.map(section => section.title), ['登录需求', '令牌有效期', '重置规则'])
  assert.deepEqual(doc.sections.map(section => section.level), [1, 2, 2])
  assert.deepEqual(doc.sections.map(section => section.sourceRef), [
    'spec.docx#heading=1',
    'spec.docx#heading=1.1',
    'spec.docx#heading=1.2',
  ])
  // 中文正文原样保留（部件是真正的 UTF-8）。
  assert.match(doc.sections[0]!.text, /同一手机号 60s 内只能发一次验证码。/)
  // 列表层级在正文里以缩进体现，否则列表项与普通段落无法区分。
  assert.match(doc.sections[1]!.text, /\n {2}- 超时后必须重新登录。/)
})

test('DOCX 标题识别覆盖三级判据：段落 outlineLvl、styles.xml outlineLvl、样式名兜底', async () => {
  const bytes = buildDocx({
    body: [
      // 判据 3：样式名兜底（styles.xml 里的 Heading1 同时声明了 outlineLvl，因此先走判据 2）。
      { kind: 'heading', level: 1, text: '样式标题' },
      // 判据 2：自定义样式，只有 styles.xml 的 outlineLvl 能识别成标题。
      { kind: 'heading', level: 2, text: '自定义样式标题', styleId: 'RequirementHeading' },
      // 判据 1：段落自身声明 outlineLvl，优先于一切样式信息。
      { kind: 'paragraph', text: '段落级大纲', outlineLevel: 2 },
    ],
  })
  const doc = await parse('headings.docx', bytes)

  assert.deepEqual(doc.sections.map(section => section.title), ['样式标题', '自定义样式标题', '段落级大纲'])
  assert.deepEqual(doc.sections.map(section => section.level), [1, 2, 3])
  assert.deepEqual(doc.sections.map(section => section.sourceRef), [
    'headings.docx#heading=1',
    'headings.docx#heading=1.1',
    'headings.docx#heading=1.1.1',
  ])
})

test('DOCX 没有任何标题时退化为逐段一个 section，而不是一个巨型 section', async () => {
  const bytes = buildDocx({
    body: [
      { kind: 'paragraph', text: '第一条：账号必须绑定手机号。' },
      { kind: 'paragraph', text: '第二条：密码至少 8 位。' },
    ],
  })
  const doc = await parse('plain.docx', bytes)

  assert.equal(doc.sections.length, 2)
  assert.deepEqual(doc.sections.map(section => section.sourceRef), [
    'plain.docx#paragraph=1',
    'plain.docx#paragraph=2',
  ])
})

test('DOCX 表格转成带行级 rowRefs 的 tables，正文里只留占位避免数据重复', async () => {
  const bytes = buildDocx({
    body: [
      { kind: 'heading', level: 1, text: '接口' },
      { kind: 'heading', level: 2, text: '字段表' },
      {
        kind: 'table',
        rows: [
          ['字段', '必填', '说明'],
          ['token', '是', '登录令牌'],
          ['expires', '否', '过期时间'],
        ],
      },
    ],
  })
  const doc = await parse('api.docx', bytes)

  assert.equal(doc.tables.length, 1)
  const table = doc.tables[0]!
  assert.deepEqual([...table.headers], ['字段', '必填', '说明'])
  assert.deepEqual(table.rows.map(row => [...row]), [
    ['token', '是', '登录令牌'],
    ['expires', '否', '过期时间'],
  ])
  assert.equal(table.sourceRef, 'api.docx#heading=1.1,table=1')
  // §5.6.7「表格行必须能追溯到原始表格位置」——没有 rowRefs 就无法回读。
  assert.deepEqual([...(table.rowRefs ?? [])], [
    'api.docx#heading=1.1,table=1,row=1',
    'api.docx#heading=1.1,table=1,row=2',
  ])

  // 正文里只占位，否则同一份数据会在 sections 与 tables 里各出现一次。
  assert.match(doc.sections[1]!.text, /\[表格 1：结构化内容见 tables\]/)
  assert.doesNotMatch(doc.sections[1]!.text, /登录令牌/)
})

test('DOCX 合并单元格：内容只留在首个单元格，范围写进 metadata 与诊断', async () => {
  const bytes = buildDocx({
    body: [
      { kind: 'heading', level: 1, text: '权限' },
      {
        kind: 'table',
        rows: [
          [{ text: '合并表头', gridSpan: 2 }, '值'],
          [{ text: '账号', vMerge: 'restart' }, 'admin', ''],
          [{ text: '账号', vMerge: 'continue' }, 'guest', ''],
        ],
      },
    ],
  })
  const doc = await parse('merge.docx', bytes)

  assert.equal(doc.status, 'parsed')
  const table = doc.tables[0]!
  // 被合并覆盖的表头位置按"空表头补列N"的规则得到中性标签，而不是重复「合并表头」。
  assert.deepEqual([...table.headers], ['合并表头', '列2', '值'])
  // §5.6.5 B：绝不静默复制内容，否则同一句话会在多列/多行里各出现一次。
  assert.deepEqual(table.rows.map(row => [...row]), [
    ['账号', 'admin', ''],
    ['', 'guest', ''],
  ])

  assert.equal(doc.metadata.mergedCells, 'A1:B1, A2:A3')
  assert.equal(doc.metadata.mergedCellCount, 2)

  const diagnostic = doc.diagnostics.find(item => item.code === 'MERGED_CELLS')
  assert.ok(diagnostic !== undefined, '缺少 MERGED_CELLS 诊断')
  assert.match(diagnostic.message, /A1:B1, A2:A3/)
  assert.match(diagnostic.message, /不复制内容/)
  // 该样本每一行都补齐到 3 列，因此不应报 ragged。
  assert.equal(codes(doc).includes('RAGGED_ROWS'), false)
})

test('DOCX 行宽不齐时补齐到表宽并明确报告 RAGGED_ROWS', async () => {
  const bytes = buildDocx({
    body: [
      {
        kind: 'table',
        rows: [
          ['a', 'b', 'c'],
          ['1', '2'],
        ],
      },
    ],
  })
  const doc = await parse('ragged.docx', bytes)

  const table = doc.tables[0]!
  assert.deepEqual([...table.headers], ['a', 'b', 'c'])
  // 缺失位置补空值，不猜测、不丢行。
  assert.deepEqual(table.rows.map(row => [...row]), [['1', '2', '']])
  assert.ok(codes(doc).includes('RAGGED_ROWS'))
})

test('DOCX 表头为空单元格时补「列N」，不产出无表头的表格', async () => {
  const bytes = buildDocx({ body: [{ kind: 'table', rows: [['', '必填'], ['token', '是']] }] })
  const doc = await parse('header.docx', bytes)
  assert.deepEqual([...doc.tables[0]!.headers], ['列1', '必填'])
})

test('DOCX 段落文本保留制表符与换行，不静默拼成连续字符串', async () => {
  // Word 把制表符/换行建模成空元素（w:tab / w:br），直接取文本会把 "A<TAB>B" 拼成 "AB"。
  const rawDocumentXml = '<?xml version="1.0"?><w:document '
    + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>'
    + '</w:body></w:document>'
  const doc = await parse('tabs.docx', buildDocx({ body: [], rawDocumentXml }))

  assert.equal(doc.sections[0]!.text, 'A\tB\nC')
})

test('DOCX 页眉页脚不并入正文，只给 HEADERS_FOOTERS_SKIPPED', async () => {
  const bytes = buildDocx({
    body: [{ kind: 'heading', level: 1, text: '正文' }, { kind: 'paragraph', text: '业务事实。' }],
    includeHeaderFooter: true,
  })
  const doc = await parse('sidecar.docx', bytes)

  assert.equal(doc.status, 'parsed')
  // 关键：页眉里的文字不得出现在任何 section 文本里（否则同一句话出现两次）。
  assert.doesNotMatch(doc.plainText, /项目内部资料/)
  assert.doesNotMatch(doc.plainText, /第 1 页/)
  const diagnostic = doc.diagnostics.find(item => item.code === 'HEADERS_FOOTERS_SKIPPED')
  assert.ok(diagnostic !== undefined, '缺少 HEADERS_FOOTERS_SKIPPED 诊断')
  assert.match(diagnostic.message, /页眉×1/)
  assert.match(diagnostic.message, /页脚×1/)
})

test('DOCX 图片等媒体资源不当作文本，只登记 EMBEDDED_OBJECTS_IGNORED', async () => {
  const doc = await parse('media.docx', buildDocx({
    body: [{ kind: 'paragraph', text: '正文' }],
    includeImage: true,
  }))

  assert.equal(doc.status, 'parsed')
  const diagnostic = doc.diagnostics.find(item => item.code === 'EMBEDDED_OBJECTS_IGNORED')
  assert.ok(diagnostic !== undefined, '缺少 EMBEDDED_OBJECTS_IGNORED 诊断')
  assert.match(diagnostic.message, /1 个媒体资源/)
  assert.match(diagnostic.message, /OCR/)
})

test('DOCX 外部链接只登记地址，不下载不解析', async () => {
  const doc = await parse('link.docx', buildDocx({
    body: [{ kind: 'paragraph', text: '参见外部文档。' }],
    externalHyperlink: 'https://example.invalid/spec.docx',
  }))

  assert.equal(doc.status, 'parsed')
  const diagnostic = doc.diagnostics.find(item => item.code === 'EXTERNAL_REFERENCES_IGNORED')
  assert.ok(diagnostic !== undefined, '缺少 EXTERNAL_REFERENCES_IGNORED 诊断')
  assert.match(diagnostic.message, /https:\/\/example\.invalid\/spec\.docx/)
  assert.match(diagnostic.message, /不下载不解析/)
})

test('DOCX 宏与 OLE 嵌入对象在解包阶段出局，正文照常解析', async () => {
  const doc = await parse('macro.docx', buildDocx({
    body: [{ kind: 'heading', level: 1, text: '需求' }, { kind: 'paragraph', text: '正文可读。' }],
    includeMacro: true,
    includeOleObject: true,
  }))

  assert.equal(doc.status, 'parsed')
  assert.match(doc.plainText, /正文可读。/)
  const removed = doc.diagnostics.filter(item => item.code === 'DANGEROUS_PART_REMOVED')
  assert.equal(removed.length, 2, '应分别报告宏与嵌入对象')
  assert.match(messages(doc), /VBA 宏工程/)
  assert.match(messages(doc), /OLE 嵌入对象/)
  // 宏字节从未被解压，因此不可能出现在结果里。
  assert.doesNotMatch(doc.plainText, /MACRO-BYTES/)
  assert.doesNotMatch(doc.plainText, /OLE-BYTES/)
})

test('DOCX 文档属性取的是文档自己声明的值', async () => {
  const doc = await parse('props.docx', buildDocx({
    body: [{ kind: 'paragraph', text: '正文' }],
    title: '登录需求说明书',
    creator: '张三',
  }))

  assert.equal(doc.metadata.title, '登录需求说明书')
  assert.equal(doc.metadata.creator, '张三')
  assert.equal(doc.metadata.company, '示例公司')
  assert.equal(doc.metadata.wordCount, 42)
  assert.equal(doc.metadata.appPageCount, 2)
  assert.equal(doc.metadata.paragraphCount, 7)
})

test('DOCX includeTables=false 时不留下指向空 tables 的占位引用', async () => {
  const bytes = buildDocx({
    body: [
      { kind: 'heading', level: 1, text: '接口' },
      { kind: 'table', rows: [['字段', '必填'], ['token', '是']] },
    ],
  })

  const withTables = await parse('withtables.docx', bytes)
  assert.equal(withTables.tables.length, 1)
  assert.match(withTables.sections[0]!.text, /\[表格 1：结构化内容见 tables\]/)

  const noTables = await parse('notables.docx', bytes, { includeTables: false })
  assert.deepEqual(noTables.tables, [])
  // 占位文案指向 tables，而调用方明确不要 tables——留着就是死引用。
  assert.doesNotMatch(noTables.sections[0]!.text, /结构化内容见 tables/)
  assert.equal(noTables.sections[0]!.title, '接口')
})

test('DOCX includeMetadata=false 时 metadata 为空，解析本身不受影响', async () => {
  const bytes = buildDocx({
    body: [
      { kind: 'heading', level: 1, text: '接口' },
      { kind: 'table', rows: [['字段', '必填'], ['token', '是']] },
    ],
    title: '接口说明',
  })

  const noMetadata = await parse('nometa.docx', bytes, { includeMetadata: false })
  assert.deepEqual(noMetadata.metadata, {})
  assert.equal(noMetadata.tables.length, 1)
  assert.equal(noMetadata.sections.length, 1)
})

test('DOCX includeRawSource=true 时回传 document.xml，缺省不回传', async () => {
  const bytes = buildDocx({ body: [{ kind: 'paragraph', text: '正文' }] })

  const plain = await parse('raw.docx', bytes)
  assert.equal(plain.rawSource, undefined)

  const raw = await parse('raw.docx', bytes, { includeRawSource: true })
  assert.match(raw.rawSource ?? '', /<w:body>/)
})

// ── 异常样本 ─────────────────────────────────────────────────────────────────

test('截断的 DOCX 返回 parse-failed，而不是基于残缺本地文件头"成功"解出半截内容', async () => {
  const doc = await parse('truncated.docx', truncatedZip({ '[Content_Types].xml': '<Types/>' }))

  assert.equal(doc.status, 'parse-failed')
  assert.equal(doc.format, 'docx')
  assert.ok(codes(doc).includes('STRUCTURED_PARSE_FAILED'))
  assert.deepEqual(doc.sections, [])
})

test('缺少 [Content_Types].xml 的 ZIP 不算有效 OOXML，返回 parse-failed', async () => {
  const doc = await parse('nocontenttypes.docx', buildZip({ 'word/document.xml': '<w:document/>' }))

  assert.equal(doc.status, 'parse-failed')
  assert.match(messages(doc), /缺少 \[Content_Types\]\.xml/)
})

test('缺 Word 主文档内容类型时返回 parse-failed，不猜成别的格式', async () => {
  const doc = await parse('wrongtype.docx', buildZip({
    '[Content_Types].xml': '<Types><Default Extension="xml" ContentType="application/xml"/></Types>',
    'word/document.xml': '<w:document/>',
  }))

  assert.equal(doc.status, 'parse-failed')
  assert.match(messages(doc), /没有 Word 主文档内容类型/)
})

test('.docx 里装的是 Excel 工作簿时以内容为准报 FORMAT_MAGIC_BYTES_MISMATCH', async () => {
  const doc = await parse('actually-xlsx.docx', buildXlsx({ sheets: [{ name: 'S1', rows: [['a']] }] }))

  assert.equal(doc.status, 'unsupported')
  assert.ok(codes(doc).includes('FORMAT_MAGIC_BYTES_MISMATCH'))
  assert.match(messages(doc), /实际是 Excel 工作簿/)
  assert.deepEqual(doc.sections, [])
})

test('扩展名是 .docx 但内容不是 ZIP 时返回 unsupported，绝不按文本读出乱码', async () => {
  const doc = await parse('fake.docx', new TextEncoder().encode('# 其实是 markdown\n'))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.plainText, '')
  assert.ok(codes(doc).includes('FORMAT_MAGIC_BYTES_MISMATCH'))
})

test('.doc 老二进制格式在未配置适配器时明确 unsupported 并提示转换', async () => {
  const doc = await parse('old.doc', new Uint8Array(OLE2_HEADER))

  assert.equal(doc.status, 'unsupported')
  assert.equal(doc.format, 'doc')
  // §5.6.5 B：必须给出定向迁移路径，而不是笼统的"不支持"。
  assert.match(messages(doc), /转换为 \.docx/)
  assert.ok(codes(doc).includes('FORMAT_NOT_SUPPORTED'))
})

test('DOCX 缺少 <w:body> 时返回 parse-failed，不返回空文档', async () => {
  const rawDocumentXml = '<?xml version="1.0"?><w:document '
    + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:bodyX/></w:document>'
  const doc = await parse('nobody.docx', buildDocx({ body: [], rawDocumentXml }))

  assert.equal(doc.status, 'parse-failed')
  assert.match(messages(doc), /找不到 <w:body>/)
})

test('DOCX 正文为空时降为 partial 并给 EMPTY_CONTENT，而不是"解析成功但什么都没有"', async () => {
  const rawDocumentXml = '<?xml version="1.0"?><w:document '
    + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'
  const doc = await parse('empty.docx', buildDocx({ body: [], rawDocumentXml }))

  assert.equal(doc.status, 'partial')
  assert.ok(codes(doc).includes('EMPTY_CONTENT'))
  assert.deepEqual(doc.sections, [])
})

test('DOCX 里的 XML 外部实体不被展开（XXE 构造上不可能）', async () => {
  const rawDocumentXml = '<?xml version="1.0"?>'
    + '<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>before &xxe; after</w:t></w:r></w:p>'
    + '</w:body></w:document>'
  const doc = await parse('xxe.docx', buildDocx({ body: [], rawDocumentXml }))

  assert.equal(doc.status, 'parsed')
  // 未定义实体保留字面量，而不是被替换成文件内容。
  assert.match(doc.sections[0]!.text, /before &xxe; after/)
  assert.doesNotMatch(doc.plainText, /root:/)
  assert.doesNotMatch(doc.plainText, /\/bin\//)
  // DOCTYPE 与未定义实体各自被记录一次，证明"看到了但没解析"。
  assert.match(messages(doc), /DOCTYPE\/DTD 声明，已整段跳过/)
  assert.match(messages(doc), /未定义的实体引用 &xxe;/)
  assert.equal(codes(doc).filter(code => code === 'DANGEROUS_PART_REMOVED').length, 2)
})

test('DOCX 里用内容控件（w:sdt）包裹的段落不会被整段丢掉', async () => {
  const rawDocumentXml = '<?xml version="1.0"?><w:document '
    + 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:sdt><w:sdtPr><w:alias w:val="控件"/></w:sdtPr>'
    + '<w:sdtContent><w:p><w:r><w:t>控件里的段落</w:t></w:r></w:p></w:sdtContent></w:sdt>'
    + '</w:body></w:document>'
  const doc = await parse('sdt.docx', buildDocx({ body: [], rawDocumentXml }))

  assert.equal(doc.status, 'parsed')
  assert.match(doc.plainText, /控件里的段落/)
})

test('DOCX 超限：单条目解压上限拦下高压缩比正文', async () => {
  // 4 MiB 全零的 word/document.xml 在白名单内，必须撞上"按实际解压字节数"的硬上限。
  const doc = await parse('bomb.docx', buildZipBomb(4), { limits: { maxZipEntryBytes: 64 * 1024 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.ok(codes(doc).includes('LIMIT_EXCEEDED'))
  assert.deepEqual(doc.sections, [])
})

test('DOCX 超限：文件字节上限在解析前就拦下', async () => {
  const bytes = buildDocx({ body: [{ kind: 'paragraph', text: '正文' }] })
  const doc = await parse('big.docx', bytes, { limits: { maxFileBytes: 64 } })

  assert.equal(doc.status, 'limit-exceeded')
  assert.ok(codes(doc).includes('LIMIT_EXCEEDED'))
})

test('DOCX 解析被取消时返回结构化失败', async () => {
  const controller = new AbortController()
  controller.abort()
  const doc = await defaultParserRegistry().parse({
    path: 'cancel.docx',
    absolutePath: '/w/cancel.docx',
    bytes: buildDocx({ body: [{ kind: 'paragraph', text: '正文' }] }),
    signal: controller.signal,
  })

  assert.notEqual(doc.status, 'parsed')
  assert.ok(codes(doc).includes('PARSE_ABORTED'), `期望 PARSE_ABORTED，实际 ${codes(doc).join(', ')}`)
})

test('同一份 DOCX 重复解析得到同一批 section/table，内容变更后 sha256 与结果都变', async () => {
  const first = buildDocx({ body: [{ kind: 'heading', level: 1, text: '需求' }, { kind: 'paragraph', text: 'A' }] })
  const second = buildDocx({ body: [{ kind: 'heading', level: 1, text: '需求' }, { kind: 'paragraph', text: 'B' }] })

  const a1 = await parse('same.docx', first)
  const a2 = await parse('same.docx', first)
  assert.equal(a1.sha256, a2.sha256)
  assert.deepEqual(a1.sections, a2.sections)

  const b = await parse('same.docx', second)
  assert.notEqual(b.sha256, a1.sha256)
  assert.notDeepEqual(b.sections, a1.sections)
})

test('解析器可整体替换：注册表只依赖 DocumentParser 接口（§5.6.11 第 10 条）', async () => {
  const stub: DocumentParser = {
    format: 'docx',
    name: 'test-stub-docx',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    canParse: () => true,
    parse: async (_request, context) => ({
      status: 'parsed',
      format: 'docx',
      fileName: context.relativePath,
      sha256: context.sha256,
      sections: [{
        id: 'section-1', title: '桩标题', order: 0, text: '桩内容',
        sourceRef: `${context.relativePath}#heading=1`,
      }],
      tables: [],
      metadata: {},
      plainText: '桩内容',
      diagnostics: [],
      confidence: 'structure-preserved',
      limits: { truncated: false, bytesRead: context.bytes.byteLength },
    }),
  }

  const registry = new DocumentParserRegistry([stub])
  assert.deepEqual(registry.formats(), ['docx'])
  assert.equal(registry.parserFor('docx')?.name, 'test-stub-docx')

  const doc = await registry.parse({
    path: 'stub.docx',
    absolutePath: '/w/stub.docx',
    bytes: buildDocx({ body: [{ kind: 'paragraph', text: '真实内容' }] }),
    signal,
  })

  // 结果完全来自桩实现——换解析器只需换这一处，注册表与调用方都不用改。
  assert.equal(doc.sections[0]!.title, '桩标题')
  assert.equal(doc.plainText, '桩内容')
  assert.doesNotMatch(doc.plainText, /真实内容/)
  // 身份字段仍由注册表补全，说明契约没有随实现一起漂移。
  assert.match(doc.sha256, /^[0-9a-f]{64}$/)
  assert.equal(doc.fileName, 'stub.docx')
})

test('同一格式重复注册解析器直接报错，避免"哪个实现生效"不可预期', () => {
  const registry = defaultParserRegistry()
  assert.throws(() => registry.register({
    format: 'docx',
    name: 'duplicate',
    mediaTypes: [],
    canParse: () => true,
    parse: async () => { throw new Error('unreachable') },
  }), /duplicate document parser for format "docx"/)
})
