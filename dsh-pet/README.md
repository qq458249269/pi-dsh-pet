# pi-dsh-pet 🐾

[English](./README.en.md)

<p align="center">
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/pi-dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/pi-dsh-pet?label=%E4%B8%8B%E8%BD%BD&color=brightgreen"></a>
  <a href="https://github.com/SOMWHY/pi-dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/SOMWHY/pi-dsh-pet?style=social"></a>
  <a href="https://github.com/SOMWHY/pi-dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/SOMWHY/pi-dsh-pet?color=orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-pi%20coding%20agent-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-91%20animations-ff69b4">
</p>

> 🙏 **感谢原项目**
> 本项目 fork 自原仓库 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，感谢原作者提供的精美手绘风透明动画素材（91 个 WebM）和完善的动画引擎架构。pi 插件部分在此基础之上增加了 Electron 全屏透明浮窗、pi 事件响应（思考/写代码/空闲状态映射到对应动画）、跨 session 持久化等能力。

---

## 快速开始

```sh
npm install -g pi-dsh-pet
```

在 pi 中运行：

```
/pet             →  正常大小（400px）
/pet small       →  小号（260px）
/pet large       →  大号（540px）
/pet-stop        →  关闭所有宠物窗口
```

> 💡 首次运行时需下载 Electron ≈100MB，后续启动秒开。

宠物会自动响应 pi 的工作状态：

- 🧠 **深度思考** — agent 正在思考时，播放"深度思考碎碎念"
- 💻 **写代码** — 调用 bash/edit/write 工具时，播放"写代码"
- 😴 **空闲** — agent 完成响应后，恢复随机动画链

> 宠物在 pi 进程生命周期内持续运行，切换 session 不会关闭。

## 功能

- **纯粹的大肥鱼**：不掺业务功能，就一件事——陪你。零核心改动、零模型成本
- **pi 事件响应**：自动感知 agent 思考/工具调用/空闲状态，切换对应动画
- **手绘风透明动画**（91 个）：待机呼吸、打瞌睡、玩魔方、哼歌、写代码、四季动作……
- **永不停止的动画链**：每段动画播完按概率选下一个
- **屏幕漫游**：朝 facing 方向行走，不走出屏幕
- **点击 / 拖拽**：点击有随机回应动画，可拖到任意位置
- **多窗口**：每次 `/pet` 打开一个独立窗口，`/pet-stop` 全部关闭
- **左右朝向**：所有动画 CSS 镜像
- **落地对齐**：动画统一脚底线
- **流畅切换**：双缓冲 video 交叉淡入

## 配置

默认配置：`assets/config.jsonc`

```jsonc
"pets": [
  { "id": "main", "size": 462, "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

| 字段 | 说明 |
|------|------|
| `size` | 宠物宽度 px（高度自动 = 宽 × 9/16） |
| `position.corner` | 屏幕角落：top-left / top-right / bottom-left / bottom-right |
| `position.marginX/Y` | 距角落的边距 px |

修改 `assets/config.jsonc` 后重新 `/pet` 生效。

### 自定义宠物大小

大小映射定义在 `dsh-pet/pi/assets/pet.js` 第 589 行：

```js
var SIZE_MAP = { small: 260, normal: 400, large: 540 };
```

- **改数字** — 修改小/中/大的 px 宽度（高度自动 = 宽 × 9/16）
- **加档位** — 添加 `tiny`、`xlarge` 等新条目，例如：
  ```js
  var SIZE_MAP = { tiny: 180, small: 260, normal: 400, large: 540, xlarge: 720 };
  ```

修改后重新 `/pet` 生效。`/pet tiny`、`/pet xlarge` 等新增命令自动可用。

## 卸载

```sh
npm uninstall -g pi-dsh-pet
```

## 效果预览

> 动画为透明背景；GIF 预览中透明部分显示为页面底色，实际播放为透明。

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应 - 开心跃动">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈">
</p>

## 链接

- **GitHub**：[github.com/SOMWHY/pi-dsh-pet](https://github.com/SOMWHY/pi-dsh-pet)

## 许可

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**