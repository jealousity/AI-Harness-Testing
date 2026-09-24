/**
 * `documents/` 模块出口与内置解析器装配点（docs/10 §5.6.3）。
 *
 * 这里是**唯一**构造默认注册表的地方。CLI、Web、Harness 三个入口都必须调用
 * `defaultParserRegistry()`，不得各自 `new` 一批解析器——否则同一份文档在不同入口
 * 会得到不同的解析结果，直接违反 docs/10 §5.6.11 第 9 条「CLI、Web、Harness 入口
 * 共用同一 ParserRegistry」。
 *
 * 为什么装配点单独放在 `index.ts` 而不是 `document-parser.ts`：注册表本身只关心
 * 「按格式找解析器」这一件横切职责，让它 import 具体解析器会把注册表变成"格式清单的
 * 第二个真相来源"。放在出口层，新增格式只需改这一处。
 *
 * @module platform-pipeline/documents
 */

import { DocumentParserRegistry } from './document-parser.ts'
import { DelimitedParser } from './delimited-parser.ts'
import { DocxParser } from './docx-parser.ts'
import { MarkdownParser } from './markdown-parser.ts'
import { PdfParser } from './pdf-parser.ts'
import { JsonParser, PlainTextParser, YamlParser } from './text-parser.ts'
import { XlsxParser } from './xlsx-parser.ts'

export * from './document-types.ts'
export * from './document-detect.ts'
export * from './document-limits.ts'
export * from './document-parser.ts'
export * from './document-sanitize.ts'
export * from './knowledge-projection.ts'
export * from './xml.ts'
export * from './zip-reader.ts'
export { DelimitedParser, parseDelimitedRows } from './delimited-parser.ts'
export { MarkdownParser } from './markdown-parser.ts'
export { JsonParser, PlainTextParser, YamlParser } from './text-parser.ts'
export { PdfParser, PdfjsTextExtractor } from './pdf-parser.ts'
export { DocxParser } from './docx-parser.ts'
export { XlsxParser } from './xlsx-parser.ts'

/**
 * 内置解析器注册表。
 *
 * 覆盖四类必须支持的格式（PDF / Word / Excel / Markdown）+ 文本族（text/yaml/json）
 * 与分隔符表格（csv/tsv），即 docs/10 §5.6.11 第 1 条的"四类格式都有实际 fixture
 * 和成功解析测试"。
 *
 * `doc`/`xls` 按 docs/10 §5.6.5 B/C 的决策**不提供适配器**（ADR-0001 §9）——注册表
 * 找不到解析器时统一返回 `unsupported` 并给出定向转换提示，绝不退回按文本读。
 *
 * 注意：`text` 格式同时服务 `.txt/.log/.rst/.adoc` 与无扩展名文件，因此
 * `PlainTextParser.canParse` 是唯一会接受"扩展名未知"的解析器；注册表只在
 * `detectDocumentFormat` 已判定格式后才查表，所以不存在抢注册的问题。
 */
export function defaultParserRegistry(): DocumentParserRegistry {
  return new DocumentParserRegistry([
    new PdfParser(),
    new DocxParser(),
    new XlsxParser(),
    new MarkdownParser(),
    new DelimitedParser('csv'),
    new DelimitedParser('tsv'),
    new PlainTextParser(),
    new YamlParser(),
    new JsonParser(),
  ])
}
