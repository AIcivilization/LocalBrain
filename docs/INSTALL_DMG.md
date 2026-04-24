# LocalBrain DMG 安装说明

## 安装

1. 打开 DMG。
2. 把 `LocalBrain` 文件夹复制到本机可写目录，例如 `/Users/wf/LocalBrain` 或 `~/Applications/LocalBrain`。
3. 进入复制后的 `LocalBrain` 文件夹，双击 `LocalBrain.command`。

不要直接在 DMG 里运行。DMG 是只读包，LocalBrain 启动时需要写入 `logs/` 下的本地配置、Key 和运行日志。

## 使用

启动后，右上角状态栏会出现 LocalBrain 图标。

- `配置 Codex`：检查或引导配置本机 Codex ChatGPT 登录态
- `Key`：复制 `OPENAI_BASE_URL`、复制/生成/替换本地 API Key
- `其他`：打开控制台、配置文件、审计日志，或重启/停止服务

本地应用接入：

```text
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=<状态栏菜单 Key 中复制的本地 key>
```

