# ADR-0001：文档解析库选型与降级策略

- 状态：已接受
- 日期：2026-09-24
- 适用范围：`packages/platform-pipeline/src/documents/`
- 依据：`docs/10-next-phase-implementation-plan.md` §5.6.5、§5.6.9、§5.6.10、§5.6.11

## 背景

`docs/10` §5.6 要求知识库导入支持 PDF / Word / Excel / Markdown，且 §5.6.9 明确规定：
**选库前必须先做 ADR，不允许"看到能 import 就直接安装"**。本 ADR 记录实测依据与决策，
后续替换任何一个解析器都不应改动 `PipelineDriver`、机器门禁或 `parse_doc` 工具契约
（§5.6.11 第 10 条）。

所有结论均为**本机实测**（Node v26.7.0 / npm 10.9.7 / macOS），不是凭文档推断。

## 决策摘要

| 格式 | 采用方案 | 理由 |
|---|---|---|
| PDF | `pdfjs-dist`（Apache-2.0，懒加载） | §5.6.5 A 明令"不能手写 PDF 二进制解析器" |
| DOCX | `fflate` 解包 + 自研安全 XML 分词器 | §5.6.5 B 允许"成熟解析库**或**安全的 XML 解包流程" |
| XLSX | `fflate` 解包 + 自研安全 XML 分词器 | 同上（§5.6.5 C 要求 workbook→sheet→range 中间结构，自研才能完全控制） |
| Markdown | 自研（已实现） | 结构简单，无需依赖 |
| CSV/TSV/TXT/YAML/JSON | 自研 + `yaml`（已实现） | 同上 |
| DOC（老二进制） | **不支持**，返回 `unsupported` | §5.6.5 B 允许二选一，见下文"为什么不做 .doc/.xls" |
| XLS（老二进制） | **不支持**，返回 `unsupported` | 同上 |

新增运行时依赖共 **2 个**：`pdfjs-dist`、`fflate`。两者都是零传递依赖。

## 1. Node ≥24 兼容性

| 库 | `engines` 声明 | 实测（Node v26.7.0） |
|---|---|---|
| `pdfjs-dist@6.3.289` | `>=22.13.0 \|\| >=24` | `import('pdfjs-dist/legacy/build/pdf.mjs')` 成功；文本提取、加密检测、损坏检测全部通过 |
| `fflate@0.8.3` | 未声明 | 流式 `Unzip` + `zipSync` 全部通过 |

`pdfjs-dist` 的 `engines` 明确覆盖 Node ≥24，符合本包 `engines.node = ">=24"`。

**实测要点**：在 Node 下必须用 `pdfjs-dist/legacy/build/pdf.mjs`。直接 import 主入口会打印
`Warning: Please use the 'legacy' build in Node.js environments.`——这是库自己的提示，
说明非 legacy 构建假定浏览器 DOM 环境。

**`PDFDocumentProxy.destroy()` 在 6.3.289 中不存在**（调用会 `TypeError`）。释放资源必须用
`loadingTask.destroy()`。这一点没有文档说明，是实测踩到的。

## 2. 是否支持纯 JavaScript，是否依赖系统二进制

两者都是**纯 JavaScript，零系统二进制**：

- `pdfjs-dist`：零 `dependencies`，不依赖 ImageMagick / Ghostscript / poppler / LibreOffice。
  仅做文本提取时也不需要 `canvas` 原生模块（`getTextContent()` 不触发渲染路径）。
- `fflate`：零 `dependencies`，纯 JS inflate/deflate。

因此**不需要** §5.6.9 警告的"需要系统 LibreOffice 的黑盒转换"，部署环境无需额外安装任何东西。

## 3. 许可证

| 库 | 许可证 | 分发/商用 |
|---|---|---|
| `pdfjs-dist` | Apache-2.0 | 允许，含专利授权条款 |
| `fflate` | MIT | 允许 |

两者均为 OSI 认可、无 copyleft 传染性的许可证。**已排除**的候选：
`jszip` 的许可证是 `MIT OR GPL-3.0-or-later`（双许可，默认路径存在 GPL 风险解读空间），
在有 MIT 替代品（`fflate`）的情况下不引入。

## 4. 维护状态与安全历史

| 库 | 最新版 | 发布日期 | 版本数 | 解压体积 | 类型声明 |
|---|---|---|---|---|---|
| `pdfjs-dist` | 6.3.289 | 2026-08-29 | 1566 | 33.17 MiB | 自带 `.d.mts` |
| `fflate` | 0.8.3 | 2026-07-20 | 58 | 0.76 MiB | 自带 `.d.mts` |

- `pdfjs-dist` 是 Mozilla 的 PDF.js 官方发布产物，月均发布节奏，上游有独立安全公告流程。
- `fflate` 体积小、API 面窄、无传递依赖，攻击面显著小于 `jszip`/`adm-zip`。

**关于 33.17 MiB**：这是 `pdfjs-dist` 的体积成本。因此 PDF 解析器采用
**懒加载（`await import()`）**，只在真的解析 PDF 时才加载，markdown/csv 路径不会触碰它。

## 5. 是否支持流式/分页/大文件限制

- `pdfjs-dist`：`getDocument()` 返回 loading task，可逐页 `getPage(n)` / `getTextContent()`，
  因此 **`pageRange` 是天然支持的分页读取**，不需要把整份文档文本一次性读入。实测
  2 页 PDF 可精确读出每页文本与 `transform`（x/y 坐标）。
- `fflate`：提供流式 `Unzip` 类（`onfile` + 每条目 `ondata` 分块回调），
  因此**可以在解压过程中逐块计数并中断**，不依赖 ZIP central directory 的声明值。
  这一点是本 ADR 选择 `fflate` 而非 `unzipSync` 一次性解包的决定性理由，见第 6 节。

## 6. 是否会执行宏、外链或 XML 外部实体

**都不会。** 这是本方案最重要的安全性质，逐条说明：

### PDF：不执行任何文档内容

- PDF.js 是**查看器**库，不实现 PDF 的 JavaScript 解释器（`/JS`、`/JavaScript` 动作不会被执行）；
- 解析时显式传 `isEvalSupported: false`，禁止库内部走 `eval` 路径；
- 不做表单提交、不下载 `/URI` 外链、不打开 `/EmbeddedFile` 附件；
- 解析前扫描原始字节，命中 `/JavaScript`、`/JS`、`/OpenAction`、`/Launch`、`/EmbeddedFile`
  等特征时产出 `DANGEROUS_PART_REMOVED` 诊断（只诊断，不执行）。

### OOXML：XXE 在构造上不可能

DOCX/XLSX 的 XML 由**自研分词器**处理（`src/documents/xml.ts`），它对 DOCTYPE / 内部实体
/ 外部实体的处理是：**遇到 `<!DOCTYPE` 直接跳过声明并记诊断，实体引用只解析 XML 预定义的
5 个（`amp lt gt quot apos`）与数字字符引用**。没有实体扩展机制，因此：

- 外部实体（`SYSTEM "file:///etc/passwd"`）无法解析 → 不可能 SSRF / 任意文件读取；
- 内部实体扩展（Billion Laughs）无法构造 → 不可能实体爆炸。

这是"用构造消除整类漏洞"，而不是"配置一个开关关掉它"。

### OOXML：危险部件根本不进入解析流程

`document-sanitize.ts` 的 `DANGEROUS_PARTS` 按 OPC 固定路径识别宏（`vbaProject.bin`）、
OLE/嵌入对象、ActiveX、外部链接（`externalLinks/`）。这些条目在解包阶段**被直接跳过
（不注册解码器、不 `start()`），不产生任何解压输出**，并产出聚合诊断。

### zip bomb：硬上限不信任声明值

实测发现：`fflate.unzipSync` 的 `filter` 回调收到的是 **central directory 的声明值**
（`originalSize` / `size`）。**声明值是可以伪造的**——一个手工构造的 ZIP 可以声明 1 KiB、
实际解压出几十 GiB。deflate 的理论最大压缩比约 1032:1，32 MiB 输入最坏可膨胀到 ~33 GiB。

因此解包不用 `unzipSync`，而是用流式 `Unzip`：

1. `onfile` 阶段做**部件白名单**——只接受本次真正要读的 OOXML 部件
   （如 `word/document.xml`、`xl/worksheets/sheet1.xml`），其余一律不 `start()`。
   **这是主要防线**：不读的部件永远不会被解压（实测炸弹条目零输出）。
2. `ondata` 阶段逐块累计**实际解压字节数**，超过单条目或累计上限即抛出，
   fflate 会以错误回调终止该条目（实测 `received=20971520` 时被成功拦下，条目未进入结果）。
3. 白名单 + 逐块计数之外，仍用 central directory 声明值做一次廉价预检（快速失败）。

### 白名单过窄是**静默丢数据**，不是报错

白名单是主要防线，因此它有一个反直觉的失效模式：**漏掉一个必需部件不会报错，
只会让某个字段悄悄变空**。

实测（`test/documents-xlsx.test.ts` 固定该行为）：XLSX 采用**两趟解包**——第一趟只取
工作簿结构，据 `state` 与 `sheetNames` 决定读哪些 sheet，第二趟才用精确白名单解包这些
sheet。但"表格定义（`xl/tables/*.xml`）归属于哪张 sheet"**只能**由该 sheet 自己的关系
文件（`xl/worksheets/_rels/sheetN.xml.rels`）决定。第一趟白名单最初没有包含它，于是
`metadata.tableDefinitions` 永远是 `undefined`、诊断里也永远不会出现表名——**解析状态
仍是 `parsed`，没有任何错误**。

因此白名单的判据不是"哪些部件是数据"，而是"**决定读哪些数据**所必需的全部部件"。
`schema.xlsx` 的 sheet rels 是几十字节的清单，纳入第一趟不削弱"未选中的 sheet 字节
从不被解压"这一性质。

同一类风险在第二趟也需要注意：表格定义的归属**必须**按 sheet 的 rels 解析，
不能从 `xl/tables/tableN.xml` 的编号反推（编号与 sheet 的对应关系不保证一致）。
另需注意 OPC 的 Target 解析基准是**部件所在目录**（`xl/worksheets/`），因此真实 Excel
写出的是 `../tables/table1.xml` 而非 `../../tables/table1.xml`。

## 7. 失败时如何降级到 `unsupported`

三层降级，每层都有测试：

| 场景 | 行为 |
|---|---|
| 格式无解析器（`.doc` / `.xls`） | 注册表返回 `status='unsupported'` + `FORMAT_NOT_SUPPORTED` + 定向转换提示 |
| PDF 库加载失败（打包裁剪 / 边缘运行时） | `PdfParser` 捕获 import 失败，抛 `DocumentParseError(FORMAT_NOT_SUPPORTED)` → `unsupported` + 可操作提示；**不抛未捕获异常** |
| PDF 加密 | `PasswordException` → `DOCUMENT_ENCRYPTED` → `unsupported` |
| PDF 损坏 | `InvalidPDFException` → `parse-failed` |
| OOXML 缺必需部件 / XML 非法 | `parse-failed` + 结构化诊断 |
| 超限 / 超时 / 被取消 | `limit-exceeded` / `PARSE_TIMEOUT` / `PARSE_ABORTED` |

**任何情况下都不会退回"按文本读二进制"**——`document-parser.ts` 对二进制族强制校验
magic bytes，对不上即 `unsupported`。

## 8. 是否需要单独的 worker / 沙箱进程

**不需要**，理由：

- 两个库都不执行文档内容，因此不存在"恶意代码需要隔离"的前提；
- 解析是**只读 + 全内存**：不落盘（因此不需要 §5.6.8 的临时隔离目录），
  不派生进程，不访问网络；
- 资源上限由 `document-limits.ts` 统一约束，且解包有实测有效的逐块硬上限。

**已知代价**：`fflate` 的流式解包与自研 XML 分词器都是**同步**执行，会阻塞事件循环。
在 32 MiB 文件上限 + 30s 超时预算下可接受；若将来放宽文件上限，应改为
`AsyncUnzipInflate`（`fflate` 提供 worker 版本）或移入 worker 线程。此约束记录在案。

## 9. 为什么不做 `.doc` / `.xls`

§5.6.5 B/C 允许二选一：接入明确安全的适配器，或返回 `unsupported` 并提示转换。选后者：

- `.doc`/`.xls` 是 OLE2 复合文档，正文以私有二进制流（`WordDocument` / `Workbook`）存放，
  没有可靠的纯 JS 只读解析器；
- 主流方案是调 LibreOffice 转换，属于 §5.6.9 明确劝退的"需要系统 LibreOffice 的黑盒转换"——
  它需要子进程、需要沙箱、需要确认部署环境与许可证；
- 老格式无法在解析阶段排除宏与 OLE 嵌入对象，与 §5.6.5「不执行宏、嵌入对象」冲突。

因此 `.doc`/`.xls` 返回 `unsupported`，提示用户先转换为 `.docx`/`.xlsx`。
`document-parser.ts` 的 `unsupportedMessage()` 为这两种格式给出**定向**提示。

**注意**：`.xls` 在 `document-detect.ts` 里仍会被正确识别为 `xls`（OLE2 签名 + 扩展名消歧），
不会被误判成 `doc` 后给出错误提示。

## 10. 表格提取的边界（PDF）

§5.6.5 A 明确：「表格提取是增强能力，**不得把 PDF 中布局不稳定的文本硬拼成"准确表格"**」。

因此 PDF 解析器**不产出 `tables`**。PDF 没有表格语义，只有绝对定位的文字与线段；
任何"表格识别"都是启发式布局推断，把它输出成 `ParsedTable` 会让下游（知识投影、人工门）
误以为拿到了结构。取而代之：

- 每页文本进 `ParsedSection`（带 `#page=N` sourceRef）；
- 检测到文本顺序可疑（同一页内 y 坐标回跳比例过高）时给 `TEXT_ORDER_SUSPECT` warning，
  提示调用方"该页可能是多栏或乱序，不要当作线性文本读"。

`confidence` 取 `structure-preserved`（有真实文本层）而非 `exact-text`——页内阅读顺序仍是
按提取顺序拼装的，不是文档作者声明的结构。

## 11. Fixture 策略

§5.6.10 要求"必须新增 fixture 和测试，不能只测扩展名"。本方案**在测试期程序化构造
真实二进制 fixture**（`test/document-fixtures.ts`），而不是提交不透明的二进制文件：

- **可审查**：每个 fixture 的构造代码就在仓库里，评审能看到它到底含什么；
- **可控**：能精确构造 §5.6.10 要求的病理样本——zip bomb、超高压缩比、宏部件、
  OLE 嵌入、外部实体、路径穿越条目、隐藏 sheet、无缓存值公式、合并单元格；
- **可复现**：构造是确定性的，测试不依赖外部文件。

**加密 PDF 的构造**：需要一个真正符合 PDF 标准的 RC4 40-bit 加密文档（V=1 / R=2），
否则测试只是"假加密"。实测发现 **OpenSSL 3 的默认 provider 已移除 RC4**
（`ERR_OSSL_EVP_UNSUPPORTED`），因此 fixture 生成器内联了一个纯 JS RC4（KSA + PRGA）。
实测确认该 fixture 是**真加密**：无密码 → `PasswordException: No password given`，
错误密码 → `Incorrect password`，正确密码 → 成功解出原文。

测试矩阵按 §5.6.10 的三节落在五个文件里：

| 文件 | 覆盖 |
|---|---|
| `test/documents-pdf.test.ts` | 多页可复制文本、扫描件、损坏、加密、含 JavaScript、pageRange、超页、顺序可疑、取消、字节不被 detach |
| `test/documents-docx.test.ts` | 标题三级判据、列表、表格、合并单元格、页眉页脚、媒体、宏/OLE、外链、属性、XXE、`w:sdt`、超限、解析器可替换 |
| `test/documents-xlsx.test.ts` | 多 sheet、隐藏 sheet、日期/布尔/错误/内联串、1900 假闰日、公式缓存值、合并、筛选/冻结/表格定义、空行策略、两趟解包、超行列、取消 |
| `test/documents-ooxml-safety.test.ts` | 白名单内外炸弹、伪造声明值、条目数/总量上限、路径穿越、条目名校验、关系目标逃逸、危险部件分类与聚合、Billion Laughs、日志摘要不泄露正文 |
| `test/documents-text-samples.test.ts` | Markdown 嵌套列表/引用/代码块/表格、CSV 引号+字段内换行+空列+CRLF、TSV、非 UTF-8、BOM、magic 与扩展名冲突 |
| `test/documents-knowledge-projection.test.ts` | 四类格式 sourceRef 回读、partial/OCR 不得 verified、失败不产出条目、幂等与 supersede、`parse_doc` 不落盘且冲突仍走 `KnowledgeConflictError` |

## 12. 结论与后续

采纳上述方案。**复核触发条件**（任一满足即需重新评审本 ADR）：

- `pdfjs-dist` 出现影响文本提取的安全公告，或 Node 兼容性声明回退；
- 需要支持 `.doc`/`.xls`，或需要放宽 32 MiB / 30s 上限（触发第 8 节的 worker 改造）；
- 需要 PDF 表格提取（需要引入布局分析，属新的能力域，应另开 ADR）；
- `fflate` 停止维护或出现安全公告。
