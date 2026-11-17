# 织点 AI 工作团队

一个用于展示多 Agent 团队协作流程的本地 Web 应用。工作台包含作战大屏、任务流水线、团队模型路由、服务商设置和人工验收队列。

> 当前仓库是可运行的本地原型：设置页和服务商连接测试可用，任务编排和 Agent 执行仍在逐步接入中。

## 功能

- 作战大屏展示 Agent 状态、协作关系、任务动态和验收队列。
- CEO、前端、后端、测试、研究、设计和运营岗位可以分别选择模型服务商并填写 model ID。
- 模型接入页可以为 OpenAI、Anthropic、DeepSeek、兼容 OpenAI 接口或本地模型配置 API 地址和 API Key。
- API Key 不写入浏览器 `localStorage`；本地 API 服务通过 Windows DPAPI 按当前用户加密保存，并只向界面返回掩码状态。
- 连接测试会向选定服务商发送一次短请求，帮助确认地址、凭据和 Model ID 是否可用。
- 任务可以在待拆解、执行中、待验收和已交付状态间演示推进。
- Agent 路由、任务和执行记录保存在当前浏览器的 `localStorage`。

## 本地运行

需要 Node.js 和 pnpm。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会同时启动 Vite 前端和本地 API 服务。访问 `http://127.0.0.1:5173`。

```bash
pnpm lint
pnpm build
```

## 模型接入

打开左侧“模型接入”，选择服务商，填写 API 地址、API Key 和用于测试的 Model ID，点击“保存配置”后再点“连接测试”。不同 Agent 的岗位路由在“Agent 团队”页单独配置；凭据按服务商共享。

当前任务流水线仍是本地演示，不会因为连接测试成功就自动执行真实 Agent。下一阶段需要增加 Session/Run 持久化、执行器适配、任务队列、工作目录权限和失败重试。

API Key 需要由用户自己在对应服务商后台创建。不要把密钥粘贴到 Git、截图、聊天或前端代码里。用户此前在聊天中公开过一枚密钥，该密钥应立即撤销并换新。

## 技术栈

React、TypeScript、Vite、Lucide。

## GitHub 发布

项目已包含 `.github/workflows/ci.yml`，每次推送和 Pull Request 会自动运行 `pnpm lint` 与 `pnpm build`。API Key、Windows 本地配置和构建产物已加入 `.gitignore`，不要强制添加这些文件。
