# M5 发布门槛记录

> 用途：回答"现在能不能发布"这个问题，并且**每一项都有可复核的证据**。
>
> 规则（与 `docs/11` §13 一致）：**只有"代码 + 失败路径测试 + 全量验证"三者齐备才写 ✅**；
> 只做了接口、只写了文档、只跑过一次人工验证的，一律写 ⬜ 或 🟡 并注明缺什么。
> **不写"待补充"**——缺什么就写缺什么。

基线：`node --test` **805/805 pass、0 fail、0 skip**；`tsc --noEmit` 与
`tsc -p tsconfig.build.json` 均通过。

---

## 1. 门槛总表

| # | 门槛 | 状态 | 证据 | 缺什么 |
|---|---|---|---|---|
| 1 | 安全：越权、凭据、存在性 | ✅ | `test/m5-security-gate.test.ts`（6 项） | — |
| 2 | 安全：SSRF | ✅ | `test/ssrf-guard.test.ts`（12 项）+ `test/platform-tools.test.ts` 建连前复核 | — |
| 3 | 安全：路径越权与文档解析限额 | ✅ | `test/fs-tools.test.ts`、`test/documents-file-reader.test.ts`（6 项）、`test/documents-ooxml-safety.test.ts` | — |
| 4 | 恢复：备份 → 恢复 → 续跑 | ✅ | `test/m5-recovery-drill.test.ts`（3 项） | — |
| 5 | 并发：跨进程门任务 CAS 与运行锁 | ✅ | `test/m5-multiprocess-concurrency.test.ts`（4 项，4 个真实子进程；连跑 8 次全绿） | — |
| 6 | 并发：同进程内的 CAS | ✅ | `test/persistence.test.ts`（6 项）、契约套件 2 项（file/memory/compose） | — |
| 7 | 预算：超限终止与查询一致 | ✅ | `test/usage.test.ts`、`test/pipeline-run-service.test.ts` 的预算用例、Web e2e 验收9 | — |
| 8 | 预算：**长跑（跨天）验证** | ⬜ | — | 需要真实跨天运行；本轮只验证了单次运行的预算终止与聚合 |
| 9 | Web 集成：六阶段端到端（脚本化宿主） | ✅ | `test/web-http.test.ts` 验收1~9（12 项，含重启续跑、越权拒绝、用量对账） | — |
| 10 | Web 集成：六阶段端到端（**真实被测系统**） | 🟡 | `test/platform-tools.test.ts` 的 `executor_run really executes cases…` 已对**真实本地 HTTP 服务**执行并产出证据与会话 | 缺"真实被测系统 + 真实模型"的完整六阶段；当前 execute 阶段仍是脚本化宿主 |
| 11 | 外部后端：PostgreSQL / Object Store | ⬜ | `test/storage-external.test.ts` 只验证**接口层**与契约 | **未支持**：没有生产可用的实现 |
| 12 | 提交合规（docs/11 §10 的 10 条模板） | ✅ | `docs/11` §13.1 | — |

---

## 2. 逐项说明

### 门槛 1：安全（越权 / 凭据 / 存在性）

`test/m5-security-gate.test.ts` 与单元测试**互补**：那些证明"某个判据存在"，
这一组证明**它们在真实服务边界上组合起来仍然成立**。

- **零副作用**：对 `claimGate` / `decideGate` / `cancelGate` / `reenter` 各用
  viewer 与无角色身份试一遍，然后**逐文件比 sha256 + size**——被拒的请求不得改动
  磁盘上的任何一个字节。
- **凭据穷举**：把所有返回对象与**错误详情**递归扫一遍哨兵，断言既不含 API Key 值
  也不含 `apiKey` 字段名。
- **存在性不泄露**：越权与不存在必须返回**同一个状态码**（否则可枚举）。

本轮由这组门槛修掉的两个真实泄露：

1. `assertScopeMatch` 的消息回显目标作用域（`expected demo, got other-project`）
   → 改成只回显调用者自己的作用域。
2. 跨作用域读取返回 `scope-mismatch`(403)，而"不存在"返回 `not-found`(404)
   → 403/404 的差别本身就是一个枚举通道。改为**统一按"不存在"回应**；
   项目白名单越界与调用者自报输入不符仍保留 `scope-mismatch`（那是调用者自己的信息）。

### 门槛 4：恢复演练

`test/m5-recovery-drill.test.ts` 每次全量测试都真的跑一遍：

```text
造现场（跑到第二个门） → cp -r 整棵 dataRoot = 备份 → 恢复进全新 dataRoot
  → 新 service/host → 视图 deepEqual 备份前 → recover 判定 → 批准后继续跑
```

三条硬断言：视图**逐字相同**；停在人工门必须是 `await-human` 且 `started: false`；
恢复后只 spawn `design`（receive 与 analyze 都不得被重跑）。
另外覆盖终态不被重启、检查点缺失被**显式报告**而不是静默跳过。

### 门槛 5：跨进程并发

`test/m5-multiprocess-concurrency.test.ts` 用 `child_process` 起 **4 个真实 node 进程**。
为什么必须多进程：in-process 的 `Promise.all` 只能证明"同一进程内的读改写被串行化了"，
而生产竞争来自 Web 服务 / CLI / 恢复扫描同时在写同一份记录。

**这组门槛抓到了一个真实的互斥破坏**（不是读代码发现的）：

```text
pid 35509 持有到 1790514928756，pid 35510 从 1790514926253 就开始  ← 区间重叠
```

根因：`mkdir` 成功到写 `owner.json` 之间有一个**必然存在**的窗口，
竞争者读到"目录存在但 owner 文件不存在"会把 `staleReason(null)` 判成 `'unreadable'`
（= 崩溃残留）并抢占该目录 → 两个进程都以为自己持有锁。

修法：owner 文件**不存在**且目录很新（5 秒宽限）→ 判定为"另一个进程正在获取"，
抛 `PipelineLockHeldError`。与"owner 文件**存在**但内容损坏"严格区分：
后者是已经获取过的痕迹，仍按可恢复残留处理。

同时修掉一个错误分类错位：写 owner 期间目录被抢走时抛裸 `ENOENT`，
上层会归成 `run-failed`(500)，而它其实是 `conflict`(409)。

修后稳定性：**连跑 8 次，每次 4/4 通过**（修前连跑 6 次有 2 次失败）。

### 门槛 9：Web 六阶段端到端

`test/web-http.test.ts` 起真实子进程 server，覆盖：创建 → 后台跑到门 → 裁决 →
不重生成产物 → 六阶段完成 → changes-needed 打回 → 杀进程重启续跑 → execute 缺真实
执行数据时门禁失败（不伪造记录）→ Web/CLI 读同一 dataRoot → 用量与预算对账。

### 门槛 10 为什么只有 🟡

`executor_run` 已对**真实本地 HTTP 服务**执行用例、写证据、续接会话（有测试）。
但"六阶段全程用真实被测系统"没有做到，原因是 **`targetBaseUrl` 的 SSRF 判据默认
拒绝本机与内网地址**——测试里必须注入覆写才能连本地服务，那就不再是"生产同构"的
端到端。要补这一项，需要一个**公网可达的、专用的被测系统**，这属于环境准备，
不是代码改动。

### 门槛 11 为什么是 ⬜

`docs/adr/0002` §7 与 `docs/12` §1.3 都写明：**当前生产部署只能用文件后端 + 本地磁盘**。
`storage-external.test.ts` 验证的是"外部后端该满足什么契约"，不是一个可运行实现。
要让索引与幂等台账也随后端切换，需要**新增端口**（带集合的键值记录），
那是对 `docs/10 §8.2` 九端口清单的扩展，属新的设计决定。

---

## 3. 发布判定

| 场景 | 可以发布吗 | 依据 |
|---|---|---|
| 单机 / 小团队内部使用（文件后端 + 本地磁盘） | **可以** | 门槛 1~7、9、12 全绿；门槛 8/10/11 不影响正确性（见下） |
| 多进程高并发写入同一 dataRoot | **可以，但需压测确认** | 门槛 5 已覆盖 4 进程；建议按实际并发度再跑一次 `m5-multiprocess-concurrency` 并把 `WORKERS` 调大 |
| 多租户 SaaS（需要外部后端） | **不可以** | 门槛 11 未支持 |
| 对外宣称"平台化 M0-M4 全部完成" | **不可以** | `docs/11` §12 的硬性要求；M4-B 与 M5 门槛 8/10/11 未收口 |

门槛 8（跨天长跑）与门槛 10（真实被测系统）**不影响正确性判定**：它们要验证的是
"长期运行不漂移"与"对真实系统有效"，而不是"某条代码路径正确"。缺它们时按上表
限制发布范围即可，但**不得**声称这两项已完成。
