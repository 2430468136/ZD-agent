# Contributing to 织点

感谢参与。提交代码前请先在本地运行：

```bash
pnpm install
pnpm lint
pnpm build
```

## 安全要求

- 不要提交 API Key、访问令牌、证书或本地 `providers.json`。
- 不要在 issue、截图或日志中粘贴完整密钥。
- 连接模型服务时优先使用本地 API 服务，避免在浏览器代码中暴露密钥。

## 提交说明

请在 PR 中说明变更的页面、交互或本地 API，并附上验证命令和结果。当前项目的任务执行仍是演示模式，真实执行器接入需要单独说明权限边界和失败处理。
