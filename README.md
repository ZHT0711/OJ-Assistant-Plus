<div align="center">

# 📖 OJ Assistant Plus

**在 VS Code 里刷遍所有 OJ —— 看题、写题、测样例、交题，全程不离开编辑器。**

[![Version](https://badgen.net/vs-marketplace/v/ZHT0711.oj-assistant-plus)](https://marketplace.visualstudio.com/items?itemName=SparkleL.oj-assistant)
[![License](https://badgen.net/github/license/ZHT0711/OJ-Assistant-Plus)](LICENSE)
[![Platforms](https://badgen.net/badge/platforms/洛谷%20%7C%20力扣%20%7C%20NEU%20OJ%20%7C%20CSECG%20%7C%20Codeforces/blue)](#支持的平台)

*基于 [lss233/OJ-Assistant](https://github.com/lss233/OJ-Assistant) 重构与大幅拓展*

</div>

---

## ✨ 特性一览

| 功能 | 说明 |
|---|---|
| 🗂 **题库面板** | 活动栏一键打开，自动加载题目列表；CSECG 按**作业分组**，组名自带截止倒计时与 **补交中** 徽章 |
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
| `hnuacm` | HNU ACM/ICPC OJ | Edge/Chrome Cookie or password | Problems, statements, submit, status |
| `hnucg` | HNU CourseGrading | Edge/Chrome Cookie (image captcha in browser) | Assignments, statements, submit, status |
| `hdoj` | [杭电 OJ (HDOJ)](http://acm.hdu.edu.cn) | 浏览器 Cookie / 账号密码（登录无验证码） | ✅ 列表/搜索/读题实测 |
| `hnuacm` / `hnucg` | 湖南大学 ACM / CourseGrading | 浏览器 Cookie | 来自社区 PR #1 |
| `codeforces` | Codeforces | 账号密码 | 原版保留 |
| `fjutacm` | FJUT ACM | 账号密码 | 原版保留 |

## 🚀 快速开始

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
Cookie 自动写入配置并生效（浏览器配置持久化，之后一键刷新）。

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

点击题目 → 自动生成代码文件并打开题面 → `Copy` 样例到 `.in` → 右键 **Run Code** 本地验证 → **Submit** 提交。

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

## 📦 发布到 VS Code Marketplace

1. 在 [marketplace 管理后台](https://marketplace.visualstudio.com/manage) 用微软账号注册发布者 ID `ZHT0711`（一次性）
2. 本地生成 PAT（`Marketplace: Publish` 权限）并安装 vsce：
   ```bash
   npm i -g @vscode/vsce
   ```
3. 打包并发布：
   ```bash
   yarn run package
   vsce package --no-dependencies          # 产出 oj-assistant-plus-<版本>.vsix
   vsce publish                            # 首次会要求登录发布者账号 / 或用 --pat <token>
   ```

## 🙏 致谢

- [lss233/OJ-Assistant](https://github.com/lss233/OJ-Assistant) —— 原版作者与架构

## 📄 License

[MIT](LICENSE)
