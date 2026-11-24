# OJ Assistant for Emacs

独立开源仓库已迁移至 [OJ-Assistant-Emacs](https://github.com/ZHT0711/OJ-Assistant-Emacs)。本机 Emacs 配置已切换到 `E:/OJ-Assistant-Emacs`，安装与使用说明以独立仓库为准。

Emacs 原生题库、题面侧窗、样例编辑器及评测历史。界面使用 Emacs Lisp，独立 Node.js 进程复用本仓库的平台适配、公开题面解析和七语言测试运行器。

## 安装与启动

需要 Emacs 28.1 或更新版本、Node.js 18 或更新版本，以及本仓库的 npm 依赖。在仓库根目录执行 `yarn install --frozen-lockfile` 安装依赖。编译器和解释器按使用的语言安装。

当前用户的 `~/.emacs.d/user-lisp/init-oj-assistant.el` 可以接入此目录。重启 Emacs 后运行 `M-x oj-assistant`，选择一个刷题目录。`C-c j o` 同样可以打开题库，`C-u M-x oj-assistant` 可以换目录。

其他电脑可在 Emacs 配置中加入以下内容，并修改路径。

```elisp
(add-to-list 'load-path "E:/OJ-Assistant/emacs")
(require 'oj-assistant)
(global-set-key (kbd "C-c j") oj-assistant-command-map)
(add-hook 'find-file-hook #'oj-assistant-maybe-enable)
```

## 链接刷题

1. 在题库按 `i` 粘贴题目或公开比赛链接。支持原项目的 Codeforces、洛谷、AtCoder、HDOJ 和通用 HTML 解析。按 `I` 可以导入 Competitive Companion JSON 或原项目的 `examples/practice-import.json`。
2. 按 `RET` 打开代码和右侧题面。`L` 切换语言，每种语言使用独立文件。已有代码和自定义测试会保留。
3. 代码窗口按 `C-c C-r` 编译并运行全部测试。`C-c C-t` 编辑测试 JSON，编辑后按 `C-c C-c` 保存。测试结果显示输入、预期输出、实际输出、标准错误及耗时。
4. 按 `C-c C-s` 复制当前源码并打开原站提交页。

题库按 `s` 搜索缓存，`p` 返回链接题库，`g` 刷新，`d` 从列表移除。移除后代码与测试会保留，重新导入链接可以恢复。题面使用 SHR 渲染，公式源码保留为文本，图片通过原题网页查看。

链接数据与 VS Code 版共用 `.oj-assistant/practice/`，包含 `problem.json`、`language.json` 和 `main.*`。重新导入保留已有缓存和修改后的测试。相同目录同时在两个编辑器编辑时，以最后一次保存的内容为准。

## 账号题库

1. 题库按 `n` 选择平台，按 `l` 登录。支持浏览器登录、手动 Cookie、用户名密码三种入口，实际可用方式由原平台适配器决定。
2. 浏览器登录会打开系统 Edge 或 Chrome，请在浏览器完成验证码等登录步骤。完成后服务自动获取并验证 Cookie，最多等待 5 分钟。洛谷、力扣、NEU OJ、CSECG、HNU ACM、HNU CG 和 HDOJ 提供此入口。Codeforces 与 FJUT ACM 使用用户名密码入口。
3. 按 `a` 打开账号题库，`s` 搜索，`>` 加载下一页，`RET` 做题。CSECG 显示作业分组、截止时间和补交状态。`f` 可以直接输入题号和可选的比赛或作业 ID。
4. 代码窗口按 `C-c C-s`，选择与文件类型匹配的平台语言，确认后上传并等待评测。
5. 按 `C-c j h` 查看提交历史。`RET` 查看详情，`p` 停止等待，`r` 继续查询。上传结果不确定或评测未完成时，同账号同题会阻止重复上传。需要重新上传时，先在原站确认记录，再按 `D` 解除阻止。

洛谷、NEU OJ、力扣通过原平台提交编号恢复重启后的查询。其他平台依赖当前后台进程中的查询器，重启后应在原站核对记录。停止本地等待后，线上评测仍会继续。

Windows 账号库保存在 `~/.oj-assistant-emacs/accounts.dpapi`，使用当前 Windows 用户的 DPAPI 加密，并在保存时做解密回读校验。工作区配置只保存平台和账号引用。按 `A` 可以复用已保存的账号，包括同平台的不同账号。浏览器配置位于同一用户目录下的 `browser/`。其他操作系统使用进程内账号库，服务退出后需重新登录。

Emacs 自身配置位于 `.oj-assistant/emacs.json`，提交历史位于 `.oj-assistant/emacs-history.json`。已有 `.ojassistconfig.json` 的平台与配置可读取。原 VS Code SecretStorage 凭据需在 Emacs 中重新登录一次。历史记录和源码关联按 Emacs 格式单独保存。

力扣函数题测试使用自包含驱动。运行 `C-u M-x oj-assistant-run-tests` 选择包含入口和待测逻辑的文件。Java 驱动使用 `Main` 类。

## 快捷键

| 按键 | 操作 |
| --- | --- |
| `C-c j o` | 题库 |
| `C-c j i` / `C-c j I` | 导入链接 / JSON |
| `C-c j r` | 编译并运行测试 |
| `C-c j t` | 编辑测试 |
| `C-c j s` | 在线提交，或复制代码并打开提交页 |
| `C-c j p` | 显示题面 |
| `C-c j L` | 选择语言 |
| `C-c j l` | 登录 |
| `C-c j h` | 提交历史 |
| `C-c j c` | 检查编译环境 |
| `C-c j b` | 原题网页 |

已关联的代码文件还支持 `C-c C-r`、`C-c C-t`、`C-c C-s` 和 `C-c C-o`。重新打开缓存代码文件时，会自动恢复题目关联。

## 工具链设置

```elisp
(setq oj-assistant-default-language "cpp"
      oj-assistant-time-limit 2
      oj-assistant-tools
      '((cpp . "C:/msys64/ucrt64/bin/g++.exe")
        (c . "C:/msys64/ucrt64/bin/gcc.exe")
        (python . "D:/Python/python.exe")
        (node . "C:/Program Files/nodejs/node.exe")))
```

还可配置 `javac`、`java`、`go` 和 `rust`。程序路径作为独立参数传递，路径含空格时保持原样。编译超时为 60 秒，运行输出上限为 1 MiB。比较规则为空白分词比较，交互题、自定义判题器和浮点容差题应使用原站评测。运行器使用当前用户权限执行代码。

## 验证

在仓库根目录运行以下命令。

```powershell
node --test emacs/test/bridge.test.cjs
emacs -Q --batch -L emacs -l emacs/test/oj-assistant-tests.el -f ert-run-tests-batch-and-exit
```

后端测试使用模拟平台验证账号、提交、恢复和防重逻辑，并实际运行 C++、JavaScript 及 Windows DPAPI。Emacs ERT 验证真实进程通信、中文路径、原生题库与题面、切换语言、编辑测试、实际运行和文件关联恢复。真实账号登录及在线提交需要在对应平台验证。
