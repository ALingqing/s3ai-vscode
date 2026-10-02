# s3ai-vscode

<p align="center">
  <img src="media/icon.png" alt="S3AI" width="128" height="128" />
</p>

<h1 align="center">S3AI for VS Code</h1>

<p align="center">
  将 <a href="https://ai.furry.vg/sign-up?aff=JwkjwWvu">S3AI</a>（furry.vg）接入 VS Code 内建聊天
  <br/>
  <code>Language Model Provider</code> · <code>OpenAI 兼容</code> · <code>Agent / Tool Calling</code>
</p>

---

S3AI for VS Code 是一个**语言模型提供方（Language Model Provider）扩展**，把
[S3AI](https://ai.furry.vg/sign-up?aff=JwkjwWvu) 的模型直接接入 VS Code 原生 Chat / Copilot Chat，
使你在编辑器侧边栏获得与官方几乎一致的对话体验，同时通过你自己的 API Key 使用。

本扩展仅作为第三方客户端封装，与 furry.vg / S3AI 官方无隶属关系。

## 特性

- **模型自动发现** —— 启动时自动从 `/v1/models` 拉取当前账号可用的模型列表，直接在模型选择器中呈现。
- **流式输出** —— 基于 SSE（Server-Sent Events）的流式响应，逐字渲染，延迟更低。
- **推理过程** —— 对支持 reasoning 的模型（如 DeepSeek、Claude 等）展示思考过程。
- **工具调用（Agent 模式）** —— 将模型的 `tool_calls` 转换为 VS Code 原生工具调用事件，支持 Agent 工作流与多轮工具执行。
- **多模态输入** —— 支持向支持视觉的模型发送图片（自动编码为 OpenAI 兼容的 `image_url`）。
- **API Key 安全存储** —— 密钥明文永不落盘，统一保存在 VS Code 安全存储（SecretStorage）。
- **模型白名单** —— 通过 `s3ai.models` 精确控制可见模型，或留空以显示全部。
- **能力预设表** —— 为常见模型内置上下文 / 输出上限与能力标记（视觉、工具），缺失时使用通用默认值。
- **智能错误处理** —— 对 `401 / 403 / 429` 等常见 HTTP 错误给出可操作的中文提示。
- **Token 估算** —— 内置轻量 token 计数，用于上下文用量提示。
- **状态栏快捷入口** —— 一键管理：设置 / 清除 Key、刷新模型、打开设置与文档。

## 安装

### 方式一：VSIX 安装（推荐）

1. 获取 `s3ai-vscode-0.1.0.vsix` 安装包。
2. 在 VS Code 命令面板（`Ctrl+Shift+P`）中运行 **Extensions: Install from VSIX...**，选择该文件。
3. 重新加载窗口（`Developer: Reload Window`）。

### 方式二：源码运行（开发调试）

```bash
npm install
npm run compile
```

按 `F5` 打开「扩展开发主机」窗口即可（仓库已包含 `.vscode/launch.json`）。

## 快速开始

### 注册与邀请奖励

通过下方邀请链接注册 S3AI，即可加入推荐计划并获得邀请返利：

> 被邀请人前 10 笔实付金额大于 15 元的法币充值，可获得 **5% 返利**，24 小时后自动转入余额。
> 奖励仅限平台消费，不支持提现；赠送额度、兑换码、订阅、加密货币支付和人工充值不参与统计。

- **注册入口**：[https://ai.furry.vg/](https://ai.furry.vg/sign-up?aff=JwkjwWvu)

### 前置条件

需要一个 [ai.furry.vg](https://ai.furry.vg/sign-up?aff=JwkjwWvu) 的 API Key（`sk-` 开头）。若尚未配置，
扩展会在首次使用时提示引导配置。

### 配置 API Key

**通过命令**：命令面板运行 **S3AI: 设置 API Key**，粘贴 Key 即可。运行 **S3AI: 清除 API Key** 可移除。

**通过模型管理 UI**：

1. 打开 Chat，点击模型选择器 → **Manage Language Models（管理语言模型）**。
2. **Add Models** → 选择 **S3AI**。
3. 按提示填写 `API Key`（可选修改 `Base URL`）。
4. 勾选需要显示的模型。

配置完成后，在模型选择器中选择 S3AI 的模型即可使用。

> **说明**：通过命令方式保存的 Key 同样可被模型管理 UI 识别，两种方式共用同一套凭据解析逻辑。

## 配置项

| 设置 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `s3ai.models` | `array<string>` | `[]` | 模型 ID 白名单。留空时显示账号可用的全部模型。 |

示例：仅显示指定模型

```jsonc
{
  "s3ai.models": ["deepseek-v4-flash", "claude-sonnet-4-6"]
}
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `S3AI: 管理 S3AI（模型与 Key）` | 打开快捷菜单（亦可通过状态栏 S3AI 触发） |
| `S3AI: 设置 API Key` | 将 Key 保存至安全存储 |
| `S3AI: 清除 API Key` | 删除已保存的 Key |
| `S3AI: 刷新模型列表` | 清除本地缓存并重新拉取模型 |
| `S3AI: 打开 S3AI 文档` | 在浏览器打开官方文档 |

## 架构与工作原理

扩展通过 `vscode.lm.registerLanguageModelChatProvider('s3ai', ...)` 注册为语言模型提供方，
将 VS Code 的聊天请求转换为 OpenAI 兼容请求（默认 `https://ai.furry.vg/v1/chat/completions`，SSE 流式），
并把 `tool_calls` 还原为 VS Code 原生工具调用事件，从而与 Chat / Copilot Chat 的 Agent 能力无缝协作。

```
VS Code Chat
   │
   ▼
registerLanguageModelChatProvider('s3ai')
   │
   ├── provideLanguageModelChatInformation ──► GET /v1/models   （模型列表，含缓存）
   │
   └── provideLanguageModelChatResponse ────► POST /v1/chat/completions （SSE 流式）
                                                 ├── text ──────────► LanguageModelTextPart
                                                 ├── reasoning_content ► LanguageModelThinkingPart
                                                 └── tool_calls ─────► LanguageModelToolCallPart
```

### 模块划分

| 模块 | 职责 |
| --- | --- |
| `src/extension.ts` | 扩展入口：注册提供方、命令与生命周期 |
| `src/provider.ts` | 语言模型提供方实现：配置解析、模型缓存、消息转换、错误映射 |
| `src/client.ts` | API 客户端：模型列表拉取、SSE 流式对话、工具调用聚合 |

## 要求

- **VS Code** `1.104.0` 及以上（语言模型提供方 API 稳定版）。
- 一个有效的 S3AI API Key。

## 常见问题

### 模型列表中看不到任何模型？

请确认已配置正确的 API Key，并执行 **S3AI: 刷新模型列表** 清除缓存。若仍为空，
检查 `s3ai.models` 白名单是否误填（白名单模式下仅显示匹配项），或账号是否拥有可用的模型额度。

### 出现 401 / 403 / 429 错误？

扩展会对这些状态给出明确提示：`401` 表示 Key 无效或未授权，`403` 为服务端拒绝，`429` 为频率或额度限制。
请核对 Key 与 Base URL，或联系服务提供方确认额度。

## 开发

```bash
npm install         # 安装依赖
npm run watch       # 监听编译（开发）
npm run compile     # 一次性编译
npm run package     # 打包 .vsix（需 npx @vscode/vsce）
```

## 版权与免责声明

本扩展为第三方客户端封装，与 furry.vg / S3AI 官方无隶属关系。商标与产品名称归其各自所有者所有。

## 相关链接

- S3AI 文档：<https://docs.furry.vg/>
- 模型广场：<https://ai.furry.vg/pricing>
- 主站：[https://ai.furry.vg/](https://ai.furry.vg/sign-up?aff=JwkjwWvu)


