# Contributing to GrokCode

感谢参与 GrokCode 开源生态。

## 开发环境

- Node.js 18+
- 已安装 [Grok Build CLI](https://grok.x.ai)（`grok` 在 PATH 或 `%USERPROFILE%\.grok\bin\grok.exe`）
- Windows / macOS / Linux（Electron）

```bash
git clone https://github.com/<owner>/grok-code.git
cd grok-code
npm install
npm start
```

## 分支与 PR

1. Fork 本仓库  
2. 从 `main` 拉功能分支：`feat/...` / `fix/...` / `docs/...`  
3. 保持改动聚焦；不要提交 `node_modules`、`.env`、密钥  
4. 提交信息用完整句子说明「改了什么、为什么」  
5. 开 PR 描述：动机、测试方式、截图（UI 相关时）

## 代码约定

- **主进程** `electron/`：文件系统、Grok CLI headless、MCP/Skills、持久化  
- **渲染进程** `renderer/`：UI、多项目/多任务、设置  
- 后端能力优先对接 **Grok CLI**（`grok -p` / `streaming-json`），避免重复造 Agent 运行时  
- 密钥只放环境变量或本机 `~/.grok`，**永不**进仓库  

## 安全

- 不要在 issue/PR 中粘贴 PAT、API Key  
- 若密钥已泄露，立刻在 GitHub / console.x.ai 吊销  

## 社区方向

欢迎：

- Bug 修复与可访问性  
- 主题 / 多语言  
- MCP 模板与 Skills 示例（放 `examples/`）  
- 打包（electron-builder）与 CI  
- 文档与教程  

一起把桌面 Grok 编码体验做成真正的开源生态。
