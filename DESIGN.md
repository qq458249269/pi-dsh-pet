# pi-dsh-pet — 设计与实现

> 状态：已实现并运行。本文档描述当前实际实现；与代码有出入时以代码为准。
> 仓库：https://github.com/SOMWHY/pi-dsh-pet

---

## 1. 项目定位

在 **pi 终端编程助手**中显示一只**常驻动画宠物**：待机呼吸、随机动作（含打瞌睡）、偶尔转向、屏幕漫游、点击反应、可拖拽。

- **pi 平台**：作为 Electron 全屏透明浮窗（独立窗口），支持多窗口多开，响应 pi agent 工作状态（思考/写代码/空闲）
- **素材来源**：fork 自原 dsh-pet 仓库的 91 个手绘风格 WebM 透明动画

**本仓库内容**：
1. **pi 扩展**（`pi/`）—— 启动 HTTP+WS 服务 + Electron 全屏透明浮窗 + agent 事件映射
2. **动画素材**（`assets/thumb/`）—— 91 个透明 WebM，来自原仓库素材链

如需自定义宠物动画，参考原仓库 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的素材链（`scripts/` + `prompts/`）。

## 2. pi 平台集成

### 2.1 架构

```
用户命令 /pet
   → pi extension (pi/extensions/index.ts)
       ├── 启动/复用 HTTP 服务器（端口 4000 + 随机）
       ├── 加载 pet.html + pet.js + pet.css 到 Electron 窗口
       └── WebSocket 广播 pi agent 事件 → 宠物动画响应
```

- **HTTP Server**：Express/WS 服务，端口自动分配
- **Electron 浮窗**：独立全屏透明窗口，默认点击穿透，hitbox 内可拖拽
- **WebSocket 双向通信**：服务器 ↔ Electron 窗口，统一状态广播

### 2.2 生命周期

| 命令 | 行为 |
|------|------|
| `/pet` | 启动服务器（若未运行）+ 启动 Electron 窗口（可多开） |
| `/pet-stop` | 关闭所有 Electron 窗口 |

### 2.3 pi 事件映射

| pi agent 状态 | 宠物动画 |
|---------------|----------|
| 开始思考 (agent_start) | 深度思考碎碎念 |
| 思考中 (thinking) | 深度思考碎碎念 |
| 调用 bash/edit/write | 写代码 |
| 调用 grep/find | 搜寻中 |
| 空闲 (agent_idle) | 恢复随机动画链 |

### 2.4 多窗口支持

- 每次 `/pet` 可打开一个新的 Electron 独立窗口
- 所有窗口共享同一个 WebSocket 服务器，状态同步
- `/pet-stop` 一次性关闭所有窗口

## 3. 安装与使用

```bash
npm install -g pi-dsh-pet
```

在 pi 中运行：
```
/pet      →  打开宠物窗口（首次需下载 Electron ≈100MB）
/pet-stop →  关闭宠物窗口
```

## 4. 配置

默认配置：`assets/config.jsonc`

```jsonc
{
  "pets": [
    { "id": "main", "size": 462, "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
  ],
  "animations": { /* 91 个动画的名称与分类 */ },
  "animationWeights": { /* 各类型动画的概率权重 */ }
}
```

| 字段 | 说明 |
|------|------|
| `size` | 宠物宽度（px），高度自动 = 宽 × 9/16 |
| `position.corner` | 屏幕角落：top-left / top-right / bottom-left / bottom-right |
| `position.marginX/Y` | 距角落的边距（px） |

## 5. 测试

```bash
cd dsh-pet
npm install
# 启动 HTTP 服务器 + WebSocket，浏览器打开 http://localhost:4000 即可交互测试
node -e "
const { createServer } = require('http');
// 或直接启动 pi 进入 /pet
"
```

## 6. 许可

- 代码：MIT
- 素材（动画）：原仓库许可 — 允许开源使用，禁止商用