# Drama Studio

双人剧本试听应用。队友负责 `web/` 界面；本机推理负责 `server/`。界面尚未实现，当前交付是可以联调的服务和共享客户端。

## 队友：不用模型即可开发

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt
python -m uvicorn server.app:app --port 8765
```

默认 mock 模式，每次返回 `samples/dialogue.wav`，不会根据输入生成新语音。样例是已试听通过的模型自选音色，不包含真人参考录音。剧本见 `samples/scene.json`。

前端直接复用 `web/api.js`：

```js
import { generateScene, audioBytes } from './api.js';
for await (const event of generateScene('http://127.0.0.1:8765', lines, signal)) {
  if (event.type === 'audio') {
    const wav = audioBytes(event);
    // 用 AudioContext.decodeAudioData(wav.buffer) 解码，并按接收顺序调度播放。
  }
}
```

用户点击生成时创建/恢复 AudioContext。每段都是独立 WAV，不能把带头部的文件直接拼接为单个 WAV；下载功能应合并解码后的 PCM，再写一个 WAV 头。音频块不对应台词边界，不应据此高亮当前角色或推断说话人。

先做剧本编辑、两位角色、情绪选择、生成/取消、流式播放和下载。不需要账号或数据库。mock 模式应在 UI 中标明，避免让人误以为输入已经真实生成。

## 本机真实推理

使用已跑通的环境，无须复制模型或重新下载：

```bash
cd /Users/knox/Desktop/Knox/Projects/drama-studio
export DRAMA_BACKEND=mlx
export DRAMA_MODEL_PATH=/Users/knox/Desktop/Knox/Projects/sglang-omni-workspace/experiments/drama3-mlx/models/drama3-3bit
/Users/knox/Desktop/Knox/Projects/sglang-omni-workspace/experiments/drama3-mlx/.venv/bin/python -m uvicorn server.app:app --port 8765
```

模型只在服务启动时加载一次；加载、生成与清理在同一个专用线程上执行，单进程一次处理一个生成请求。不要加多个 uvicorn workers 或在实际推理时开启 reload，以免重复加载模型。

mock 与 mlx 使用同一个 HTTP 路由、请求模型和 WAV 编码。切换后端不改变前端调用代码。默认只绑定本机，允许的页面来源是 localhost/127.0.0.1:3000；其他开发端口使用 `DRAMA_ALLOWED_ORIGINS`（逗号分隔）。远程访问、认证和 Vercel 连本机尚未配置，不应直接将当前服务公开到互联网。

## 接口 v1

`GET /health` 返回 `ready`、`backend`（mock/mlx）、`busy`。启动未完成时服务不会接收请求。

`POST /v1/scene/audio`，Content-Type 为 application/json：

```json
{"lines":[{"speaker":0,"text":"你准备好了吗？","emotion":"neutral"},{"speaker":1,"text":"当然，开始吧。","emotion":"laughs"}]}
```

- 1–12 条台词，每条 text 1–300 字符。speaker 仅 0 或 1。
- emotion 取 neutral/laughs/whispers/sighs，默认 neutral。这些是传给模型的提示，不是效果保证。
- 不在 text 中写 `<|speaker:...|>`，由服务统一转换。角色编号不是固定音色；当前没有声音克隆，跨请求不保证同一个人的声音。
- 请求结构的权威来源：`server/app.py` 中的 Scene/Line，运行后 `/openapi.json` 和 `/docs` 可查看。

成功响应为 `application/x-ndjson`：每行一个 JSON，HTTP 数据块可能截断某一行。`web/api.js` 已处理这种情况。

1. `start`：version=1、backend、sample_rate=44100、channels=1、format=wav-pcm16。
2. 多条 `audio`：从 0 连续递增的 index、audio_base64（完整的单声道 16-bit little-endian PCM WAV）、duration_seconds。
3. `done`：chunks、duration_seconds、truncated。truncated 表示某个文本分段达到生成上限，需要提示用户输出可能不完整。

开始前错误：非法输入 HTTP 422，忙碌 HTTP 409。开始输出后错误：发送 type=error/message，且不发送 done。缺少 done 的断流不能当成功；共享客户端会抛异常。使用 AbortController 取消，服务会在当前推理步骤结束后释放生成器；下一次请求在清理完成前可能收到 409。

## 验证与分工

```bash
node scripts/check-api.mjs http://127.0.0.1:8765
```

检查脚本使用前端真实调用模块，验证音频顺序、WAV 格式、结束事件、总时长和非法输入拒绝。对 mock 与 mlx 使用同一条命令。不要让前端另写一套 mock 协议。

队友可在 `web/` 选择 React/Next.js 等界面框架，保留共享客户端。后端仅在确有需求时修改协议，修改后同时验证两种模式。模型和虚拟环境不进仓库。

模型实现来源：Daniel Sticker 等贡献的 [mlx-audio #1018](https://github.com/Blaizzy/mlx-audio/pull/1018)，本机固定版本 dad2087f790dfe96b07d5aac1405db4b578b411f。应用自有代码与模型实现分开；当前未将 mlx-audio 或模型权重复制进本仓库。

2026-10-14 已实测：同一 Node 前端客户端通过 mock（85 段、27.07 秒）和真实 MLX（9 段、2.51 秒）；非法请求均为 422。另验证 mock 并发请求返回 409，取消后 busy 恢复 false。取消会产生 AbortError，界面应将其作为用户取消处理。
