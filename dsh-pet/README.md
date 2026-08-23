# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=%E6%9C%88%E4%B8%8B%E8%BD%BD&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=%E6%80%BB%E4%B8%8B%E8%BD%BD&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="pi" src="https://img.shields.io/badge/platform-pi%20coding%20agent-6C5CE7">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

> 🙏 **感谢原项目**
> 本项目 fork 自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，感谢原作者提供的精美手绘风透明动画素材（91 个 WebM）和完善的动画引擎架构。pi 插件部分在此基础之上增加了 Electron 全屏透明浮窗、pi 事件响应（思考/写代码/空闲状态映射到对应动画）、跨 session 持久化等能力，使宠物不仅能在 DSH Web 里跑，也能在 pi 终端编程助手中陪伴你。

> A floating desktop pet for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI **and** the [pi coding agent](https://github.com/pi).
> 一只住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 界面和 [pi 编程助手](https://github.com/pi) 里的桌面宠物：待机呼吸、随机动作、屏幕漫游、pi 事件响应。

---

## 📦 安装

| 平台                 | 安装方式                                          |
| -------------------- | ------------------------------------------------- |
| **DeepSeek Harness** | `dsh plugin --profile web add dsh-pet`            |
| **pi coding agent**  | `npm install -g dsh-pet`，然后在 pi 中运行 `/pet` |

> 💡 想自己造一只专属宠物？克隆 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 仓库，用内置素材链从零生成，全流程可复现。

## 🚀 pi 平台快速开始

```sh
npm install -g dsh-pet
```

在 pi 中运行：

```
/pet      →  打开宠物窗口（Electron 全屏透明浮窗，首次需下载 Electron ≈100MB）
/pet-stop →  关闭宠物窗口
```

宠物会自动响应 pi 的工作状态：

- 🧠 **深度思考** — agent 正在思考时，宠物播放"深度思考碎碎念"动画
- 💻 **写代码** — 调用 bash/edit/write 工具时，宠物播放"写代码"动画
- 😴 **空闲** — agent 完成响应后，宠物恢复随机动画链

> 宠物在 pi 进程生命周期内持续运行，切换 session 不会关闭。

## ✨ 功能特性

- **纯粹的桌宠**：不掺业务功能，就一件事——陪你。零核心改动、零模型成本
- **双平台支持**：DSH Web UI（React 组件）+ pi 终端助手（Electron 全屏浮窗）
- **pi 事件响应**：自动感知 agent 思考/工具调用/空闲状态，切换对应动画
- **手绘风透明动画**（91 个）：待机呼吸、打瞌睡、玩魔方、哼歌、写代码、四季动作……全部无缝衔接
- **永不停止的动画链**：每段动画播完按概率选下一个（30% 待机 / 10% 转向 / 40% 动作 / 20% 移动）
- **屏幕漫游**：朝 facing 方向行走，自动检查空间、不走出屏幕
- **点击 / 拖拽**：点击有随机回应动画，可拖到任意位置
- **左右朝向**：所有动画 CSS 镜像
- **落地对齐**：动画统一脚底线
- **流畅切换**：双缓冲 video 交叉淡入
- **无障碍友好**：支持 `prefers-reduced-motion`

## ⚙️ 配置

| 配置项                 | 说明                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| 设置页「桌宠配置」     | DSH 设置 → 桌宠配置：图形化编辑**大小 / 位置 / 边距**，支持**多开**，保存**即时生效**          |
| `pets`（config.jsonc） | 默认宠物列表：`[{ "id", "size", "position": { "corner", "marginX", "marginY" } }]`；多只即多开 |

> 说明：插件安装即用，配置均为可选；设置页保存的用户覆盖写入 `$DSH_HOME/dsh-pet/main-config.json`（用户层，优先于包内默认）。

### 📄 高级自定义

用户数据统一收敛在 `$DSH_HOME/dsh-pet/`：

| 层               | 路径                                 | 作用                                                                              |
| ---------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| 默认配置（只读） | 包内 `assets/config.jsonc`           | 完整结构参考：宠物列表 / 动画池 / 播放权重                                        |
| 用户配置         | `$DSH_HOME/dsh-pet/main-config.json` | 覆盖片段：可整体覆盖 `pets` / `animations` / `animationWeights`，缺省字段回落默认 |
| 用户动画（可选） | `$DSH_HOME/dsh-pet/main-animation/`  | 放入 `.webm` 即可作为动画播放，**优先于包内素材**                                 |

- 自定义动画：把 `xxx.webm` 放进 `main-animation/`，在动画池/分类里写 `"xxx"`，**刷新页面**即可
- 格式：仅 `.webm`；**透明动画需 VP9 Alpha 编码**（普通 webm 会有黑底）

## 🗑️ 卸载

```sh
# DSH
dsh plugin --profile web remove dsh-pet

# pi
npm uninstall -g dsh-pet
```

## 🎬 效果预览

> 动画为透明背景；GIF 预览中透明部分显示为页面底色，实际播放为透明。

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲" title="待机呼吸休闲">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望" title="东张西望">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步" title="原地漂浮踏步">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠" title="原地小憩沉眠">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应 - 开心跃动" title="点击回应 - 开心跃动">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈" title="被鼠标拖拽悬空反馈">
</p>

全部动画见仓库：`dsh-pet/assets/thumb/`。

## 🔗 链接

- **npm**：[npmjs.com/package/dsh-pet](https://www.npmjs.com/package/dsh-pet)
- **GitHub**：[github.com/PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- **原项目**：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（感谢原作者！）

## 🔎 发现更多 DSH 插件

- 社区插件目录：[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
- DSH 官方仓库：[deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)

## 📄 许可

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**
