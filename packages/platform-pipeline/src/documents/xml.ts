/**
 * 安全 XML 分词器（docs/10 §5.6.5 B/C、ADR-0001 §6）。
 *
 * DOCX/XLSX 的部件都是 XML，本模块是它们的唯一 XML 入口。它**不是**通用 XML 库，
 * 只实现 OOXML 用得到的子集，以此把一整类漏洞用**构造**消除掉，而不是靠配置开关：
 *
 * - **不做实体扩展**：`<!DOCTYPE …>` 与内部子集一律跳过（只记诊断），实体引用只解析
 *   XML 预定义的 5 个（`amp lt gt quot apos`）与数字字符引用。因此
 *   ① 外部实体（`SYSTEM "file:///etc/passwd"`）无从解析 → 不可能任意文件读取 / SSRF；
 *   ② 内部实体递归展开（Billion Laughs）无从构造 → 不可能实体爆炸。
 * - **不做命名空间解析**：只按**本地名**匹配（`w:val` → `val`），避免为 OOXML 的固定
 *   前缀引入一套命名空间栈。属性同理按本地名取，同名取首次出现者。
 * - **不递归**：解析与遍历都用显式栈，深嵌套畸形文档只会撞到深度上限，不会爆调用栈。
 * - **失败有归属**：结构性错误抛 `DocumentParseError`（由注册表映射为 `parse-failed`）；
 *   可容忍的异常（DOCTYPE、未定义实体）只产诊断。
 *
 * @module platform-pipeline/documents/xml
 */

import { DOCUMENT_DIAGNOSTIC_CODES, DocumentParseError, diagnostic, type DocumentDiagnostic } from './document-types.ts'

/** 元素节点。`attrs` 以**本地名**为键（`w:val` → `val`）。 */
export interface XmlElement {
  readonly kind: 'element'
  readonly name: string
  readonly attrs: ReadonlyMap<string, string>
  readonly children: readonly XmlNode[]
}

/** 文本节点。CDATA 段也归入文本节点（CDATA 是字面量，不存在实体风险）。 */
export interface XmlText {
  readonly kind: 'text'
  readonly value: string
}

export type XmlNode = XmlElement | XmlText

export function isElement(node: XmlNode): node is XmlElement {
  return node.kind === 'element'
}

/** XML 解析上限。这是防栈爆/防膨胀的**结构性**上限，与 `DocumentLimits` 相互独立。 */
export interface XmlLimits {
  readonly maxDepth: number
  readonly maxElements: number
  readonly maxTextChars: number
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxDepth: 256,
  maxElements: 200_000,
  maxTextChars: 4_000_000,
}

export interface XmlParseResult {
  /** 根元素；文档为空或只有声明时为 undefined。 */
  readonly root?: XmlElement
  readonly diagnostics: readonly DocumentDiagnostic[]
  /** 是否遇到过 DOCTYPE / 实体声明（供安全诊断与测试使用）。 */
  readonly sawDoctype: boolean
}

/** 只解析 XML 预定义的 5 个实体名。其余一律保留字面量，**不展开**。 */
const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

/** 一次扫描的可变状态。集中在一处，避免在多处透传诊断数组与"是否已报过"标记。 */
interface ScanState {
  readonly path: string
  readonly diagnostics: DocumentDiagnostic[]
  readonly limits: XmlLimits
  elements: number
  textChars: number
  sawDoctype: boolean
  unknownEntityReported: boolean
}

/** 建树用的可变节点（只在解析期存在，不暴露给消费者）。 */
interface Builder {
  readonly kind: 'element'
  readonly name: string
  readonly attrs: Map<string, string>
  readonly children: XmlNode[]
}

/**
 * 解析一段 XML。
 *
 * `path` 只用于诊断定位（sourceRef 前缀），不参与任何路径解析。
 */
export function parseXml(input: string, path: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlParseResult {
  const state: ScanState = {
    path,
    diagnostics: [],
    limits,
    elements: 0,
    textChars: 0,
    sawDoctype: false,
    unknownEntityReported: false,
  }
  const root: Builder = { kind: 'element', name: '#document', attrs: new Map(), children: [] }
  const stack: Builder[] = [root]
  const top = (): Builder => stack[stack.length - 1]!

  const appendText = (value: string): void => {
    if (value === '') return
    state.textChars += value.length
    if (state.textChars > limits.maxTextChars) {
      throw new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.limitExceeded,
        `XML 文本总量超过上限 ${limits.maxTextChars} 字符`,
        path,
      )
    }
    top().children.push({ kind: 'text', value })
  }

  let index = 0
  while (index < input.length) {
    const lt = input.indexOf('<', index)
    if (lt < 0) {
      appendText(decodeEntities(input.slice(index), state))
      break
    }
    if (lt > index) appendText(decodeEntities(input.slice(index, lt), state))

    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9)
      if (end < 0) throw malformed('CDATA 段没有闭合的 ]]>', path)
      appendText(input.slice(lt + 9, end))
      index = end + 3
      continue
    }

    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4)
      if (end < 0) throw malformed('XML 注释没有闭合的 -->', path)
      index = end + 3
      continue
    }

    // 处理指令（`<?xml …?>`、`<?mso-application …?>`）：声明本身无副作用，跳过。
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2)
      if (end < 0) throw malformed('处理指令没有闭合的 ?>', path)
      index = end + 2
      continue
    }

    // DOCTYPE / 其他声明：整段跳过，绝不解析实体定义。
    if (input.startsWith('<!', lt)) {
      index = skipDeclaration(input, lt, path)
      state.sawDoctype = true
      continue
    }

    if (input.startsWith('</', lt)) {
      const end = input.indexOf('>', lt)
      if (end < 0) throw malformed('结束标签没有闭合的 >', path)
      const name = localName(input.slice(lt + 2, end).trim())
      if (stack.length <= 1) throw malformed(`出现多余的结束标签 </${name}>`, path)
      const open = top().name
      if (open !== name) {
        throw malformed(`标签嵌套不匹配：<${open}> 被 </${name}> 关闭`, path)
      }
      stack.pop()
      index = end + 1
      continue
    }

    const tag = parseStartTag(input, lt, state)
    state.elements += 1
    if (state.elements > limits.maxElements) {
      throw new DocumentParseError(
        DOCUMENT_DIAGNOSTIC_CODES.limitExceeded,
        `XML 元素数量超过上限 ${limits.maxElements}`,
        path,
      )
    }
    const element: Builder = { kind: 'element', name: tag.name, attrs: tag.attrs, children: [] }
    top().children.push(element)
    if (!tag.selfClosing) {
      if (stack.length >= limits.maxDepth) {
        throw new DocumentParseError(
          DOCUMENT_DIAGNOSTIC_CODES.limitExceeded,
          `XML 嵌套深度超过上限 ${limits.maxDepth}`,
          path,
        )
      }
      stack.push(element)
    }
    index = tag.end
  }

  if (stack.length !== 1) {
    throw malformed(`XML 结束时仍有 ${stack.length - 1} 个未闭合标签（最内层 <${top().name}>）`, path)
  }

  if (state.sawDoctype) {
    state.diagnostics.push(diagnostic(
      DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved,
      'warning',
      'XML 含 DOCTYPE/DTD 声明，已整段跳过：本解析器不解析实体定义，外部实体与实体展开都不可能生效。',
      path,
    ))
  }

  const realRoot = root.children.find(isElement)
  return { ...(realRoot === undefined ? {} : { root: realRoot }), diagnostics: state.diagnostics, sawDoctype: state.sawDoctype }
}

function malformed(message: string, path: string): DocumentParseError {
  return new DocumentParseError(DOCUMENT_DIAGNOSTIC_CODES.structuredParseFailed, message, path)
}

/**
 * 跳过 `<!…>` 声明，正确处理内部子集 `[ … ]`（其中可能含 `>`）。
 *
 * 关键是**只做括号配对，不做任何内容解析**——DTD 里的 `<!ENTITY … SYSTEM "…">`
 * 因此永远不会被求值。
 */
function skipDeclaration(input: string, start: number, path: string): number {
  let index = start + 2
  let bracketDepth = 0
  while (index < input.length) {
    const char = input[index]!
    if (char === '[') bracketDepth += 1
    else if (char === ']') bracketDepth -= 1
    else if (char === '>' && bracketDepth <= 0) return index + 1
    index += 1
  }
  throw malformed('XML 声明没有闭合的 >', path)
}

interface StartTag {
  readonly name: string
  readonly attrs: Map<string, string>
  readonly selfClosing: boolean
  readonly end: number
}

/** 解析起始标签：名字 + 属性 + 是否自闭合。属性值支持单/双引号与无引号。 */
function parseStartTag(input: string, start: number, state: ScanState): StartTag {
  let index = start + 1
  const nameStart = index
  while (index < input.length && !isNameTerminator(input[index]!)) index += 1
  const rawName = input.slice(nameStart, index)
  if (rawName === '') throw malformed(`位置 ${start} 处的标签名为空`, state.path)

  const attrs = new Map<string, string>()
  let selfClosing = false

  while (index < input.length) {
    while (index < input.length && isWhitespace(input[index]!)) index += 1
    if (index >= input.length) break
    const char = input[index]!
    if (char === '/') {
      if (input[index + 1] !== '>') throw malformed(`<${rawName}> 的 "/" 后不是 ">"`, state.path)
      selfClosing = true
      index += 2
      break
    }
    if (char === '>') {
      index += 1
      break
    }

    const attrStart = index
    while (index < input.length && !isAttrNameTerminator(input[index]!)) index += 1
    const rawAttrName = input.slice(attrStart, index)
    if (rawAttrName === '') throw malformed(`<${rawName}> 内出现无法解析的属性名`, state.path)

    while (index < input.length && isWhitespace(input[index]!)) index += 1
    let value = ''
    if (input[index] === '=') {
      index += 1
      while (index < input.length && isWhitespace(input[index]!)) index += 1
      const quote = input[index]
      if (quote === '"' || quote === "'") {
        const close = input.indexOf(quote, index + 1)
        if (close < 0) throw malformed(`属性 ${rawAttrName} 的引号没有闭合`, state.path)
        value = decodeEntities(input.slice(index + 1, close), state)
        index = close + 1
      } else {
        const valueStart = index
        while (index < input.length && !isWhitespace(input[index]!) && input[index] !== '>') index += 1
        value = input.slice(valueStart, index)
      }
    }
    // 以本地名为键：OOXML 的 `w:val` / `r:id` / `xml:space` 都按 val / id / space 取。
    const local = localName(rawAttrName)
    if (!attrs.has(local)) attrs.set(local, value)
  }

  return { name: localName(rawName), attrs, selfClosing, end: index }
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r'
}

function isNameTerminator(char: string): boolean {
  return isWhitespace(char) || char === '>' || char === '/'
}

function isAttrNameTerminator(char: string): boolean {
  return isWhitespace(char) || char === '=' || char === '>' || char === '/'
}

/** 去掉命名空间前缀：`w:val` → `val`；无前缀时原样返回。 */
export function localName(qualified: string): string {
  const colon = qualified.indexOf(':')
  return colon < 0 ? qualified : qualified.slice(colon + 1)
}

/**
 * 解码实体引用。
 *
 * **只认 5 个预定义实体与数字字符引用**，其余保持字面量并记一次诊断。这里没有
 * "查实体表并展开"的代码路径，因此内部实体爆炸无法构造。
 */
function decodeEntities(raw: string, state: ScanState): string {
  if (!raw.includes('&')) return raw
  let out = ''
  let index = 0
  while (index < raw.length) {
    const amp = raw.indexOf('&', index)
    if (amp < 0) {
      out += raw.slice(index)
      break
    }
    out += raw.slice(index, amp)
    const semi = raw.indexOf(';', amp + 1)
    // 限制扫描长度：`&` 之后很久才有 `;` 说明这不是实体引用，按字面量处理。
    if (semi < 0 || semi - amp > 12) {
      out += '&'
      index = amp + 1
      continue
    }
    const body = raw.slice(amp + 1, semi)
    const predefined = PREDEFINED_ENTITIES.get(body)
    if (predefined !== undefined) {
      out += predefined
      index = semi + 1
      continue
    }
    const code = numericReference(body)
    if (code !== undefined) {
      out += String.fromCodePoint(code)
      index = semi + 1
      continue
    }
    if (!state.unknownEntityReported) {
      state.unknownEntityReported = true
      state.diagnostics.push(diagnostic(
        DOCUMENT_DIAGNOSTIC_CODES.dangerousPartRemoved,
        'warning',
        `XML 中出现未定义的实体引用 &${body};，已保留字面量：本解析器不解析实体定义，只支持 5 个预定义实体与数字字符引用。`,
        state.path,
      ))
    }
    out += `&${body};`
    index = semi + 1
  }
  return out
}

/** 解析 `&#123;` / `&#x1F;`；非法或越界返回 undefined（不猜测）。 */
function numericReference(body: string): number | undefined {
  let code: number
  if (body.startsWith('#x') || body.startsWith('#X')) {
    if (!/^[0-9a-fA-F]+$/.test(body.slice(2))) return undefined
    code = Number.parseInt(body.slice(2), 16)
  } else if (body.startsWith('#')) {
    if (!/^[0-9]+$/.test(body.slice(1))) return undefined
    code = Number.parseInt(body.slice(1), 10)
  } else {
    return undefined
  }
  // 代理区码位与超出 Unicode 范围的码位都不能交给 String.fromCodePoint。
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined
  if (code >= 0xd800 && code <= 0xdfff) return undefined
  return code
}

// ── 遍历助手（消费者只需要这几件事）────────────────────────────────────────────

/** 直接子元素中指定本地名的元素（保持文档顺序）。 */
export function childrenNamed(element: XmlElement, name: string): readonly XmlElement[] {
  const out: XmlElement[] = []
  for (const child of element.children) {
    if (child.kind === 'element' && child.name === name) out.push(child)
  }
  return out
}

/** 第一个指定本地名的直接子元素。 */
export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (child.kind === 'element' && child.name === name) return child
  }
  return undefined
}

/** 沿路径逐级取第一个子元素：`dig(element, 'pPr', 'pStyle')`。 */
export function dig(element: XmlElement, ...path: readonly string[]): XmlElement | undefined {
  let current: XmlElement | undefined = element
  for (const name of path) {
    if (current === undefined) return undefined
    current = firstChild(current, name)
  }
  return current
}

export function attr(element: XmlElement, name: string): string | undefined {
  return element.attrs.get(name)
}

/**
 * 元素内全部文本（含后代），按文档顺序拼接。
 *
 * 用显式栈而非递归：OOXML 的正文可以很深，递归会在畸形文档上爆栈。
 */
export function textOf(element: XmlElement): string {
  let out = ''
  const stack: XmlNode[] = [...element.children].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.kind === 'element') {
      for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!)
    } else {
      out += node.value
    }
  }
  return out
}

/**
 * 按 OOXML 语义拼接段落文本：`w:tab` → `\t`，`w:br` / `w:cr` → `\n`。
 *
 * 这是 `textOf` 的专用版本：Word 把制表符与换行建模成**空元素**而不是文本节点，
 * 直接 `textOf` 会把 `A<TAB>B` 拼成 `AB`，等于静默改变内容。
 */
export function paragraphText(element: XmlElement): string {
  let out = ''
  const stack: XmlNode[] = [...element.children].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.kind === 'text') {
      out += node.value
      continue
    }
    if (node.name === 'tab') {
      out += '\t'
      continue
    }
    if (node.name === 'br' || node.name === 'cr') {
      out += '\n'
      continue
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]!)
  }
  return out
}
