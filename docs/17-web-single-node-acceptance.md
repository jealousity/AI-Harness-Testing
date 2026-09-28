# Web 单机化验收记录（W6）

> 用途：回答"Web 端现在能不能算达到本地单机运行标准"，并且**每一项都指向可复核的证据**。
>
> 规则（与 `docs/13`、`docs/11` §13 一致）：**只有"代码 + 测试 + 全量验证"三者齐备才写 ✅**；
> 只有静态断言、或只有人工看过的，写 🟡 并注明缺什么；没做的写 ⬜ 并写明原因。
> **不写"待补充"**。

基线：`node --test` **905/905 pass、0 fail、0 skip**；`tsc --noEmit` 与
`tsc -p tsconfig.build.json` 均通过；工作区 clean，`HEAD == origin/main`。

规划书：`docs/14-web-single-node-productization-plan.md` §3 W6 的 25 项验收。

---

## 1. 规划书 25 项验收逐条对照

| # | 验收项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 启动服务成功 | ✅ | `test/web-http.test.ts`（`WebApp.start()` 轮询 `/health` 直到 200）+ 手工冒烟（3082 端口，静态资源 200/200/200） |
| 2 | 健康接口不泄露 pipeline ID | ✅ | `web-http.test.ts` 验收10a：字段集合**恰好**四键，且不含任何 pipelineId |
| 3 | 创建流水线返回 202 | ✅ | `web-http.test.ts` 验收1、`web-stage-flow.test.ts` |
| 4 | 列表/详情/恢复使用同一索引事实 | ✅ | `web-index-and-creation.test.ts` 三条（list 走注入 store / 重建实例 / 恢复扫描同一 store） |
| 5 | 六阶段逐阶段推进 | ✅ | `web-stage-flow.test.ts`：逐阶段断言 `currentStage === nextStage === 预期阶段` |
| 6 | 每个阶段人工门批准 | ✅ | 同文件：循环 6 次「run → 断言 awaiting-gate → 认领 → 批准」 |
| 7 | `changes-needed` 打回并再次运行 | ✅ | `pipeline-run-service.test.ts`、`web-http.test.ts` 验收4 |
| 8 | `rejected` 终止 | ✅ | `web-stage-flow.test.ts`：终态 → `nextAction=reenter`，且服务端确实拒绝再裁决 |
| 9 | 机器门禁失败显示升级任务 | ✅ | 同文件：用真实预算超限路径制造，断言 `isEscalation=true` 且不被算作阶段门 |
| 10 | `review-failed` 终态 | ✅ | `driver.test.ts`、`web-async-runner.test.ts`（重启后不绕过重试上限） |
| 11 | execute 真实执行数据对账 | ✅ | `m5-execute-e2e.test.ts`：真实 HTTP 服务 + 真实 `executor_run` + R4-08 通过 |
| 12 | 缺少执行数据拒绝 | ✅ | 同文件：R4-08 拦下，且**不得存在**执行会话文件 |
| 13 | 产物不存在返回 404，不返回空对象 | ✅ | `web-http.test.ts` 验收3、`pipeline-run-service.test.ts` |
| 14 | 产物/违规/findings 安全显示 | 🟡 | `web-ui-contract.test.ts`：断言 app.js **不出现** `innerHTML`/`insertAdjacentHTML`/`document.write`。**缺**：真实浏览器里注入恶意产物字符串的端到端验证 |
| 15 | 事件时间线与持久化事实一致 | ✅ | `web-http.test.ts` 验收5、`web-single-node.test.ts`（重启后事件从磁盘重建） |
| 16 | usage/预算与 CLI 一致 | ✅ | `web-http.test.ts` 验收9：Web 与 CLI 读同一 dataRoot，`stages`/`totals` deepEqual |
| 17 | 进程杀死后 recover | ✅ | `web-http.test.ts` 验收6、`m5-recovery-drill.test.ts` |
| 18 | 重启后不自动批准 | ✅ | `m5-recovery-drill.test.ts`、`web-single-node.test.ts`（`await-human` + 零 spawn） |
| 19 | 并发裁决冲突 | ✅ | `m5-multiprocess-concurrency.test.ts`（4 个真实进程）、`persistence.test.ts` |
| 20 | storage unavailable 返回 503 | ✅ | `web-index-and-creation.test.ts`（list/recover 整体失败，不返回空列表）+ UI 侧识别 503 |
| 21 | trust headers 误配被拒 | ✅ | `web-server-config.test.ts` + `web-http.test.ts` 验收10e（实测 exit=1） |
| 22 | body NaN / 超限配置启动失败 | ✅ | `web-server-config.test.ts`（22 项）+ 验收10c/10d |
| 23 | 默认单机文件布局兼容 | ✅ | `web-single-node.test.ts`：跑完整生命周期后**数据根之外零文件**，且索引/检查点/产物/门任务落在预期路径 |
| 24 | 浏览器刷新后仍能打开同一 pipeline | 🟡 | `web-ui-contract.test.ts`：断言 URL hash 读写 + `hashchange` 监听 + **不用** localStorage。**缺**：真实浏览器里刷新一次 |
| 25 | UI 主要操作有 loading/error/success | 🟡 | 同文件：断言三种 kind 都被用到且都有样式、请求期 `disabled`。**缺**：真实浏览器里点击验证 |

**统计**：✅ 21 项、🟡 4 项（都是"只有静态断言，缺真实浏览器"）、⬜ 0 项。

---

## 2. 未完成项（**不得**写成已完成）

### 2.1 真实浏览器交互验收 —— 未做

规划书要求 `test/web-ui-contract.test.ts 或等价浏览器无框架测试`。**只完成了前半**：
`web-ui-contract.test.ts` 是**静态结构断言**（读文件、跑正则），**不执行 JS**，
因此它拦不住"JS 运行时抛错导致白屏"这类问题。

**为什么没做**：本机没有安装浏览器自动化工具（`agent-browser` 不在 PATH）；
安装它需要 `npm install -g` + 下载 Chromium（约 500MB），而**本环境的全局安装被规则禁止**，
且网络在本轮持续不稳定（多次推送重试 10 次以上才成功）。

**影响范围**：验收项 14、24、25 只能停在 🟡。**发布判定不受影响**（见 `docs/13` §3），
但**不得**据此声称"UI 交互已验收"。

**补法**：在允许全局安装或可联网的环境里执行：

```bash
npm install -g agent-browser && agent-browser install
# 启动服务后：
agent-browser open 'http://127.0.0.1:3080/#pipeline=<id>'
agent-browser snapshot -i          # 检查关键控件存在
agent-browser click <触发运行>      # 检查 loading → success
agent-browser click <暂停自动刷新>   # 检查"已暂停，数据可能过期"
agent-browser screenshot
agent-browser close
```

### 2.2 后台运行**运行期**异常对 UI 不可见 —— 未做

**前置**失败（provider 缺 Key、审批覆盖缺失）已在 W5 修好（`preflight` 前移，同步返回
`started: false` + 原因）。但 **driver 内部**抛出的异常不写检查点，因此后台运行时
对 UI 仍不可见——它只进服务端日志与 `RunResult.outcome === 'failed'`。

**为什么没做**：需要权威的运行遥测（M3）把运行期失败持久化。用"进程内记住上次失败"
绕过是被架构禁止的（那会成为第二份事实来源）。

### 2.3 数据根体检接口 / 命令 —— 未做

规划书 W5 第 9 条要求"提供数据根体检命令/接口，至少报告：配置不可读 / checkpoint 损坏 /
门任务损坏 / 索引损坏 / usage 损坏行 / 锁残留 / 版本过高"。

`StorageBackend.diagnose()` **已经实现**了这些诊断码，但**没有暴露**成 HTTP 接口或
CLI 命令。当前排障只能看服务端日志与手工看文件。

**为什么没做**：本轮预算用在了 W5 的前置校验修复与单机性质测试上；这是一条**独立的新接口**，
需要新的服务方法 + 端点 + UI 面板 + 测试，不适合塞进尾巴。

---

## 3. 本轮（W0~W6）净产出

| 阶段 | 提交 | 关键交付 |
|---|---|---|
| W0 | `bdcee5d` | `docs/15` 契约冻结稿（15 端点 + 六阶段状态模型 + 状态码语义） |
| W1 | `ee0814b` `c97b365` | `server-config.ts`：严格数值解析、危险部署组合失败关闭、启动期完整校验、`/health` 脱敏 |
| W2 | `f46cf37` `f94e7fc` | `list()` 走注入索引、索引错误分类、创建中间态、外部后端缺 `records` 装配即失败 |
| W3 | `1f15943` `65bf66b` | `deriveNextAction` + 四个派生字段 + `isEscalation` + cancel 语义统一 |
| W4 | `9611476` `2a5d136` | UI 三文件重写（AppShell + 18 条交互要求）+ UI 契约测试 |
| W5 | `67c4f5c` `4083015` | `preflight` 前移（修 W4 缺口）+ 单机 runbook + 只写数据根/重启重建 |
| W6 | 本提交 | 本验收记录 + UI 契约补 2 项 |

测试数：**824 → 905**（+81）。其中新增文件：`web-server-config`(22)、
`web-index-and-creation`(13)、`web-stage-flow`(17)、`web-ui-contract`(14)、
`web-preflight`(5)、`web-single-node`(5)。

---

## 4. 结论

**Web 端已达到"本地单机运行标准"**：六阶段流转、人工门、执行证据、恢复、预算、
错误可见性与 UI 结构都有可复核的实现与测试。

**但仍有两项必须如实声明**：

1. **UI 交互未经真实浏览器验收**（验收项 14/24/25 停在 🟡）；
2. **运行期异常对 UI 不可见**、**数据根体检接口未做**。

因此准确表述是：

> "Web 端在**结构、契约与后端行为**上已达到本地单机运行标准，21/25 项验收有机器证据；
> 其中 4 项（安全显示、刷新恢复、loading/error 状态、以及依赖它们的交互）只有静态断言，
> 真实浏览器交互验收与运行期异常可见性仍未完成。"
