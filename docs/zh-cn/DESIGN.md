# tally 设计

tally 是怎么搭起来的，以及为什么这样搭。README 讲它能做什么，本页讲改代码之前需要知道的部分。

## 目标与边界

- 运行在 Claude Code 的插件引擎里，不需要安装任何运行时：不要 Node、Bun、Python 或二进制。Windows、macOS、Linux 共用一份代码。
- 绝不拖住会话。扫描不会阻塞 prompt，读取很大的历史时先显示部分数字，既不等待也不报失败。
- 隐私数据留在产生它的那台电脑上。唯一的网络请求是价格页。
- 范围外：其他 agent（Codex、Cursor）、团队看板或服务器、按子代理的 context 拆分、Batch 与数据驻留定价。

设计要绕开的硬限制，都来自引擎：

| 限制 | 带来的结果 |
| --- | --- |
| `fs.read` 每次最多 4 MiB，offset 按字节算 | 分块读取，并停在完整的行末 |
| `fs.write` 每个文件最多 4 MiB，非原子，没有 rename、append、delete | 索引写新的一代，再用一个小指针文件提交 |
| 事件钩子里不 await 的长循环会让 worker 崩溃 | 扫描的每一步都在约 50 ms CPU 的时间片里执行，然后 await |
| `$.process` 只在 CLI 可用 | git 同步只在 CLI 里运行 |
| `$.http.fetch` 单次最长 30 秒、4 MiB | 足够取价格页 |

## 目录结构

```text
.claude-plugin/    plugin.json、marketplace.json
hooks/             hooks.json 和 register.tsx，唯一调用 on(...) 的文件
core/              纯函数：解析、去重、聚合、定价、规则、格式化
engine/            对 `$` 的适配：扫描、索引存取、租约、价格更新、同步、live tally
view/              各标签页、折叠线、desktop 信息行、compact 与 short 布局
report/            花费报告生成
herdr/             Herdr 侧栏资源
skills/            spend-optimize
tests/             claude plugin test；fixtures 全部是合成数据
```

`core/` 拿不到 `$`，所以每条规则和公式都是可以在测试里用普通数据直接调用的函数。`engine/` 是唯一接触文件系统、时钟、store 和网络的地方。以后如果需要在引擎之外跑更重的扫描器，`core/` 可以原样搬过去。

## 扫描器

**发现。** 根目录是 `$CLAUDE_CONFIG_DIR/projects` 或 `<home>/.claude/projects`，另加 Claude 桌面应用的本地会话目录（存在才扫）。home 取 `HOME`，Windows 回退到 `USERPROFILE`。路径一律经过 `core/path`，它同时接受 `/` 和 `\`。`audit.jsonl` 会被跳过。

**顺序。** `session.start` 之后用 timer 启动扫描，让钩子先返回。工作按优先级进行：当前会话所在的项目，然后是最近 24 小时，然后是 30 天。每一步都会更新进度记录，窗口把它显示出来（“已读 42%，数字还在涨”）。没有会把首次慢读变成失败的超时。

**时间片。** slicer 记录本片开始以来用掉的 CPU 时间，用满 50 ms 就用 `$.clock.sleep(0)` 让出。它在块、行和分片写入之间检查。测试时注入一个假时钟来驱动。

**分块读取。** 每次读最多 4 MiB 文本。一个范围可能把多字节字符切成两半，所以读取器只保留完整的行：最后那行不完整的部分（包括切口处的替换字符）会被丢弃，offset 按保留下来的各行的字节长度推进。单行超过一个块时，走单独的超大行路径解析。

**增量更新。** 索引为每个文件记录 size、mtime 和已读到的字节 offset（始终停在行末）。未变化的文件跳过，变大的从 offset 续读，变小的重新整读，超出窗口的裁掉。某个项目窗口内的文件都已读完但还没有索引（所有 transcript 都超过 30 天，或者都没有可记的行）时，写一个空索引，读取方就把它算作已读，而非未读。`fs.list` 已经带 size 和 mtime，不需要逐个文件 stat。

**解析规则。**

- 请求按 request id 去重，保留 output 最大的那一行。同一个 id 出现在两个文件里时，先到的文件拥有它；但在归属上，子代理文件优先于主文件。
- synthetic 行不计价，也不算请求。
- 子代理按路径和它的 `meta.json` 识别。
- 缓存寿命按每个请求实际的 5 分钟和 1 小时写入拆分来判断，混合写入不会被误判成重写。
- 仓库取工作目录名；git worktree 归宿主仓库。

## 索引

索引先按项目拆，再按 UTC 天拆：

```text
<config>/tally/index/<project-key>/            清单和 HEAD 指针
<config>/tally/index/<project-key>/d-<date>/   一天：按时间戳的行、文件状态、meta 行
```

- 项目 key 是项目名清洗后的前缀加 16 位十六进制哈希，在 Windows 上也安全。
- 每个桶存放在 A、B 两个代号槽里，每个分片不到 3.5 MiB。保存时把新的一代写进没在用的槽，再更新很小的 `HEAD.json` 指针。读取时如果发现某个分片来自另一次保存，或缺少分片，就认为该槽无效，改用另一个槽。
- 一次保存先写有变化的天桶，最后写项目清单。清单记录了它期望的每个桶的保存计数，所以读到的恰好是同一次保存产生的各代，不会把两次保存混在一起。某个桶损坏，只会让该项目重新从 transcript 读取。
- 稳态下只重写当天的桶，在实测机器上约 1 至 2 MB。同一个项目的稳态保存至少间隔 5 分钟。
- prompt 文本只保留前 200 个字符。元数据对每个（会话，key）只保留最新值。会话 id、目录、模型和对象键在每个块的字符串表里只存一次。
- 编码和解码在块之间、分片文件之间让出。

**版本。** `INDEX_FORMAT`（当前为 2）写在清单上。只要解析器开始记录一个旧 transcript 里原本没有的字段，就要升这个版本。版本戳不同的索引会被丢弃并重新从 transcript 读取，没有迁移代码。分片格式本身另有 `v` 字段。

**Breakdown 快照。** `$.session.usage({ breakdown })` 只对正在运行的主会话可用。每个 live 会话把一份快照（skills、MCP 工具、agents 和 memory 文件，各带 token 数和 deferred 标记）按会话 id 和日期存进索引。没有快照的历史，用时间上最近的一份代替，由它算出的数字标 `*`。依赖 breakdown 的规则在只有代用数据时照常触发，证据里会注明用的是哪一天的快照。

## 租约

同一台电脑上可能开着多个 Claude Code 会话，但只应有一个在扫描。持有者把自己的会话 id 和心跳时间写进 `<config>/tally/lease.json`。

- 获取：先读文件；如果别的会话持有且心跳不到 90 秒，就保持只读。否则写入自己的 id，等 300 ms 再读回来。最后写入者胜出，发现是别的 id 的会话不去动租约。文件系统接口没有原子创建，这是它的替代办法。
- 每 30 秒一次心跳。发现文件里是别的 id，就说明租约丢了，停止写入。
- 释放时写一个空持有者，因为没有 delete。空持有者视为空闲。
- 持有者崩溃后，心跳过期即可被接管。

没有租约的会话读取索引和进度文件，显示同样的数字，不往索引里写任何东西。

## 定价

- 内置价格表覆盖当前所有 Claude 模型：input、output、cache read、5 分钟 cache write（input 的 1.25 倍）和 1 小时 cache write（input 的 2 倍）、fast 模式倍率和 long-context 档。
- 每 7 天用 `$.http.fetch` 取一次 `https://platform.claude.com/docs/en/about-claude/pricing.md`，解析其中的 markdown 表格，结果存进 `$.store`。
- 只有当取到的表保留了当前至少 80% 的模型，并且每个价格都为正且自洽（5 分钟写入价约为 input 的 1.25 倍）时，才会替换当前的表。否则保留旧表，Help 里显示错误。
- 一次失败之后，下一次尝试要等 6 小时，所以离线的电脑不会每个会话都重试。
- Help 显示价格来源、更新日期和未定价的模型。未知的 Claude 模型按同族最新价格计并标 `*`；其他厂商的模型列为未定价。
- `priceUpdate` 设为 false 时完全不发请求。

## Live 会话

每一步，tally 从 `turn.step` 统计用量，从 `$.session.usage()` 读取 context、花费和限额，并在同一个进程里跟随 `/clear`、`/resume` 和 `/branch`。消息数回落时判定发生了压缩。缓存计时用索引里最近一次缓存写入来核实，决定按 1 小时还是 5 分钟寿命。被 resume 的会话之前各次启动的花费来自索引。

## 多机同步

设置 `syncDir` 后，每次扫描结束 tally 写一个文件 `<syncDir>/tally/<machineName>.json`（不到 4 MiB），并读入其他电脑的文件。没有设置 `machineName` 时，名字第一次取自主机名，之后保存在 store 里，所以主机之后改名不会再生成第二个文件；直接设置 `machineName` 更稳妥。

- 文件里是 UTC 小时桶。`numbers` 级别下每个桶有四种 token 类型、金额、模型、主会话或子代理、子代理类型×模型以及 fast。`repos` 加上按仓库的桶。`full` 再加会话标题、Top sessions、按工具的 context 填充，以及各机的提示结果和证据。
- 仓库别名是仓库名的 HMAC，盐存在 `<syncDir>/tally/salt`。第一台电脑生成盐，所有电脑读取它，所以各机上的别名一致。
- 天按 UTC 存储，按查看者本地时区显示。
- transcript 只留在产生它的电脑上，所以不会重复计数请求。
- 如果 `syncDir` 是 git 仓库，tally 在写入前通过 `$.process.run` 执行 `git pull --rebase`，写入后执行 `git commit` 和 `git push`。失败只记日志。在桌面应用和 VS Code 里跳过这一步，下一次 CLI 会话再推送。
- 在所选级别下无法合并的区块，在“所有电脑”视图里显示“仅本机”。

## 报告与 Herdr

`tally_report` 工具接受 `days`、`repo`、`compare` 和 `saveBaseline`，返回 `spend-optimize` skill 使用的报告。`/tally report` 把同一份报告写成当前工作目录下的 `api-spend-<日期>.md`（同一天再次生成会覆盖之前的文件，报告里会列出仓库名）。工具的 `adopt` 参数记录用户选择应用的提示，与窗口里按 `y` 的效果相同。报告会把命令脱敏成程序名、清空标题、路径只保留文件名。

每次扫描结束后，tally 把 24 小时和 30 天的报告快照写到 `<config>/tally/report-<span>.json`。Herdr 侧栏只读取并绘制这些文件，同时显示它们有多旧；它不打包任何 `core/` 的内容。没有 Claude Code 会话在运行时，它显示最后一份快照。关闭 `herdrSidebar` 会删除 tally 创建的文件夹，靠一个标记文件确认是自己写的。

## 提示的采纳与复查

采纳一条提示会存下该规则的度量值、预期节省和日期。规则可以提供一个前后可比的度量，例如 cache-rebuilt 用“每活跃小时的重写成本”，fast-mode 用“fast 成本占比”。过了 `recheckDays`（默认 14）天，会弹 toast 提醒，并显示“预期省多少、实际省多少”。没有度量的规则只记录采纳，不做别的。置信度低的换模型建议只说“试用”，不会说“降级”。

## 隐私不变量

每次改动都要满足这些；破坏其中任何一条的改动，必须在同一个 pull request 里更新 README 和 SECURITY.md。

1. tally 不写任何 transcript 文件。
2. 唯一的网络请求是价格页，最多每周一次，`priceUpdate` 可以关掉。git 同步只与用户自己的远端通信。
3. 不调高 `shareDetail` 时，没有任何仓库名、会话标题、路径或命令离开本机。
4. fixtures 和示例只使用合成数据。

## 验证

- 测试用 `claude plugin test` 运行。纯函数和窗口共用一套配置，所有 transcript fixtures 都是合成的。
- 准确性：在一台电脑上对 2026-10-30 至 2026-11-28 的 30 个本地日，tally 与 ccusage 的总额相差不超过 0.010%，每个模型相差不超过 0.03%。数据、方法以及定义性差异（窗口边缘、synthetic 行、来自其他 agent 的行）见 [scripts/compare.md](../../scripts/compare.md)。
- 在那台电脑上的性能，30 天历史约 8.3 GB、82,000 个文件：冷读 84 至 89 秒，暖启动约 5 秒（机器负载很高时最多约 13 秒）且不读任何 transcript 字节，增量更新 5 秒以内，索引 96.7 MB（约为 transcript 的 1.2%）。把索引按天拆分之后，冷读完成时的索引体积从 493 MB 降到 96.7 MB。扫描期间的打字延迟还没有人工实测过。
- CI 在 macOS、Windows 和 Ubuntu 上运行 `claude plugin validate .` 和 `claude plugin test .`。
