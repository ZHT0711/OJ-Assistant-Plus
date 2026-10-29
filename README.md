<div align="center">

# 📖 OJ Assistant Plus

**在 VS Code 里刷遍所有 OJ —— 看题、写题、测样例、交题，全程不离开编辑器。**

[![Version](https://badgen.net/vs-marketplace/v/skowosy.oj-assistant-plus)](https://marketplace.visualstudio.com/items?itemName=skowosy.oj-assistant-plus)
[![License](https://badgen.net/github/license/ZHT0711/OJ-Assistant-Plus)](LICENSE)
[![Platforms](https://badgen.net/badge/platforms/洛谷%20%7C%20力扣%20%7C%20NEU%20OJ%20%7C%20CSECG%20%7C%20Codeforces/blue)](#支持的平台)

*基于 [lss233/OJ-Assistant](https://github.com/lss233/OJ-Assistant) 重构与大幅拓展*

</div>

---

## 🎬 效果演示

![浏览题库、生成代码文件](docs/datafile.gif)

![渲染题面与样例](docs/showproblem.gif)

![一键提交并回显结果](docs/submit.gif)

## ✨ 特性一览

| 功能 | 说明 |
|---|---|
| 🗂 **题库面板** | 活动栏一键打开，自动加载题目列表；面板顶部可**先选语言**（生成对应扩展名的文件）；CSECG 按**作业分组**，带截止倒计时、**补交中** 与历史标记 |
| 📊 **完成状态** | 洛谷/力扣/NEU OJ 显示 `✓ 已AC`，CSECG 显示得分 `✓ 10.00分` 与提交日期 |
| 📝 **题面侧栏** | 打开代码文件自动渲染题面、样例（Copy / Edit 一键操作） |
| 🧮 **公式排版** | 内置 KaTeX（离线），`$...$` / `$$...$$` 数学公式完美呈现 |
| ⬆️ **一键提交** | 提交前弹出**语言选择**（记忆上次选择），结果通知附带 ⏱ 运行时间与 💾 内存 |
| 🌐 **浏览器逃生口** | 面板按钮直达题目网页，插件出 bug 也不怕 |
| 🖥️ **浏览器登录** | 一条命令拉起 Chrome/Edge，像平常一样登录，Cookie 自动保存 |
| ⚙️ **GUI 初始化** | 点选平台卡片，一键生成配置 + Run Code 环境（`.in` 喂数据） |

## 📌 支持的平台

| backend | 平台 | 登录方式 | 状态 |
|---|---|---|---|
| `luogu` | [洛谷](https://www.luogu.com.cn) | 浏览器 Cookie（Turnstile 无法自动化） | ✅ 读题/搜题/提交全链路实测 |
| `leetcode` | [力扣](https://leetcode.cn) | 账号密码 / Cookie，自动过 WAF | ✅ 读题/搜题实测 |
| `neuoj` | [东北大学 OJ](https://oj.neu.edu.cn) | 浏览器登录（验证码自动弹图） | ✅ 登录协议/提交端点实测 |
| `csecg` | NEU CSECG 作业平台 | 浏览器登录 | ✅ 全链路实测（搜题/看题/提交/状态/补交） |
| `hnuacm` | HNU ACM/ICPC OJ | 账号密码 / Edge·Chrome Cookie | ✅ 列表/搜索/题面/提交/状态（社区 PR #1） |
| `hnucg` | HNU CourseGrading | Edge·Chrome Cookie（验证码在浏览器内完成） | ✅ 作业/题面/提交/状态（社区 PR #1） |
| `hdoj` | [杭电 OJ (HDOJ)](http://acm.hdu.edu.cn) | 浏览器 Cookie / 账号密码（登录无验证码） | ✅ 列表/搜索/读题实测 |
| `codeforces` | Codeforces | 账号密码 | 原版保留 |
| `fjutacm` | FJUT ACM | 账号密码 | 原版保留 |

## 🚀 快速开始

### 0.8 新增：账号刷题流程

- **账号状态**：账号题库顶部和状态栏显示平台、用户名及登录状态；点击可重新登录、重试连接或切换工作区文件夹。多文件夹中的平台会话、浏览器配置和语言记录分别保存。
- **按文件匹配语言**：提交 `.py` 文件时匹配 Python，提交 `.cpp` 时匹配 C++；按工作区、账号和文件类型记忆选择。平台不支持的语言会明确提示。
- **提交与继续查询**：同一账号、同一题目的未结束提交会防重复上传。上传默认等待 30 秒，每次评测等待默认 120 秒，可停止等待后使用 **继续查询账号评测**。重试只查询评测，不自动重交代码。上传结果不确定时先检查原站记录。
- **样例测试**：题面和题库均有“运行全部样例”入口，无需 Code Runner。打开 **账号样例与自定义测试** 可以编辑、添加并保存测试；使用与链接模式相同的七种语言工具链。
- **函数题驱动**：力扣函数题需在测试面板选择自己编写的测试驱动，驱动应包含程序入口和调用 `Solution` 的逻辑；插件不会把函数参数样例直接当作标准输入运行。Java 驱动应自包含并使用 `Main` 入口。
- **历史与完成状态**：提交记录保存在当前文件夹 `.oj-assistant/accounts/history.json`，完成评测后更新题库状态。洛谷、NEU OJ、力扣支持用独立提交编号在重启或重新登录后恢复查询；其他平台在当前扩展会话中可继续查询，重启后按平台能力提示查看原站记录。
- **凭据存储**：浏览器登录将 Cookie 存入 VS Code SecretStorage。旧配置中的 Cookie、密码等敏感字段会在成功写入并读回验证后迁移，配置保留账号标识与 `credentialRef`。凭据存储失败时保留原文件。复制配置到新工作区或新机器后需要重新登录。

上传、评测和单次查询的等待时限可在设置中搜索 `ojassist.account` 调整。评测停止等待不会撤销线上提交。手动确认允许重新提交后才会发送新代码。本地样例与历史记录保存在 `.oj-assistant/accounts/`，不保存完整提交源码；平台诊断信息仍可能包含编译错误对应的代码片段。

### 0.7 新增：两种独立刷题模式

活动栏 **OJ Assistant** 下同时显示两个面板，可以在一个工作区中配合使用：

| 模块 | 适用场景 | 使用方式 |
|---|---|---|
| **账号题库** | 已适配平台的作业、题库、在线提交及评测结果 | 初始化 `.ojassistconfig.json` 并登录，沿用已有功能 |
| **链接刷题 · 免登录** | 跨平台练习、公开比赛及尚无账号适配的平台 | 打开一个文件夹，点面板上的链接按钮，粘贴题目或比赛 URL |

链接模式无需账号配置，也不会读取账号模式的 Cookie。借鉴 [elycode](https://github.com/YuXuaann/elycode) 的链接导入与本地测试流程，使用现有扩展的构建体系实现，未引入 Notebook 或自动下载编译器。

| 链接来源 | 题目导入 | 比赛批量导入 |
|---|---|---|
| Codeforces | `problemset/problem/1/A`、`contest/1/problem/A`、Gym | `contest/1`、公开 Gym；题面访问失败时尝试洛谷公开镜像 |
| 洛谷 | `problem/P1001` 等公开题目 | `contest/1` 等公开比赛 |
| AtCoder | `contests/abc300/tasks/abc300_a`，兼容早期日文题面 | `contests/abc300` 或其 `/tasks` 页面 |
| 杭电 HDOJ | `http://acm.hdu.edu.cn/showproblem.php?pid=1000`，自动解码 GB18030 | 暂无专用比赛解析 |
| 其他 OJ | 尝试识别常见题面与样例 HTML 结构；失败时使用手动 JSON 导入 | 可用 JSON 数组批量导入 |

私有、付费、需报名或遇到站点验证的题目可能无法匿名读取；插件会列出失败链接，并提供网页及手动导入入口。**通用解析不等于所有 OJ 都已适配**。Competitive Companion 支持导出后的 JSON 文件导入，不包含浏览器扩展监听服务。

1. 在 **链接刷题 · 免登录** 面板顶部点 **默认语言**，或打开题目后使用题面顶部 **做题语言** 下拉框，选择 C++17、C11、Python3、JavaScript、Java、Go、Rust2021。也可运行命令 **选择链接刷题语言**。选择会作为该文件夹中新题的默认语言；已有题目记忆自身上次使用的语言。
2. 点击题目打开代码和右侧题面。不同语言分别保存为 `main.cpp`、`main.c`、`main.py`、`main.js`、`main.java`、`main.go`、`main.rs`，切换不会覆盖任何已有解答。点 **运行全部测试**，自动保存代码、编译一次并逐个对比样例。可编辑输入/预期输出、添加测试；编辑时自动保存，所有语言共用这些测试。结果显示在 **OJ Assistant · 样例测试** 输出面板中。
3. 点 **复制代码并打开提交页**，在原站选择语言并粘贴提交。链接模式不会自动登录、在线判题或同步 AC 状态。

需要本机安装对应编译器/运行时。题面 **检查编译环境** 按钮会检查当前语言所需的工具，并在缺失时提示配置项。默认使用 PATH 中的工具，完整路径也可在设置中搜索 `ojassist.practice` 后配置：

| 语言 | 设置项（均以 `ojassist.practice.` 开头） |
|---|---|
| C++ / C | `cppCompiler` / `cCompiler` |
| Python / JavaScript | `pythonCommand` / `nodeCommand` |
| Java | `javaCompiler`（javac）、`javaCommand`（java） |
| Go / Rust | `goCommand` / `rustCompiler` |

Java 入口为 `Main`，编译时自动处理文件名并使用 UTF-8。工具路径无需添加引号。每题上次语言存于题目文件夹的 `language.json`，新题默认语言存于工作区设置。题面会跟随代码文件切换，快速切题复用一个面板，后台样例测试期间可以继续浏览其他题目。

默认每个测试限时 2 秒，可设置 `ojassist.practice.timeLimit`；编译限时 60 秒，单次运行输出上限 1 MiB。测试按空白分隔比较，不支持浮点容差、交互题或自定义判题器，也不限制内存。只在信任的工作区运行代码。

题面、代码和自定义测试保存在 `.oj-assistant/practice/<题目编号>/`。重新导入同一链接会复用已有数据，保留代码和自定义测试；从列表移除也保留这些文件，重新导入可恢复。缓存题面可离线打开。导入整场比赛时可取消，已成功导入的题目会保留。多文件夹工作区导入时会选择保存位置。

手动导入格式见 [`examples/practice-import.json`](examples/practice-import.json)，也可在“手动导入”命令中新建模板。

### 1. 安装

下载 `.vsix` 双击安装，或：

```bash
code --install-extension oj-assistant-<版本>.vsix
```

### 2. 初始化工作区

打开（或新建）一个刷题文件夹，`Ctrl+Shift+P` → **初始化刷题工作区** → 点选平台卡片。
自动生成 `.ojassistconfig.json` 与 `.vscode/settings.json`（Run Code 自动从同名 `.in` 文件喂输入）。

### 3. 浏览器登录

`Ctrl+Shift+P` → **Login via browser** → 在弹出的浏览器里正常登录即可，
Cookie 自动保存至 VS Code 凭据存储并生效（浏览器配置按工作区持久化，之后可重新登录刷新）。

### 4. 开刷

打开左侧 **OJ Assistant** 面板：

```
⬆️  提交当前题目
🌐  在浏览器打开当前题目
📁 第3次课后作业 〔截10-18·剩8天〕
   1  实验4-1：华氏摄氏温度转换
   9  整数求和
📁 第1次课后作业 〔补交中·截10-04·已截止〕
   1  实验1-3：计算三个数的平均值   09-22交 ✓ 10.00分
```

点击题目 → 自动生成代码文件并打开题面 → 点样例旁的 **Edit**，样例输入会直接写入同题号的 `.in` 文件并打开 → 回到代码文件，右键选 **Run Code** 本地运行，对照题面样例输出 → **Submit** 提交。运行依赖 VS Code 的 **Code Runner** 扩展和工作区的 `.vscode/settings.json`；`Copy` 只复制到剪贴板。

### hdoj（杭电 OJ）

- 页面为 GB18030 编码，适配器自动解码；登录无验证码（也可浏览器登录）
- 题库按卷浏览（74 卷 ×100 题）+ 关键词搜索（`search.php` 官方接口）
- 语言映射：`cpp→G++(1)`、`c→C(4)`、`java→Java(6)`、`cs→C#(7)`，可用 `languages` 覆盖
- 文件命名：`problems/1000.cpp`
- 提交前自动解析真实提交表单（字段名随站点变化也不怕），状态轮询 `status.php`

## 🧩 配置示例

```jsonc
// .ojassistconfig.json（洛谷）
{
  "backend": "luogu",
  "credentials": { "cookies": "_uid=...; __client_id=..." },
  "pathParseRule": {
    "normalProblem": "\/([A-Za-z]\d+)[\.\w]*\.(\w+)$"
  }
}
```

各平台完整示例见 [`examples/`](examples/) 目录；文件命名约定：

- 洛谷 `P1001.cpp` · 力扣 `problems/two-sum.cpp` · NEU OJ `problems/1001.cpp`
- CSECG `a/<作业ID>/<题号>.cpp`（直接用面板点击生成，无需手写）

## 🔧 与原版的差异

- 新增 **洛谷 / 力扣 / NEU OJ / CSECG** 四大平台后端（含完整逆向的登录与提交协议）
- 题库浏览器（分组、倒计时、补交、完成状态）与 GUI 初始化向导
- 浏览器登录自动化（puppeteer-core 驱动系统 Chrome/Edge，无内置浏览器下载）
- KaTeX 离线公式渲染、Markdown 题面管线
- 修复原版面板折叠不渲染、Copy/Edit 失效等交互问题
- 构建链现代化（webpack 5 最新版、Node 24 兼容）

### 🌐 翻译通道配置（题面面板的翻译按钮）

默认 `auto`：**Microsoft Edge 翻译（免密钥）→ 已配置的国内官方接口 → Google gtx → MyMemory**，逐级兜底。KISS Translator 的免费整句翻译使用 Microsoft Edge 接口；其 Bing 入口用于词典。在 `.ojassistconfig.json` 里按需配置：

```jsonc
"translation": {
  "provider": "auto",   // auto | microsoft (bing) | google | baidu | tencent | youdao | caiyun | mymemory

  // 国内官方接口（auto 在 Edge 失败后尝试已配置的通道）：
  // 腾讯网页 Token 通道需要在可见浏览器完成验证码，当前不参与 auto：
  // "tencentWebToken": "...",
  // 百度翻译开放平台（fanyi-api.baidu.com，免费注册）：
  // "baidu": { "appId": "...", "secretKey": "..." },
  // 有道智云（openapi.youdao.com，免费注册）：
  // "youdao": { "appKey": "...", "appSecret": "..." },
  // 彩云小译（免费 token）：
  // "caiyun": { "token": "..." },
  // 腾讯云官方 TMT 密钥（备用）：
  // "tencent": { "secretId": "...", "secretKey": "..." }
}
```

> 百度、有道、彩云和腾讯官方接口需要各自的密钥；未配置时 `auto` 会跳过。免密钥的 Microsoft Edge 通道无需验证码。

- **腾讯网页 Token（可选）**：若验证码页面无法显示，请改用默认的 Microsoft Edge 通道。手动选择 `tencent` 时仍可使用已保存的 Token 或腾讯云官方密钥。
- 有道/腾讯官方通道需要注册密钥（页面顶部链接），不配则自动跳过
- 代码块与样例永不翻译；翻译失败自动切换下一通道

## 📦 发布到 VS Code Marketplace

发布者 ID `skowosy`，扩展 ID `skowosy.oj-assistant-plus`。

1. 生成 PAT：[dev.azure.com](https://dev.azure.com) → 用户设置 → **Personal access tokens** → **New Token**
   - **Organization** 选 `All accessible organizations`（选成某个具体组织是最常见的 401/403 原因）
   - **Scopes** 选 `Custom defined` → Show all scopes → 勾 **Marketplace → Manage**
2. 安装 vsce 并登录：
   ```bash
   npm i -g @vscode/vsce
   vsce login skowosy          # 粘贴上一步的 PAT
   ```
3. 打包并发布（`vscode:prepublish` 会自动跑 webpack，无需手动 `yarn run package`）：
   ```bash
   vsce package --no-dependencies     # 产出 oj-assistant-plus-<版本>.vsix
   vsce publish --no-dependencies     # 或登录管理后台手动上传该 vsix
   ```

> ⚠️ Azure DevOps 的 global PAT 将于 **2026-12-01** 全部停用，之后需改用 Entra ID：
> `vsce publish --azure-credential`。详见
> [官方发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)。
> 若使用仓库自带的 GitHub Actions，需先新建名为 `VSCE_PAT` 的 secret。

## 🙏 致谢

- [lss233/OJ-Assistant](https://github.com/lss233/OJ-Assistant) —— 原版作者与架构
- [YuXuaann/elycode](https://github.com/YuXuaann/elycode) —— 链接刷题交互与 Codeforces 公开镜像策略参考；MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

## 📄 License

[MIT](LICENSE)
