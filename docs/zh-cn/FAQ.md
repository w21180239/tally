# 常见问题与排查

## 安装与启动

**`/tally` 提示命令不存在。** 重启 Claude Code 或运行 `/reload-plugins`，然后运行 `/plugin`，确认 `tally` 已启用。再看一下 `claude --version`：tally 需要 2.1.326 或更高版本。

**添加 marketplace 失败。** 在 shell 里运行 `claude plugin marketplace add w21180239/tally` 查看完整错误。如果代理拦了 `github.com`，克隆也会失败；可以改用本地克隆：`git clone https://github.com/w21180239/tally`，再运行 `claude plugin marketplace add ./tally`。

**Windows 上怎么装？** 先安装 Claude Code（在 PowerShell 里运行 `irm https://claude.ai/install.ps1 | iex`），然后执行和其他平台相同的两条 `claude plugin` 命令。

**怎么卸载？** `claude plugin uninstall tally@tally` 和 `claude plugin marketplace remove tally`。tally 自己的数据在 `<config>/tally/`，其中 `<config>` 是 `$CLAUDE_CONFIG_DIR` 或 `~/.claude`，删除该文件夹即可。如果用过 `syncDir`，其中的 `tally/` 文件夹也可以自行删除。

## 数字

**我打开窗口之后，数字为什么还在涨？** 第一次扫描会在后台读取最多 30 天的 transcript，窗口会显示已读了多少。在实测机器上（约 8.3 GB 历史），冷读花了 84 至 89 秒；之后每次启动只读有变化的部分。

**这是我的账单吗？** 不是。金额是 API 等价金额：同样的用量按标价会花多少。订阅的计费方式不同，所以用 tally 来看用量去了哪里，以及各会话、模型和日期之间的对比。

**数字旁边的 `*` 是什么意思？** 该值是估算。要么模型未知，按同族最新价格计；要么该会话已不在运行，context 拆分取自时间上最近的一份快照。

**为什么 tally 和别的工具数字不一样？** 各工具截取窗口的方式不同（滚动 30 天对整本地日），有的还会读取其他 agent 的日志。请按整本地日比较。[scripts/compare.md](../../scripts/compare.md) 有步骤和已知的定义性差异。

**某个模型显示为未定价。** 非 Anthropic 的模型在价格表里没有价格。它们的请求会被列出，但花费不计入总额。Help 里有清单。

**fast 模式、long-context 和缓存价格。** 价格表包含 fast 模式倍率、long-context 档，以及 5 分钟和 1 小时的缓存写入。不覆盖 Batch 和数据驻留定价，因为 transcript 里没有这两类信号。

## 提示

**某条提示不符合我的情况。** 在 Hints 标签页展开它的证据（`tab`/`enter`）。每条提示都会显示它计算所依据的数字。如果数字没错但建议不适用，请提交 issue，附上规则名和数字，并去掉隐私文本。

**`y` 键做什么？** 采纳该提示：tally 记下该规则的度量值、预期节省和日期。过了 `recheckDays` 天提醒你，并对有前后可比度量的规则显示预期与实际节省。

**能不能在窗口里隐藏标题和命令？** 把 `redactEvidence` 设为 true。命令只留程序名，标题清空，路径只留文件名。

## 多台电脑

**怎么设置同步？** 在每台电脑上把 `syncDir` 设为一个已有工具在同步的文件夹（私有 git 仓库、OneDrive、iCloud、Syncthing），并给每台电脑设不同的 `machineName`。在 History 或 Hints 上按 `t` 在本机和所有电脑之间切换。

**哪些内容会离开我的电脑？** 默认的 `shareDetail` 为 `numbers` 时：按小时、按模型的汇总（token 数和金额），仓库只以不可逆的别名出现。`repos` 增加仓库名；`full` 增加会话标题和提示证据。公司电脑请保持 `numbers`。

**桌面应用里 git 同步没反应。** `$.process` 只在 CLI 可用，所以其他环境会跳过 git 这一步，下一次 CLI 会话再推送。

**两台电脑同一天的总额不一样。** 天按 UTC 存储、按本地时区显示，而且每台电脑只贡献自己保存的 transcript。如果某台电脑在会话结束后还没同步，它在下一次推送之前会落后。

## 性能

**它会拖慢 Claude Code 吗？** 扫描按约 50 ms CPU 的时间片执行，片间让出。在实测机器上，冷读 84 至 89 秒，暖启动约 9 秒，增量更新 5 秒以内。扫描期间的打字延迟还没有人工实测过；如果你感觉到卡顿，请提交 issue 并附上 `/tally debug` 的输出。

**占多少磁盘？** 在实测机器上约为 transcript 体积的 1.2%（8.3 GB 对应 96.7 MB）。索引在 `<config>/tally/index/`，可以安全删除，下次启动会重建。

**开了两个 Claude Code 会话，会扫描两遍吗？** 不会。一个会话持有租约并扫描，其余读取索引。持有者退出或崩溃后，心跳过期（90 秒）即由另一个接管。

## 隐私

**tally 会把我的 transcript 发到别处吗？** 不会。它不写 transcript，只发一个请求，发往 Anthropic 定价页，最多每周一次。把 `priceUpdate` 设为 false 就一个请求也没有。

**文件在哪里？** `<config>/tally/` 存放索引、租约、进度和报告快照。设置了 `syncDir` 时，`<syncDir>/tally/` 存放每台电脑一个汇总文件和别名盐。

## 排查数据

`/tally debug` 输出扫描进度和总数；`/tally debug --json` 以 JSON 输出，包含按模型和按天的总数。提交 bug 报告时请附上输出（去掉隐私文本）。

如果索引看起来损坏了，删除 `<config>/tally/index/` 并开一个新会话，tally 会根据你的 transcript 重建。
