# Living Office — 验收测试总表（阶段 6）

- 分支：`feature/living-office`（本报告写作时最新提交为阶段 5 `cfbc604`；阶段 6 改动尚未合并）
- 日期：2026-11-10
- 范围：阶段 1–6 的全部联动与行为测试。只写实测结论；未跑的测试见“未跑的测试”。
- 本地运行方式：`npm run test:behavior`（Node 测试，`node --test`）、`npm run check:server`、`npm run lint`、`npm run build`

## 验收 9 条覆盖情况

| # | 验收项（计划文档第 6 节） | 覆盖 | 证据（测试文件 · 断言位置） | 实测结果 |
|---|---|---|---|---|
| 1 | 四人同时工作，各回自己工位 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 a：真实任务派发后 atlas 回工位、状态 PLANNING → WORKING；另 `scripts/test-task-dispatch.mjs`（10 个测试）覆盖派发/取消/队列；`scripts/test-living-animations.mjs` 覆盖坐姿与移动 | atlas 在 4000 步内到达 working，任务完成后 8 秒窗口内 COMPLETED，随后 IDLE → BREAK；其余三人全程 standing，未被带离工位 |
| 2 | 一人完成去休息区，其余三人不受影响 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 a 尾段：任务完成后驱动 6000 步，记录其余三人 stage | 完成者进入 BREAK（去休息区），其余三人保持 standing；无一人被误派发、无一人跟随移动 |
| 3 | 一人正在喝咖啡，新任务到达立即回工位 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 b：咖啡、休息、窗边三处停靠点各一轮 | 三处停靠点均在 4000 步内中断并回到 working；中断发生在任务运行期间，非事后补救 |
| 4 | 一人处于真实规划阶段，在窗边思考 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 f4（windowThinkingEnabled 开/关）与测试 a（thinking 阶段去窗边） | thinking 阶段（PLANNING）的 agent 在 3000 步内走到窗边资源点；关闭 `windowThinkingEnabled` 后同一阶段不再上窗边；真实任务进入 coding 阶段后改去椅子，不再去窗边 |
| 5 | 一人等待用户授权，显示正确提醒，不进休息状态 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 c：`/blocked` 后驱动 100 秒模拟时间（2000 步），随后 `/unblock` 恢复派发 | BLOCKED 期间 agent 全程留工位（standing，位置与工位一致），无休息、无窗边、无白板；检查器标签 `Waiting for approval`（`agentStatusName`），检查器圆点 amber（`src/views/Studio.tsx` 源码断言）；`/unblock` 后新任务正常派发并到达 WORKING |
| 6 | 多人同时移动，无可见穿模、重叠或死锁 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 h（30 分钟长跑，全程两两距离采样）与测试 d（交接期间双方同时移动）；`scripts/test-task-linkage.mjs` 内 give-way 单元测试（三人回工位迎面相遇） | 长跑实测最小两两距离 0.900 m（下限 0.72 m）；三人迎面相遇不再死锁，全部在 482 步内回到 working（修复前同一场景 3000 步仍冻结）；give-way 让行步永不落在猫道 0.7 m 带内（东西双向断言） |
| 7 | 断开某个 agent 的连接，正确显示离线 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 e：快照 `connected === false` 后驱动 5000 步，再恢复连接 | 全员 OFFLINE，5000 步内位置逐位相同（冻结原地）；检查器标签 `Offline`、圆点 failed（源码断言）；恢复 `connected` 后解冻，继续正常派发。离线信号只用 `connected === false`；`providers[].available` 不作为离线信号（3b 已定性，只决定能否新建任务） |
| 8 | 关闭全部装饰动画不影响真实任务执行 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 f3（全关）与测试 g（ambient 关闭） | 全部偏好关闭后 3000 步闲置：无人离岗、无人上窗边/白板；随后真实任务派发仍到达 working、结束回 standing，全程零 break 行程；`ambientEnabled=false` 时自然光恒为 `{ intensity: 2.4, color: '#f4ecdc' }`，小猫隐藏 |
| 9 | 长时运行无频繁随机游走、状态混淆、性能稳态下滑 | 覆盖 | `scripts/test-task-linkage.mjs` 测试 h：30 分钟模拟时长（36000 步，步长 0.05 s），三轮任务派发/完成/交接穿插，含空闲期 | 起立/坐下切换每人 ≤2 次（上限 12 次）；最长暂态（approaching/sitting/rising/leaving）2.2 s（上限 10 s）；最小两两距离 0.900 m（下限 0.72 m）；失败任务读 ERROR、不读 COMPLETED；前 5000 步耗时 172 ms、后 5000 步 119 ms（上限为首段 3 倍），无性能下滑 |

## 全部测试文件与数量

`npm run test:behavior` 共 13 个文件、**120 个测试，全部通过**（2026-11-10 两轮完整运行均为 120/120，见“本地验证”）。

| 文件 | 数量 | 覆盖内容 |
|---|---|---|
| `scripts/test-agent-behavior.mjs` | 4 | agent 行为基础 |
| `scripts/test-agent-prompt.mjs` | 1 | agent 提示词 |
| `scripts/test-agent-status.mjs` | 15 | 十状态机（`describeAgent` / `resolveAgentStatus` / `isCollaborating` / `settleAgentStatus`） |
| `scripts/test-cli.mjs` | 4 | CLI 入口 |
| `scripts/test-living-animations.mjs` | 10 | 坐姿/移动/休闲动画 |
| `scripts/test-living-polish.mjs` | 7 | 小猫、自然光、行为设置（阶段 5） |
| `scripts/test-office-layout.mjs` | 33 | 布局生成与工位分配 |
| `scripts/test-providers.mjs` | 7 | provider 层 |
| `scripts/test-roster-api.mjs` | 1 | roster API |
| `scripts/test-task-dispatch.mjs` | 10 | 真实任务派发/取消/队列 |
| `scripts/test-task-handoff.mjs` | 11 | dependsOn 交接、`/blocked`、取消 |
| `scripts/test-task-linkage.mjs`（阶段 6 新增） | 9 | 真实任务联动链 a–h + give-way 猫道单元测试 |
| `scripts/test-vscode.mjs` | 8 | VS Code 扩展 |

## 本地验证（2026-11-10，`~/workspace/agent-office-fork`）

- `npm run test:behavior`：**120/120 通过**，第一轮与第二轮（清 lint 警告、删临时日志后）均为 120/120，0 失败。阶段 5 报告提到的 `test-task-handoff.mjs:186` 式抖动本轮未出现。
- `npm run check:server`：通过（`node --check` 全部服务端与扩展文件）。
- `npm run lint`：0 warnings / 0 errors（阶段 6 初版曾有 4 个 warning，均为新测试文件里的未用变量，已删除；见“与计划的出入”）。
- `npm run build`：通过（`vite build`，约 2.3 s）。
- 联动文件单独运行：`node --test scripts/test-task-linkage.mjs` 9/9 通过（两轮）。

## 未跑的测试

- Chrome 冒烟测试（`smoke:browser`、`smoke:floor`、`smoke:avatars`）：**未跑**。本机无 Chrome/无头浏览器环境，无法运行；与阶段 5 相同。以上验收结论全部来自 Node 测试（服务端夹具 + 状态机 + 仿真步进），不含真实浏览器渲染验证——3D 画面层面的穿模、遮挡、帧率仍需在有浏览器的机器上补跑冒烟测试。

## 与计划的出入（阶段 6 修了两处产品 bug + 一处夹具缺口）

计划只要求“联动测试与测试报告，不加新功能；发现 bug 只修导致验收失败的最小处”。实施中遇到三处验收失败的最小修补，均已计入本提交：

1. **小猫通道与窗边停靠点重合（验收 6、8）**：原型实测小猫距窗边停靠的 agent 仅 0.130 m。原因：阶段 5 只量了小猫到资源点的距离，没量到停靠 agent 实际位置的距离（停靠点有 +0.98 m 的未缩放偏移）。修补 `src/scene/officeCat.ts`：猫道 z 由 1.6×scale 改为 2.6×scale，并导出 `catLaneZ(layout)` 作为唯一事实来源；默认布局下猫与 agent 的几何最小间距 0.87 m，紧凑布局 0.76 m（均 ≥0.7 m）。
2. **多人回工位时主通道迎面死锁（验收 3、6）**：原型实测三人同时回工位时在主通道上永久冻结（下一步均距下一人 0.70–0.71 m，小于 0.72 碰撞半径，撤销后重试同一位置）。修补 `src/scene/officeSimulation.ts`：靠右让行侧步（`giveWayStep`，向右 0.8 m，不行则向左），带三重护栏——仅在距当前路线段 0.45 m 内、回靠路线段的侧步恒可、永不落在猫道 0.7 m 带内。同一场景修复后 482 步全部回到 working。让行步不改变 stage/cursor，不打断行走动画节拍。
3. **夹具缺口（测试支撑，非产品）**：原 fake CLI 只发 `agent_message` 进度，`server/task-output.mjs`（禁改）有意不把该类记录算作 coding，导致任何夹具任务都到不了 WORKING；另 `[fail]` 在启动后约 50 ms 即失败，来不及观察 agent 坐下。`scripts/test-server-fixture.mjs` 新增 `[coding]` 标记（发一条与真实 CLI 同形的 provider 原生 coding 记录）与 `[slow-fail]` 标记（先发两次进度，约 900 ms 后再失败）。旧标记行为不变；旧测试（`test-task-handoff.mjs` 11/11）不受影响。

另两处测试侧修正（非产品改动）：lint 清掉 4 个未用变量；测试 (h) round 3 的失败任务改用 `[slow-fail] [coding]` 组合标记——只用 `[slow-fail]` 时 phase 停在 thinking，agent 按设计去窗边规划，永远到不了 working。

## 已知风险（PR 描述可用）

- **BLOCKED 以手动标记为主**：`/blocked`、`/unblock` 是手动端点；真实 provider 的授权等待（如审批关键词）是否自动进入 BLOCKED，取决于 `server/task-output.mjs` 的审批检测，联动测试只覆盖手动标记路径。
- **COLLABORATING 仅由 Handoff 事件触发**：`isCollaborating` 要求真实的 `Handoff from …` / `Handed off to …` 事件且任务仍在运行/刚完成；没有 Handoff 事件的并行任务不会进入 COLLABORATING，白板路线只在 60 秒交接窗口内触发。
- **auto 性能模式是固定设备映射，非帧率自适应**：`resolvePerformanceMode('auto')` 只按 DPR 与 CPU 核数定 quality/balanced，不采样实际帧率；运行中帧率下滑不会自动降档。实测：同一 30 人布局下 quality 远处走 OfficeCrowdLOD 的 agent 为 0 人，balanced 为 6 人（cutoff 50 vs 24）。
- **长跑 sit/stand 计数覆盖有限**：测试 (h) 的 30 分钟长跑中，pixel 的前置任务在无仿真步进的轮询等待期完成、nova 的任务在白板交接中完成，两人全程 0 次坐下；坐下/起立路径由测试 a/b/c/f4 覆盖，长跑只验证了 atlas 与 sentinel 的坐下（各 1 次）。
- **猫道间距按几何下限验证**：猫与 agent ≥0.7 m 的断言在默认布局上逐采样步通过；紧凑布局的 0.76 m 是几何下限（猫道 2.6×scale − 窗边停靠 1.73 m），未在紧凑布局上逐采样步跑满全程。
- **无浏览器验证**：见“未跑的测试”。3D 渲染层面的穿模、遮挡与帧率结论不在本报告覆盖内。
