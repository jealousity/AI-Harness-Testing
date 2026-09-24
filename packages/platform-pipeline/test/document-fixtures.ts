/**
 * 文档解析测试 fixture 构造器（docs/10 §5.6.10、ADR-0001 §11）。
 *
 * **为什么在测试期程序化构造真实二进制，而不是提交不透明的 fixture 文件**：
 * - 可审查——每个样本的构造代码就在仓库里，评审能看到它到底含什么；
 * - 可控——能精确构造 §5.6.10 要求的病理样本（zip bomb、宏部件、外部实体、
 *   路径穿越条目、隐藏 sheet、无缓存值公式、合并单元格）；
 * - 可复现——构造是确定性的，测试不依赖外部文件与 Office。
 *
 * 这里构造的是**真正的** PDF / OOXML，不是"看起来像"的字节串：加密 PDF 用
 * PDF 标准的 RC4 40-bit（V=1/R=2）算法真实加密，因此能验证"正确密码可解出原文"，
 * 从而证明 fixture 本身有效（否则测试只是在验证一个假样本）。
 *
 * @module test/document-fixtures
 */

import { createHash } from 'node:crypto'

import { strToU8, zipSync, type Zippable } from 'fflate'

// ── ZIP / OOXML 基础 ─────────────────────────────────────────────────────────

export interface ZipOptions {
  /** 压缩级别；0 = stored（不压缩）。 */
  readonly level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
}

/** 打包一组部件成 ZIP。值为字符串时按 UTF-8 编码。 */
export function buildZip(entries: Readonly<Record<string, string | Uint8Array>>, options: ZipOptions = {}): Uint8Array {
  const zippable: Zippable = {}
  for (const [name, value] of Object.entries(entries)) {
    zippable[name] = typeof value === 'string' ? strToU8(value) : value
  }
  return zipSync(zippable, { level: options.level ?? 6 })
}

/** 不是 ZIP 的字节串（用于验证"缺 PK 签名即拒绝"）。 */
export function notAZip(): Uint8Array {
  return strToU8('this is definitely not a zip archive, just plain text')
}

/**
 * 把 fixture 包成 Node `Buffer`。
 *
 * 用于验证解析器会**归一化**字节：`fs.readFile` 返回的正是 `Buffer`，而 pdfjs 会
 * 显式拒绝 `Buffer`（尽管它是 `Uint8Array` 的子类）。不测这条路径，
 * "用真实文件读出来的 PDF 能不能解析"就没有任何覆盖。
 */
export function asNodeBuffer(bytes: Uint8Array): Uint8Array {
  return Buffer.from(bytes)
}

/** 截断的 ZIP（只留前 60 字节）。 */
export function truncatedZip(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  return buildZip(entries).subarray(0, 60)
}

/**
 * 高压缩比 DOCX：**`word/document.xml` 本身**是 `megabytes` MiB 全零。
 *
 * 该部件在解包白名单内，因此必须撞上"按实际解压字节数"的逐块硬上限。
 * 与 `buildZipBombOutsideWhitelist` 配对，分别证明两道防线各自有效。
 *
 * 测试应同时调小 `limits.maxZipEntryBytes`，否则默认 64 MiB 的单条目上限意味着
 * fixture 得造到 64 MiB 以上，白白拖慢测试。
 */
export function buildZipBomb(megabytes = 4): Uint8Array {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    'word/document.xml': new Uint8Array(megabytes * 1024 * 1024),
  }, { level: 9 })
}

/**
 * 炸弹位于**白名单外**的部件（`word/bomb.xml`）。
 *
 * 白名单让它**根本不被解压**，所以解析不会撞限额——这正是"主要防线"的证明：
 * 不读的字节不可能造成危害。文档结构本身是合法的，因此解析应当成功。
 */
export function buildZipBombOutsideWhitelist(megabytes = 4): Uint8Array {
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
      + '<w:p><w:r><w:t>正文很短</w:t></w:r></w:p></w:body></w:document>',
    'word/bomb.xml': new Uint8Array(megabytes * 1024 * 1024),
  }, { level: 9 })
}

/**
 * 篡改 ZIP 头里声明的解压后大小，伪造一个"看起来很小"的条目。
 *
 * 这是对 ADR-0001 §6「不信任 central directory 的声明值」的直接检验：
 * ZIP 头里的大小字段可以随便改，所以硬上限必须按**实际**解压字节数执行。
 * 本地文件头与中央目录头两处都改，避免实现从其中任意一处读取而绕过检验。
 */
export function patchDeclaredUncompressedSize(zip: Uint8Array, declaredSize: number): Uint8Array {
  const patched = new Uint8Array(zip)
  const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength)
  for (let index = 0; index + 30 <= patched.length; index += 1) {
    const isLocal = patched[index] === 0x50 && patched[index + 1] === 0x4b
      && patched[index + 2] === 0x03 && patched[index + 3] === 0x04
    const isCentral = patched[index] === 0x50 && patched[index + 1] === 0x4b
      && patched[index + 2] === 0x01 && patched[index + 3] === 0x02
    if (isLocal) view.setUint32(index + 22, declaredSize, true)
    else if (isCentral) view.setUint32(index + 24, declaredSize, true)
  }
  return patched
}

/** 含路径穿越条目名的 ZIP（`../` 与绝对路径）。 */
export function buildTraversalZip(): Uint8Array {
  return buildZip({
    '[Content_Types].xml': '<Types/>',
    '../escaped.xml': '<evil/>',
    '/absolute.xml': '<evil/>',
  })
}

// ── PDF ─────────────────────────────────────────────────────────────────────

export interface PdfPageSpec {
  /** 每页的行文本；空字符串表示该页没有文本层。 */
  readonly lines: readonly string[]
  /**
   * 为 true 时把行的 y 坐标写成"回跳"（自下而上），用于触发 `TEXT_ORDER_SUSPECT`。
   * 8 行以上才会被判为可疑，因此构造多栏样本时要给足行数。
   */
  readonly reversedOrder?: boolean
}

export interface PdfSpec {
  readonly pages: readonly PdfPageSpec[]
  readonly version?: string
  /** 在 trailer 前插入的额外字典内容（用于构造 `/JavaScript` 等特征）。 */
  readonly extraCatalogEntries?: string
}

/** 构造最小但**结构完整**（含正确 xref 偏移）的 PDF。 */
export function buildPdf(spec: PdfSpec): Uint8Array {
  const objects: (string | null)[] = []
  const add = (body: string): number => { objects.push(body); return objects.length }

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesPlaceholder = objects.length + 1
  objects.push(null)
  const pageIds: number[] = []

  for (const page of spec.pages) {
    const lines = page.lines.filter(line => line !== '')
    const commands = lines.map((line, index) => {
      const y = page.reversedOrder ? 100 + index * 20 : 720 - index * 20
      return `BT /F1 12 Tf 72 ${y} Td (${escapePdfText(line)}) Tj ET`
    })
    const stream = commands.join('\n')
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    pageIds.push(add(
      `<< /Type /Page /Parent ${pagesPlaceholder} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ))
  }
  objects[pagesPlaceholder - 1] =
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`

  const catalogExtra = spec.extraCatalogEntries === undefined ? '' : ` ${spec.extraCatalogEntries}`
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesPlaceholder} 0 R${catalogExtra} >>`)

  return assemblePdf(objects, catalogId, spec.version ?? '1.7', '')
}

/** 只有图片、没有文本层的 PDF（模拟扫描件）。 */
export function buildScannedPdf(pages = 2): Uint8Array {
  return buildPdf({ pages: Array.from({ length: pages }, () => ({ lines: [] })) })
}

/** 含 `/JavaScript` 与 `/OpenAction` 特征的 PDF（解析器必须只诊断、不执行）。 */
export function buildPdfWithJavaScript(): Uint8Array {
  return buildPdf({
    pages: [{ lines: ['Click to run script'] }],
    extraCatalogEntries: '/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>',
  })
}

/** 损坏的 PDF：截断到前 120 字节。 */
export function brokenPdf(): Uint8Array {
  return buildPdf({ pages: [{ lines: ['Hello'] }] }).subarray(0, 120)
}

/**
 * 真正加密的 PDF（PDF 1.7 V=1 / R=2，RC4 40-bit）。
 *
 * OpenSSL 3 的默认 provider 已移除 RC4（`ERR_OSSL_EVP_UNSUPPORTED`），
 * 因此这里内联一个纯 JS 实现，避免依赖 crypto provider 的算法可用性。
 */
export function buildEncryptedPdf(userPassword: string, ownerPassword: string, text: string): Uint8Array {
  const idBytes = createHash('md5').update('fixture-id').digest().subarray(0, 16)
  const permissions = -1 | 0

  const ownerKey = createHash('md5').update(padPassword(ownerPassword)).digest().subarray(0, 5)
  const o = rc4(ownerKey, padPassword(userPassword))
  const permissionsBytes = Buffer.alloc(4)
  permissionsBytes.writeInt32LE(permissions, 0)
  const encryptionKey = createHash('md5')
    .update(Buffer.concat([padPassword(userPassword), o, permissionsBytes, idBytes]))
    .digest()
    .subarray(0, 5)
  const u = rc4(encryptionKey, PAD)

  const objects: (string | null)[] = []
  const add = (body: string): number => { objects.push(body); return objects.length }

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesPlaceholder = objects.length + 1
  objects.push(null)

  const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`
  const contentNumber = objects.length + 1
  const encrypted = rc4(objectKey(encryptionKey, contentNumber, 0), Buffer.from(stream, 'latin1'))
  const contentId = add(`<< /Length ${encrypted.length} >>\nstream\n${encrypted.toString('latin1')}\nendstream`)
  const pageId = add(
    `<< /Type /Page /Parent ${pagesPlaceholder} 0 R /MediaBox [0 0 612 792] `
    + `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
  )
  objects[pagesPlaceholder - 1] = `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesPlaceholder} 0 R >>`)
  const encryptId = add(
    `<< /Filter /Standard /V 1 /R 2 /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P ${permissions} >>`,
  )

  return assemblePdf(
    objects,
    catalogId,
    '1.7',
    `/Encrypt ${encryptId} 0 R /ID [<${idBytes.toString('hex')}> <${idBytes.toString('hex')}>]`,
  )
}

/** 拼接 PDF 主体并计算 xref 偏移。 */
function assemblePdf(
  objects: readonly (string | null)[],
  catalogId: number,
  version: string,
  trailerExtra: string,
): Uint8Array {
  let text = `%PDF-${version}\n%\xE2\xE3\xCF\xD3\n`
  const offsets: number[] = []
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(text.length)
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefStart = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`
  text += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R${trailerExtra === '' ? '' : ` ${trailerExtra}`} >>\n`
  text += `startxref\n${xrefStart}\n%%EOF\n`
  // 返回**纯** Uint8Array 而非 Buffer：Buffer 是 Uint8Array 的子类，但 pdfjs 会拒绝它，
  // 直接返回 Buffer 会让 fixture 的"类型"与真实调用方不一致（真实调用方给的是纯数组）。
  return new Uint8Array(Buffer.from(text, 'latin1'))
}

function escapePdfText(text: string): string {
  return text.replace(/([()\\])/g, '\\$1')
}

/** PDF 标准填充串（32 字节）。 */
const PAD = Buffer.from([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
])

function padPassword(password: string): Buffer {
  const raw = Buffer.from(password, 'latin1').subarray(0, 32)
  return Buffer.concat([raw, PAD.subarray(0, 32 - raw.length)])
}

/** 纯 JS RC4（KSA + PRGA）：OpenSSL 3 默认不再提供 RC4，且这里要跨环境确定。 */
function rc4(key: Buffer, data: Buffer): Buffer {
  const state = new Uint8Array(256)
  for (let index = 0; index < 256; index += 1) state[index] = index
  let j = 0
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index]! + key[index % key.length]!) & 0xff
    const swap = state[index]!; state[index] = state[j]!; state[j] = swap
  }
  const out = Buffer.alloc(data.length)
  let a = 0
  let b = 0
  for (let index = 0; index < data.length; index += 1) {
    a = (a + 1) & 0xff
    b = (b + state[a]!) & 0xff
    const swap = state[a]!; state[a] = state[b]!; state[b] = swap
    out[index] = data[index]! ^ state[(state[a]! + state[b]!) & 0xff]!
  }
  return out
}

/** 每个 PDF 对象的 RC4 密钥：MD5(加密密钥 + 对象号(3B LE) + 代号(2B LE))[:10]。 */
function objectKey(encryptionKey: Buffer, objectNumber: number, generation: number): Buffer {
  const extra = Buffer.alloc(5)
  extra.writeUIntLE(objectNumber, 0, 3)
  extra.writeUIntLE(generation, 3, 2)
  return createHash('md5').update(Buffer.concat([encryptionKey, extra])).digest()
    .subarray(0, Math.min(encryptionKey.length + 5, 16))
}

// ── DOCX ─────────────────────────────────────────────────────────────────────

export type DocxCell = string | {
  readonly text: string
  /** 横向合并列数（`w:gridSpan`）。 */
  readonly gridSpan?: number
  /** 纵向合并：`restart` 起头，`continue` 是延续单元格。 */
  readonly vMerge?: 'restart' | 'continue'
}

export type DocxBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string; readonly styleId?: string }
  | { readonly kind: 'paragraph'; readonly text: string; readonly listLevel?: number; readonly outlineLevel?: number }
  | { readonly kind: 'table'; readonly rows: readonly (readonly DocxCell[])[] }

export interface DocxSpec {
  readonly body: readonly DocxBlock[]
  readonly title?: string
  readonly creator?: string
  readonly includeHeaderFooter?: boolean
  readonly includeMacro?: boolean
  readonly includeOleObject?: boolean
  readonly includeImage?: boolean
  readonly externalHyperlink?: string
  /** 追加到 `word/document.xml` 的原始 XML（用于构造异常结构）。 */
  readonly rawDocumentXml?: string
}

const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** 构造结构完整的 `.docx`。 */
export function buildDocx(spec: DocxSpec): Uint8Array {
  const entries: Record<string, string | Uint8Array> = {}
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '</Types>',
  ]
  if (spec.includeMacro === true) {
    contentTypes.splice(contentTypes.length - 1, 0,
      '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>')
  }
  entries['[Content_Types].xml'] = contentTypes.join('')

  entries['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>'

  entries['word/document.xml'] = spec.rawDocumentXml
    ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${WORD_NS}><w:body>`
      + spec.body.map(renderDocxBlock).join('')
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'

  entries['word/styles.xml'] = buildDocxStyles()

  const documentRels: string[] = []
  if (spec.externalHyperlink !== undefined) {
    documentRels.push(
      '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
      + `Target="${escapeXml(spec.externalHyperlink)}" TargetMode="External"/>`,
    )
  }
  if (spec.includeHeaderFooter === true) {
    documentRels.push(
      '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
      '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
    )
  }
  if (spec.includeImage === true) {
    documentRels.push(
      '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
    )
  }
  if (documentRels.length > 0) {
    entries['word/_rels/document.xml.rels'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + documentRels.join('') + '</Relationships>'
  }

  if (spec.includeHeaderFooter === true) {
    entries['word/header1.xml'] = `<?xml version="1.0"?><w:hdr ${WORD_NS}><w:p><w:r><w:t>项目内部资料</w:t></w:r></w:p></w:hdr>`
    entries['word/footer1.xml'] = `<?xml version="1.0"?><w:ftr ${WORD_NS}><w:p><w:r><w:t>第 1 页</w:t></w:r></w:p></w:ftr>`
  }
  if (spec.includeMacro === true) entries['word/vbaProject.bin'] = strToU8('MACRO-BYTES')
  if (spec.includeOleObject === true) entries['word/embeddings/oleObject1.bin'] = strToU8('OLE-BYTES')
  if (spec.includeImage === true) entries['word/media/image1.png'] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  if (spec.title !== undefined || spec.creator !== undefined) {
    entries['docProps/core.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + (spec.title === undefined ? '' : `<dc:title>${escapeXml(spec.title)}</dc:title>`)
      + (spec.creator === undefined ? '' : `<dc:creator>${escapeXml(spec.creator)}</dc:creator>`)
      + '</cp:coreProperties>'
  }
  entries['docProps/app.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    + '<Words>42</Words><Pages>2</Pages><Paragraphs>7</Paragraphs><Company>示例公司</Company></Properties>'

  return buildZip(entries)
}

function buildDocxStyles(): string {
  const heading = (level: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>`
    + `<w:pPr><w:outlineLvl w:val="${level - 1}"/></w:pPr></w:style>`
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:styles ${WORD_NS}>`
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>'
    + Array.from({ length: 4 }, (_value, index) => heading(index + 1)).join('')
    // 自定义样式：只有靠 styles.xml 的 outlineLvl 才能识别成标题。
    + '<w:style w:type="paragraph" w:styleId="RequirementHeading"><w:name w:val="需求章节"/>'
    + '<w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>'
    + '</w:styles>'
}

function renderDocxBlock(block: DocxBlock): string {
  if (block.kind === 'heading') {
    const styleId = block.styleId ?? `Heading${block.level}`
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>${escapeXml(block.text)}</w:t></w:r></w:p>`
  }
  if (block.kind === 'paragraph') {
    const properties: string[] = []
    if (block.outlineLevel !== undefined) properties.push(`<w:outlineLvl w:val="${block.outlineLevel}"/>`)
    if (block.listLevel !== undefined) properties.push(`<w:numPr><w:ilvl w:val="${block.listLevel}"/><w:numId w:val="1"/></w:numPr>`)
    const pPr = properties.length === 0 ? '' : `<w:pPr>${properties.join('')}</w:pPr>`
    // 用 `w:tab` 与 `w:br` 验证段落文本拼接不会静默吃掉制表符与换行。
    const runs = block.text === ''
      ? ''
      : `<w:r><w:t xml:space="preserve">${escapeXml(block.text)}</w:t></w:r>`
    return `<w:p>${pPr}${runs}</w:p>`
  }
  const rows = block.rows.map(cells => `<w:tr>${cells.map(renderDocxCell).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${rows}</w:tbl>`
}

function renderDocxCell(cell: DocxCell): string {
  const spec = typeof cell === 'string' ? { text: cell } : cell
  const properties: string[] = []
  if (spec.gridSpan !== undefined) properties.push(`<w:gridSpan w:val="${spec.gridSpan}"/>`)
  if (spec.vMerge !== undefined) {
    properties.push(spec.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>')
  }
  const tcPr = properties.length === 0 ? '' : `<w:tcPr>${properties.join('')}</w:tcPr>`
  const paragraph = `<w:p><w:r><w:t xml:space="preserve">${escapeXml(spec.text)}</w:t></w:r></w:p>`
  return `<w:tc>${tcPr}${paragraph}</w:tc>`
}

// ── XLSX ─────────────────────────────────────────────────────────────────────

export type XlsxCell =
  | null
  | string
  | number
  | { readonly text: string }
  | { readonly number: number; readonly numFmtId?: number }
  | { readonly boolean: boolean }
  | { readonly error: string }
  | { readonly inline: string }
  | { readonly formula: string; readonly cached?: string | number; readonly numFmtId?: number }

export interface XlsxSheetSpec {
  readonly name: string
  readonly hidden?: boolean
  /** 第 0 行是表头。`null` 表示该行整体为空。 */
  readonly rows: readonly (readonly XlsxCell[] | null)[]
  readonly merges?: readonly string[]
  readonly autoFilter?: string
  readonly freezePane?: string
  /** 表格定义（写入 `xl/tables/tableN.xml` 并建立 sheet 关系）。 */
  readonly table?: { readonly name: string; readonly ref: string }
}

export interface XlsxSpec {
  readonly sheets: readonly XlsxSheetSpec[]
  readonly date1904?: boolean
  readonly includeMacro?: boolean
  readonly includeExternalLink?: boolean
  readonly title?: string
  readonly creator?: string
  /** 追加的原始部件（用于构造异常结构）。 */
  readonly extraParts?: Readonly<Record<string, string | Uint8Array>>
}

/** 构造结构完整的 `.xlsx`。 */
export function buildXlsx(spec: XlsxSpec): Uint8Array {
  const entries: Record<string, string | Uint8Array> = {}
  const sharedStrings: string[] = []
  const styleNumFmts: number[] = [0]
  const sheetParts: { readonly name: string; readonly partName: string; readonly xml: string; readonly tablePart?: { readonly partName: string; readonly xml: string } }[] = []

  spec.sheets.forEach((sheet, index) => {
    const partName = `xl/worksheets/sheet${index + 1}.xml`
    const tablePart = sheet.table === undefined
      ? undefined
      : {
        partName: `xl/tables/table${index + 1}.xml`,
        xml: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          + '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
          + `id="${index + 1}" name="${escapeXml(sheet.table.name)}" displayName="${escapeXml(sheet.table.name)}" ref="${sheet.table.ref}">`
          + '<tableColumns count="1"><tableColumn id="1" name="列1"/></tableColumns></table>',
      }
    const xml = renderSheet(sheet, sharedStrings, styleNumFmts, tablePart === undefined)
    sheetParts.push({ name: sheet.name, partName, xml, ...(tablePart === undefined ? {} : { tablePart }) })
  })

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
    ...sheetParts.map(part => `<Override PartName="/${part.partName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    ...sheetParts.filter(part => part.tablePart !== undefined)
      .map(part => `<Override PartName="/${part.tablePart!.partName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`),
    '</Types>',
  ]
  if (spec.includeMacro === true) {
    contentTypes.splice(contentTypes.length - 1, 0,
      '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>')
  }
  entries['[Content_Types].xml'] = contentTypes.join('')

  entries['_rels/.rels'] = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'

  const workbookSheets = sheetParts.map((part, index) =>
    `<sheet name="${escapeXml(part.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"`
    + `${spec.sheets[index]?.hidden === true ? ' state="hidden"' : ''}/>`).join('')
  entries['xl/workbook.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<workbookPr date1904="${spec.date1904 === true ? 1 : 0}"/>`
    + `<sheets>${workbookSheets}</sheets></workbook>`

  const workbookRels = [
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rIdStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>',
    ...sheetParts.map((part, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" `
      + `Target="worksheets/sheet${index + 1}.xml"/>`),
  ]
  if (spec.includeExternalLink === true) {
    workbookRels.push(
      '<Relationship Id="rIdExternal" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://example.invalid/data.xlsx" TargetMode="External"/>',
    )
  }
  entries['xl/_rels/workbook.xml.rels'] = '<?xml version="1.0"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + workbookRels.join('') + '</Relationships>'

  entries['xl/sharedStrings.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">`
    + sharedStrings.map(value => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('')
    + '</sst>'

  entries['xl/styles.xml'] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="0"/>'
    + `<cellXfs count="${styleNumFmts.length}">`
    + styleNumFmts.map(id => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"/>`).join('')
    + '</cellXfs></styleSheet>'

  for (const part of sheetParts) {
    entries[part.partName] = part.xml
    if (part.tablePart !== undefined) {
      entries[part.tablePart.partName] = part.tablePart.xml
      entries[`xl/worksheets/_rels/${part.partName.slice(part.partName.lastIndexOf('/') + 1)}.rels`] =
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        // Target 相对 `xl/worksheets/`（即 sheet 部件所在目录）解析，因此是一层 `../`。
        // 与真实 Excel 写出的 `../tables/table1.xml` 一致。
        + `<Relationship Id="rIdTable1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/${part.tablePart.partName.slice(part.tablePart.partName.lastIndexOf('/') + 1)}"/>`
        + '</Relationships>'
    }
  }

  if (spec.includeMacro === true) entries['xl/vbaProject.bin'] = strToU8('MACRO-BYTES')
  if (spec.title !== undefined || spec.creator !== undefined) {
    entries['docProps/core.xml'] = '<?xml version="1.0"?>'
      + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/">'
      + (spec.title === undefined ? '' : `<dc:title>${escapeXml(spec.title)}</dc:title>`)
      + (spec.creator === undefined ? '' : `<dc:creator>${escapeXml(spec.creator)}</dc:creator>`)
      + '</cp:coreProperties>'
  }
  entries['docProps/app.xml'] = '<?xml version="1.0"?>'
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
    + '<Company>示例公司</Company></Properties>'

  for (const [name, value] of Object.entries(spec.extraParts ?? {})) entries[name] = value

  return buildZip(entries)
}

function renderSheet(
  sheet: XlsxSheetSpec,
  sharedStrings: string[],
  styleNumFmts: number[],
  includeTableParts: boolean,
): string {
  const rows: string[] = []
  sheet.rows.forEach((row, rowIndex) => {
    if (row === null) return
    const cells: string[] = []
    row.forEach((cell, columnIndex) => {
      if (cell === null) return
      const reference = `${columnLetter(columnIndex + 1)}${rowIndex + 1}`
      cells.push(renderCell(reference, cell, sharedStrings, styleNumFmts))
    })
    if (cells.length > 0) rows.push(`<row r="${rowIndex + 1}">${cells.join('')}</row>`)
  })

  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
  ]
  if (sheet.freezePane !== undefined) {
    parts.push(`<sheetViews><sheetView workbookViewId="0"><pane topLeftCell="${sheet.freezePane}" state="frozen"/></sheetView></sheetViews>`)
  }
  parts.push(`<sheetData>${rows.join('')}</sheetData>`)
  if (sheet.autoFilter !== undefined) parts.push(`<autoFilter ref="${sheet.autoFilter}"/>`)
  if (sheet.merges !== undefined && sheet.merges.length > 0) {
    parts.push(`<mergeCells count="${sheet.merges.length}">`
      + sheet.merges.map(ref => `<mergeCell ref="${ref}"/>`).join('') + '</mergeCells>')
  }
  if (sheet.table !== undefined && includeTableParts) parts.push('<tableParts count="1"><tablePart r:id="rIdTable1"/></tableParts>')
  parts.push('</worksheet>')
  return parts.join('')
}

function renderCell(
  reference: string,
  cell: Exclude<XlsxCell, null>,
  sharedStrings: string[],
  styleNumFmts: number[],
): string {
  if (typeof cell === 'string') {
    return `<c r="${reference}" t="s"><v>${sharedStringIndex(sharedStrings, cell)}</v></c>`
  }
  if (typeof cell === 'number') {
    return `<c r="${reference}"><v>${cell}</v></c>`
  }
  if ('text' in cell) {
    return `<c r="${reference}" t="s"><v>${sharedStringIndex(sharedStrings, cell.text)}</v></c>`
  }
  if ('inline' in cell) {
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.inline)}</t></is></c>`
  }
  if ('boolean' in cell) {
    return `<c r="${reference}" t="b"><v>${cell.boolean ? 1 : 0}</v></c>`
  }
  if ('error' in cell) {
    return `<c r="${reference}" t="e"><v>${escapeXml(cell.error)}</v></c>`
  }
  if ('formula' in cell) {
    const style = cell.numFmtId === undefined ? '' : ` s="${styleIndex(styleNumFmts, cell.numFmtId)}"`
    const cache = cell.cached === undefined ? '' : `<v>${typeof cell.cached === 'string' ? escapeXml(cell.cached) : cell.cached}</v>`
    const type = typeof cell.cached === 'string' ? ' t="str"' : ''
    return `<c r="${reference}"${style}${type}><f>${escapeXml(cell.formula)}</f>${cache}</c>`
  }
  const style = cell.numFmtId === undefined ? '' : ` s="${styleIndex(styleNumFmts, cell.numFmtId)}"`
  return `<c r="${reference}"${style}><v>${cell.number}</v></c>`
}

function sharedStringIndex(sharedStrings: string[], value: string): number {
  const existing = sharedStrings.indexOf(value)
  if (existing >= 0) return existing
  sharedStrings.push(value)
  return sharedStrings.length - 1
}

/** `cellXfs` 的序号：0 是默认格式，其余按 numFmtId 去重分配。 */
function styleIndex(styleNumFmts: number[], numFmtId: number): number {
  const existing = styleNumFmts.indexOf(numFmtId)
  if (existing >= 0) return existing
  styleNumFmts.push(numFmtId)
  return styleNumFmts.length - 1
}

// ── 共用 ─────────────────────────────────────────────────────────────────────

function columnLetter(index: number): string {
  let value = index - 1
  let out = ''
  while (value >= 0) {
    out = String.fromCharCode(65 + (value % 26)) + out
    value = Math.floor(value / 26) - 1
  }
  return out
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
