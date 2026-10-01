# pi-dsh-pet —— 设计与实现

> 一句话：**app = 服务端 + 窗宿主；pi / dsh / 脚本 = 客户端。**
> 桌宠是一个独立进程（也能打成单个 exe），对外开一个 127.0.0.1 的 HTTP/WS 端口；
> 谁都能喂它状态、叫它说话、看它现在是什么状态。

---

## 1. 为什么改成独立应用

老架构里 HTTP 服务、WS 广播、Electron 窗全都长在 pi 扩展里，于是有三个老问题：

1. pi 一重启（换会话、reload、更新）宠物就没了，或者弹一扇新窗出来；
2. dsh 想用同一只宠物，只能自己再起一份服务 → **桌面上两只宠物互相打架**；
3. 状态是「全局一份」，两个会话同时干活时状态乱跳。

现在：宿主（`app/`）是唯一的状态持有者，pi 和 dsh 都只是生产者。宿主活多久由宿主自己决定，
和 pi 会话解耦；pi 扩展被关掉、被 reload，宠物照样在。

```
        ┌──────────────────────── 127.0.0.1:47653 ────────────────────────┐
        │                                                                │
 pi 扩展 ──WS /feed?source=pi ──┐                                       │
 dsh 插件 ──WS /feed?source=dsh ─┼──▶  宿主 app/                         │
 curl 脚本 ──POST /event ───────┘      ├─ bus.cjs   状态机（每来源一份）    │
        ┌──▶  Electron 窗 ─WS /ws ─────┤├─ server.cjs HTTP/WS 服务       │
        │   （右键菜单/气泡/拖拽）      ├─ window.cjs 窗进程拉起与看护    │
        └───────────────────────────────┤└─ single.cjs 单例锁 + 状态文件  │
              pi-pet CLI（运维入口）───▶ └─ wsserver.cjs 自研 RFC6455      │
```

## 2. 目录

| 路径 | 作用 |
|---|---|
| `app/protocol.cjs` | 协议常量 + v1/v1.1/v1.2 帧解析（**下行 v1 线格式一字未改**） |
| `app/bus.cjs` | 事件总线：多会话语义、状态机、气泡、单只闸门 |
| `app/server.cjs` | HTTP 路由 + 鉴权 + 静态文件；WS 升级交给 wsserver |
| `app/wsserver.cjs` | 自研 RFC6455 服务端（为了零运行时依赖） |
| `app/window.cjs` | 找 electron、拉起窗进程、看护（掉了拉回来） |
| `app/single.cjs` | 单例锁（mkdir 原子性）、token、状态文件、pid 探活 |
| `app/updater.cjs` | 检查更新 / 自动更新（git 检出 · npm 全局装 · 其它只报告） |
| `app/host.cjs` | 组装：探已有宿主 → 抢锁 → 监听 → tick 心跳 |
| `app/electron.cjs` | **打包 exe 时的入口**（宿主模式 / 窗模式二合一） |
| `app/main.cjs` | CLI：start serve status stop restart feed add say port token config doctor |
| `pi/extensions/index.ts` | pi 侧**薄客户端**（无相对 import，可被复制成单文件） |
| `dsh/pi-pet.mjs` | dsh 侧适配（cordis 风格，事件名对不上就静默） |
| `pi/assets/pet*.{js,css,html,cjs}` | 窗的渲染进程、主进程、预加载 |

## 3. 协议

### 3.1 下行 v1（**不能改**，老版本窗必须还能跑）

裸字符串，历史协议：

```
"agent_start" | "thinking" | "agent_idle" | {"type":"tool_call","tool":"bash"} | "add_pet[:size]" | "shutdown"
```

### 3.2 下行 v1.1（只加不改）

```json
{"type":"bubble","text":"「修复登录」思考中…","sticky":true,"ms":0}
```

- `sticky:true` = 常驻到下一次状态变化（忙碌态一直显示）；`ms>0` = 定时消失（手动说话用）
- 老窗遇到不认识的帧会忽略 → 天然兼容，不需要版本协商

### 3.2.1 下行 v1.2（位置记忆，仍是只加不改）

```json
{"type":"positions","map":{"pet-1":{"rx":0.62,"ry":0.44}}}
```

- 窗接上来时补发一次（与状态/气泡同一路径）；写回走 `POST /control {action:"set-position"}`
- 坐标是**比例**（0~1，相对窗口宽高）不是像素：换分辨率/换屏幕后仍落在同一个地方
- 落盘在 `home/positions.json`，键是 config.jsonc 里的宠物 id
- 老窗不认识这帧 → 直接忽略，同一宿主能带新旧两种窗

### 3.2.2 下行 v1.3（省电帧，仍是只加不改）

```json
{"type":"power","sleep":true}
```

- `sleep:true` = 把动画**冻在当前那一帧**（`video.pause()`、停漫游 rAF、不再上报命中区）；
  气泡文字照常更新。`false` = 接着放
- 窗接上来时补发一次（同上）；开关落盘在 `home/ctrl.json` 的 `powerSave`，
  换窗、重启都还保持着
- 手动切：`POST /control {action:"power-save", on:true|false}`（等价于
  `set-ctrl {powerSave}`），或右键菜单的「省电模式」
- 为什么需要它：这扇窗虽然只包住宠物，但仍是**透明置顶**的，每一帧都要 DWM 重合成它
  底下那块桌面，一直动就等于一直抢别的窗口的渲染预算（见 §9.17）
- 窗**看不见**时（最小化 / 屏保锁屏 / 挂起）主进程另走 IPC `pet:power` 喊它睡，
  不经过宿主也生效

### 3.3 上行 v1.1（生产者在 /feed 上行或 POST /event）

```jsonc
{"type":"thinking","task":"修复登录"}            // 裸字符串 "thinking" 也收
{"type":"tool_call","tool":"bash","detail":"npm test"}
{"type":"done","summary":"改完 3 个文件"}         // 回空闲 + 完成气泡
{"type":"say","text":"过来玩","ms":6000}         // 只冒泡，不动动画
"agent_idle" / "add_pet:small" / "shutdown"      // v1 裸字符串照样能用
```

### 3.4 HTTP 面

| 端点 | 鉴权 | 用途 |
|---|---|---|
| `GET /health` | 否 | 探活；必须回 `role:"pi-pet-host"` 才认（防止端口被别人占了） |
| `GET /state` | 是 | 状态文件 + ctrl + bus 统计（busySessions / feedsBySource） |
| `GET /` `GET /assets/*` | 否 | 窗页面 + webm 素材（`?token=` 由窗注入） |
| `POST /event` | 是 | 单条上行（curl / 脚本用） |
| `WS /ws` | 否 | 窗下行通道（`pet.js` 发不了自定义头，所以免鉴权） |
| `WS /feed` | 是（`?token=`） | 生产者上行通道；`?source=` 决定会话归属 |
| `POST /control` | 是 | `shutdown / restart-window / add-pet / drop-pets / say / pause / resume / power-save / hide-window / show-window / set-ctrl / set-position / check-update / do-update / state / release-lock`（**check-update / do-update 是 Promise**，见 §6.3） |

token 存在 `%APPDATA%/pi-dsh-pet/token`，**只绑 127.0.0.1**。不开 LAN。

### 3.5 端口是怎么告诉客户端的

`47653` 只是**期望值**：被占时 `listen()` 会退到随机空闲端口，真实端口只有运行期才知道。
所以除了 `state.json`，宿主每次 listen 成功还会写一个一行纯文本的 `<home>/port`（退出时删掉）：

```
%APPDATA%/pi-dsh-pet/
  port        12035          ← cat 一下就知道连哪个端口
  token       6f2a…          ← /feed 与 /control 的口令
state.json  {…}            ← 给本项目代码读（心跳、pid、角色）
positions.json {…}         ← 宠物在窗里的站位（比例坐标）
  stage.json      {x,y}      ← 窗落在哪儿（窗左上角屏幕像素，搬窗才写）
  update.json     {…}        ← 上次查/更更新到哪儿了（自动检查限频也看它）
```

- 写入走「临时文件 + rename」：Windows 的 rename 不能覆盖已存在的目标，直接写会读到半行。
- 退出时只删**自己写的那个端口**（比对内容），免得把另一个宿主的端口文件顺手删了。
- 客户端必须自己判断新鲜度：硬杀（taskkill）时文件会残留，所以读到的端口还要 `/health` 探一下
  （pi 扩展、dsh 插件、`pi-pet port` 都是这么做的）。

## 4. 状态机（`app/bus.cjs`）

### 4.1 为什么要「按来源记状态」

pi 和 dsh 可以同时喂。一律用「全局一份状态」的话，A 结束会把 B 正在写的代码擦掉。
所以：**每个来源一份会话状态**，窗显示「最近活跃的忙碌会话」。

```
resolveTarget():
  busy = 所有 state != idle 的会话
  没有 busy            → idle（外加 3s 内的完成文案）
  busy.length === 1    → 那一个
  busy.length > 1      → at 最近的那个（另一个还在忙，宠物先顾着最近动手的）
```

会话 120s 没有任何事件 → 判死（pi 被硬杀了就靠这条收拾），然后重算窗状态。

### 4.2 不重播

上游（pi 扩展）每 2s 重发一次 `thinking`。如果每次都 `switchTo()`，宠物就会原地抽搐。
**修在服务端**：`drive()` 只在「状态键真的变了」时才广播动画帧；同状态只更新气泡文案。
`pi/assets/pet.js` 里的 `overrideActive` 只是防御性二次防护，不是主防线。

状态键：`idle` / `thinking` / `coding:<组>`，其中组由工具名归类（`bash`、`read`、
`edit|write` 都算「写代码」这一组）—— 组内换工具不重播，换组才重播。

### 4.3 气泡文案

| 状态 | 气泡 |
|---|---|
| 思考 | `「任务」思考中…` / `思考中…` |
| 执行 | `执行中：npm test`（detail 截到 42 字） |
| 完成 | `完成：xxx`（sticky，30s）→ `执行完成 ✓` |
| 空闲 | `待命中…` |
| 手动 | 你输入的原文（定时消失） |

## 5. 互斥：全局只能一只

四层，从便宜到贵：

1. **状态文件探活**（`home/state.json`）—— 有记录且 pid 还活着就拒绝启动。
2. **外部状态文件**—— 顺便拦旧版 pi 扩展写在 `~/.pi/agent/state/pi-pet-global.json` 的那份。
   `PI_PET_SKIP_FOREIGN=1` 可关掉这一层（只给测试/多实例调试；自己 home 的锁照旧生效）。
3. **单例锁**（`home/host.lock/`）—— `fs.mkdirSync(dir)`，**故意不加 `{recursive:true}`**：
   加了它目录已存在时也不报错，锁就永远抢不到第二个，互斥直接失效。
   `owner.json` 记 pid/时间，**每 2s 续心跳**（`refreshLock`），否则活过 TTL 的宿主
   会被第二个 `start` 判成陈旧锁 → 开出第二扇窗。
4. **打包 exe 的单实例锁** —— `app.requestSingleInstanceLock()`，双击第二次只会把已有
   那只的窗叫出来。

`--force` 的语义不是「无视」，而是**先请退已有的宿主**：`/control shutdown` → 3s →
`taskkill` 兜底 → 清状态文件，然后再抢锁。

## 6. 窗（`pi/assets/pet.js` + `pet-electron.cjs`）

### 6.1 舞台窗：只包住宠物，**不是全屏**

- 窗 = **动画 + 四周一点余白**的小舞台（不是把动画放大）。渲染进程拿到配置后重算，经
  `pet:window-size` 报给主进程：宽 = 动画宽 + 左右各 32（跟着动画走，**不**为气泡撑宽），
  高 = 头顶留白 150 + 动画高 + 底下留白 60（贴上边时头顶取 `max(marginY, 150)`、
  贴下边时底下取 `max(marginY, 60)`，配置里的 `marginX/marginY` 只当**下限**）。
  头顶那截空白是**气泡的舞台**（气泡封顶 = `min(窗宽 − 16, 820)`）—— 见 §9.21～§9.24。
  动画尺寸可以写 `size`（宽度，高按 16:9 推）或写 `height`（高度，**宽度自适应**），
  两个值都不许小于 380 宽 / 214 高 —— 见 §9.24。
  主进程改窗**只改尺寸、左上角不动**（宠物在窗里的偏移是常量，窗不动它就不动）。
- 透明置顶、整窗**鼠标穿透**；命中框由渲染进程动态经 `pet:hit-region` + `setShape()`
  裁出来，只有**宠物那块（+ 它正在说话的气泡）**能被点/能拖，**留白必须点得穿** ——
  窗一大就是一大块「点了没反应的死区」，底下的软件就点不到了。
  ⚠️ 三条缺一不可：上报前把矩形夹进窗内（渲染 + 主进程各夹一遍）、窗一变就 force
  重裁（`pushHitRegion(true)` / `resyncShape()`）、`getContentBounds()` 新旧两种返回
  形状都认。测的时候用**真光标**点，别用合成事件。
- ⚠️ **别改回全屏**。全屏透明置顶窗是桌面宠物的头号性能杀手：
  ① 每一帧都要让 DWM 把**整块桌面**重新合成一遍（连带下面所有窗口）—— 症状就是
  「桌宠一开，浏览器/IDE 的后台窗口就不刷新了」；② 全屏意味着它跟每一扇窗都相交，
  Windows 没法把任何后台窗口判成「被遮住了」，那些窗口就一直满速画。
- 想把宠物放到屏幕别处 → **拖它 = 搬整扇窗**（`pet:window-move`）。宠物在窗里的相对
  位置不变，看起来就是跟着手走。传的是「**屏幕坐标**里从按下那下算起的位移」而不是每帧
  增量：增量的话窗被夹在屏幕边时宠物会越拖越落后于光标，松手才啪地弹回去。
  ⚠️ 位移必须用 `e.screenX/e.screenY` 算，**不能用 `clientX/clientY`** —— 后者是窗内
  坐标，而窗正跟着拖拽一起动，拿它算绝对位移每次只跟上一半（实测跟手比 0.50，见 §9.20）。
  松手时窗左上角落进 `home/stage.json`（`{x,y}`），下次启动还在那儿（显示器拔过/
  分辨率变过时旧坐标自动夹回可见范围）。删掉它就回默认右下角。
- 注意：**窗位置记忆**（`stage.json`，搬整扇窗）与 **宠物站位记忆**（`positions.json`，
  比例坐标）**是两回事**，后者走 `/control set-position`。

### 6.2 交互与省电

- 右键菜单用 Electron 原生 `Menu`（透明穿透窗上 HTML 菜单会飘/穿），所有动作都走
  `/control`：当前状态、事件来源、暂停响应、**省电模式**、说点什么、换一只、**检查更新**、
  添加一只、隐藏宠物（服务留着）、在浏览器打开、复制服务地址、打开数据文件夹、关于、退出。
  （换尺寸只在 `/control set-ctrl` 里，菜单不提供：换窗代价大过收益。）
- **省电 / 空闲别硬烧**（这扇窗虽然小，但仍是透明置顶的，每一帧都要 DWM 重合成它底下
  那块桌面，见 §9.17）：空闲 `timing.idleSleepMs`（默认 45s）就把动画冻在当前帧；窗最小化 /
  锁屏 / 挂起时主进程用 `pet:power` 喊它睡；右键菜单「省电模式」是无条件省电（落盘
  `ctrl.json`），气泡文字照常更新。核心原则：**没事的时候不产生帧**。
- 「说点什么」：菜单 → `pet:say-ask` → 渲染进程在气泡位置弹出输入框 → Enter 提交 →
`preload.say` → 主进程带 token → `/control {action:"say"}`。
- 「记住位置」（宠物在窗里的站位）：拖拽松手 → `preload.savePosition` → 主进程带 token →
  `/control {action:"set-position"}` → 落盘 `home/positions.json`（比例坐标）；
  下次窗接上来时宿主补发一帧 `{"type":"positions"}`，`pet.js` 套用（本次运行已拖过的不动）。
- 窗是**独立进程**：窗崩了宿主还在，`keepAlive` 会把它拉回来。打包版里这个"第二个进程"
  就是 exe 自己（`pi-dsh-pet.exe --pi-pet-window <port>`）。

### 6.3 检查更新 / 自动更新（`app/updater.cjs`）

桌宠有**两种能自动更的装法**，各认各的，其余装法只报告：

| 装法 | 怎么认 | 怎么更 | 自动 |
|---|---|---|---|
| git 检出（pi 扩展装法 / `git clone`） | 存在 `.git` | `git fetch` 比远端 → `git pull --ff-only` | ✅ |
| npm 全局装 | 路径在 `npm root -g` 下面 | 查 registry → `npm i -g pi-dsh-pet@latest` | ✅ |
| npm 非全局装 / 解压即用 / asar 打包版 | 都不是 | 只报当前版本 + 该去哪儿手动更 | ❌ |

三条硬规矩，每条都对应一个真实的坑：

1. **不碰脏工作区**：`git status --porcelain` 非空就拒绝自动更 —— 用户本地改了
   `pet.js` 还没提交时 pull 过去会让人丢改动，那比没更新糟糕得多。
2. **只用 `--ff-only`**：宁可报「有更新但拉不下来（本地有分叉）」也不自动 merge。merge
   冲突留在一堆 webm/代码里是最难收的一种烂摊子。
3. **不 spawnSync**：宿主就是这个 HTTP/WS 服务，同步等 git/npm 等于全机断网。所以
   `control()` **可以是 Promise**，`server.cjs` 那头 `await ctx.control(...)`；
   菜单侧超时给到分钟级（`callHost("check-update", {}, token, 240000)`）。

自动检查：宿主起来 `PI_PET_UPDATE_DELAY_MS`（默认 12s，别抢起窗的 IO）后查一次，
间隔 `PI_PET_UPDATE_GAP_MS`（默认 6h）限频（落盘 `home/update.json`），全程**只写日志
不弹窗**（启动时弹窗打断用户，而这类事天天发生）。

⚠️ **更新完宿主进程自己不会换代码**：它是 detached 的，没人负责再拉起它。所以调用方只
**换一扇窗**（渲染层 `pet.js`/`pet.css` 立刻是新的），`app/*` 的新代码要等下次
`pi-pet restart` —— 这点在对话框里也写给用户了。

## 7. 运维命令

```sh
pi-pet start            # 起宿主 + 窗（已有宿主就什么都不做）
pi-pet start --force    # 先请退旧的再起
pi-pet serve            # 只起服务，不起窗（CI / 服务器上用）
pi-pet status           # 宿主/窗/生产者一览；--json 给脚本用
pi-pet stop             # 广播 shutdown → 宿主体面退出
pi-pet restart          # 重启宿主（窗一起换）
pi-pet say 你今天摸鱼了吗  # 让它说句话
pi-pet add [size]       # 加一只（需要 maxPets>1）
pi-pet port / token     # 只打印端口 / token
pi-pet doctor           # 环境自检（electron 在哪、端口有没有被占、状态文件…）
pi-pet feed             # 从 stdin 逐行喂事件（调试神器）
pi-pet config           # 看/改 config.json
```

数据目录 `PI_PET_HOME`（Windows: `%APPDATA%/pi-dsh-pet`）：
`host.lock/owner.json`、`token`、`state.json`、`ctrl.json`、`config.json`、`positions.json`、`stage.json`、`update.json`、`log.txt`、`electron.json`。

## 8. 零依赖

`app/wsserver.cjs` 是自己写的 RFC6455 服务端（握手、掩码、分片续帧、ping/pong、1MB 上限）。
理由：`ws` 是纯运行时依赖，而这东西要 `npm i -g`、要打成单 exe、还要在别人机器上跑。
`app/` + `bin/` 全是 Node 内置 API，`npm i` 都不用跑（CI 里 electron 只在打包那一步装）。

## 9. 已知坑（都踩过了）

1. **启动锁 ≠ 单例锁**。`.boot.lock` 管「别同时起两个宿主」，`host.lock` 管「全局一只」。
   合在一起会出现「服务起来了但没人认领」的死锁。
2. **状态文件在 ≠ 活着**。写完状态文件再崩的宿主最恶心：`/health` 探不通但文件还在。
   `status`/`start` 都做**短探 + 长探**（一次 `/health` + 一次 pid 探活），拿不准就当没活着。
3. **单只闸门必须在宿主层**。只在窗侧挡 `add_pet` 的话，两个窗各自都能加第二只。
4. **别用 `npx electron`**（会闪黑框、慢）。`window.cjs` 按序找 `$PI_PET_ELECTRON` →
   缓存的 `electron.json` → 包内 `node_modules` → npx 缓存 `_npx/<hash>/…`，最后才退回 npx。
5. **PowerShell 兜底要转 long**：`[int]` 会在 pid 变大后溢出。
6. **换窗后旧桥要对账**：新窗连上了要把上一扇窗的 pid/状态从状态文件里清掉，
   否则 `keepAlive` 会以为窗还在、实际屏幕上什么都没有。
7. **状态文件先写 tmp 再 rename**：Windows 的 `rename` 不覆盖已有文件，直接写会丢。
8. **JS 里别在 `/* */` 里写路径通配**。`_npx/*/node_modules` 里的 `*/` 会提前闭合注释，
   文件能写成功但语法是坏的 —— 每次改完都 `node --check` 走一遍。
9. **REST 事件必须落在同一个会话上**。按 `remotePort` 分会话的话，每个 POST 都新建一个会话，
   上一个卡在 `thinking`，宠物会一直显示思考中。默认全部归 `src:http`。
10. **暂停要只挡状态类**。`shutdown` / `add_pet` 不能一起挡，否则右键菜单会失灵。
11. **`agent_idle` 之后要重算**。恢复响应（`resume`）时必须立刻 `drive()` 一次，
    否则要等下一个事件宠物才动。
12. **CI 报「token 没配」时先看 permissions，别先去建 PAT。** `contents: write` 缺失
    会被包装成「PAT is not set」这种完全指错方向的错（见 §10.1）。
13. **CI 的 job 之间别用「上游现推的 tag」当依赖。** tag 推失败 → 下游 checkout 失败
    → 整个发布红、release 里什么都没有。跨 job 传 commit SHA，tag 只在最后当结果用。
14. **打包后不能再查 npm 依赖。** `doctor` 曾经在成品里查 `ws`，而 exe 目录根本没有
    `node_modules`，于是永远报「✗ 依赖不可解析」。自检项必须对着「打进包里的东西」写。
15. **`gh` 在非仓库目录里会先去问 git。** `gh release create` 不给 `--repo` 时，
    它先跑 `git` 解析「当前是哪个仓库」，不在仓库里就报
    `failed to run git: fatal: not a git repository` —— 看着像 git 坏了，其实是 gh 缺参数。
    发布 job 故意不 checkout（只要 `download-artifact` 拉下来的文件），所以**每条
    `gh release` 都必须显式 `--repo "$GITHUB_REPOSITORY"`**。
16. **CI 断言不能拿别人规范化过的字符串当契约。** 断言过「产物名里必须有版本号」，
    结果挂在 electron-builder 把 `2026.09.30.0002` 规范化成 `2026.9.3-0.2` 上。
    断言只能钉在**我们自己定的契约**上（固定文件名、asar 存在且够大）。
17. **透明置顶窗 = 一直在抢它底下那块桌面的合成预算。** 每产生一帧，DWM 就得把这块地方
    重新合成一遍（连着下面的窗口一起）。待机链本来就在不停地抽动画，于是别的程序的后台
    窗口永远抢不到合成预算，症状是「桌宠一开，浏览器/IDE 就不刷新了」。
    治法有两个，**两个都要**：① 窗别开成全屏 —— 之前就是屏幕大小的透明置顶窗，等于整块
    桌面每帧重合成一次（见 §6.1）；② **不产生帧** —— 空闲 `timing.idleSleepMs`（默认 45s）
    就 `video.pause()` 冻在当前帧、停漫游 rAF、不再上报命中区；唤醒口子有 WS 事件 / 鼠标
    碰到宠物 / 右键菜单 / 输入框 / resize / 页签可见性，以及主进程的最小化 / 锁屏 /
    挂起（`pet:power`）。别再为了“手感平滑”把 sleep 关掉。
18. **别拿这扇窗的“每次改形状/样式”当小事。** `setShape()`（SetWindowRgn）、
    漫游时 60fps 的 `style.left` 都落在同一条重合成路径上，而且主进程那次还是跨进程调用。
    所以两头都掐：主进程侧 2px 量化后去重 + `SHAPE_GAP_MS`（60ms）节流（被节流的那份要
    **攒最新的**，落点不能丢），窗侧命中区 2px 量化 + 漫游写样式封顶 30fps。
    顺带：`applyShape` 里“窗不可见就跳过”必须留一条“一次都没裁过就不许跳过”的例外 ——
    跳过等于没形状（整窗点不动），而上面已经记下 `shapeKey`，同一份形状会被去重掉，
    永远补不回来。
19. **两头视频不能交叉淡化 —— 一淡化宠物就“闪”。** 换姿势原来靠 `transition: opacity .18s`
    两头一起淡（旧的下淡出、新的淡入），于是**每切一次动画**，屏幕上就有约 180ms 是
    「旧姿势 + 新姿势」同时半透明：宠物只剩一半亮度，还叠着一个鬼影。单次切换无所谓，
    但一次拖拽会连着切好几次（抓起 → 状态帧 → 落下），连起来就是用户说的「拖动会闪烁」。
    治法是**硬切，但硬切必须等新视频的首帧真的贴屏**：`loadeddata` 只说明解码器能吐数据，
    不代表这一帧已经被合成器画出来，此时直接换手会闪一帧空白。所以顺序是
    `loadeddata` → `play()` → `requestVideoFrameCallback(commit)`，外层再套一个 220ms 的
    `setTimeout(commit)` 兜底（有些路径不回调），`commit` 里用 `swapped` 闭包 + `gen`
    双保险防重复换手 / 换手过期。顺手在 `pointerdown` 时 `warmAnim()` 一下拖拽姿势
    （只写 `src` 让解码器先去后台缓冲区，不动 `is-front`/`frontIdx`），
    抓起那一下就不用等解码。
    实测（`tmp/probe` 里那套渲染进程探针，一次真实拖拽逐帧记两层 computed opacity）：
    修复前 653 帧里有 **85 帧 front 落在 0.05~0.95**（宠物半透明）、84 帧两头同时可见，
    opacity 组合是一长串 0.03/0.08/0.16/0.26/0.37…；修复后 663 帧里**半透明 0 帧、
    重影 0 帧**，透明度组合只有 `(1, 0)`。两侧的切换次数都是 6，是同一份工作量。

    记这一条是因为「先量再改」：屏幕抓图那一路（PowerShell CopyFromScreen）被三件事
    同时污染过 —— 本机代理 `127.0.0.1:7897` 劫持 localhost、控制台窗盖住拍摄区、
    底图里还带着上一只宠物。最后是靠**在渲染进程里逐帧记两层 opacity** 才拿到干净结论的。
20. **搬窗的位移必须用**屏幕**坐标算，不能用 clientX/Y —— 那样宠物只跟手一半。**
    症状：拖一下明显「不跟手」，用户的话是「拖动了 10，动画只动了 5」。
    病根：`pointermove` 的 `clientX/clientY` 是**窗内**坐标，等于
    `光标屏幕位置 - 窗原点`；而「拖宠物」这件事本身就是在**搬这扇窗**。于是每读到的
    clientX 已经把「上一帧窗走过的距离」扣掉了。再拿它算「从按下那下算起的位移」，
    实际拿到的是 `光标位移 - 窗已走的位移` —— 每次只补一半，窗越拖越落后：
    `want = base + (C - C0) - (W - W0)`，而 `W - W0` 就是上一轮补上去的那一半，
    稳态就是 `窗位移 = 光标位移 / 2`。而且位置知识一滞后（IPC 延迟）这个正反馈就发散，
    窗会一格一格哆嗦。
    实测（`tmp/probe/follow2.sh`：用 `SetCursorPos` 驱动**真光标**匀速直线拖 300px，
    主进程每 5ms 采一次窗落点，量「窗终位移 / 光标路程」）：

    | | 跟手比 | 窗全程路程 | 方向反转 |
    |---|---|---|---|
    | 修前 | **0.483** | 505px | 51 次 |
    | 修后 | **1.000** | 300px | 0 次 |

    治法：`pointerdown` 记下 `screenX/screenY`（`dragState.psx/psy`），`pointermove`
    里用 `e.screenX - psx` 算位移。屏幕坐标不随窗动，才是真正「光标走了多远」；
    而它仍然是「从按下那下算起的绝对位移」，所以屏边夹住时也不会累积误差。
    `screenX/Y` 拿不到的环境（非 Chromium 的合成事件）退回 `clientX`，别把拖拽弄死。
    ⚠️ 测量别用合成 `PointerEvent`：那种事件没有「屏幕位置 → 窗内位置」这个换算，
    派出来的 clientX 是你手填的，量的是探针自己的假设，不是浏览器的行为
    （合成事件 + 一个 IPC 延迟的窗位置，甚至会量出 6 倍过冲的假象）。真要量就量真光标。

21. **舞台窗要按「宠物 + 四边留白」算、气泡高度按头顶空间夹，而留白必须点得穿。**
    两条症状是一起来的：①「窗放不下自带气泡说话的那几张图」—— 长文案只留三行（看着像
    「话没说完」），贴上边的宠物（`corner: top-*`）气泡顶出窗被切；②「窗变大后点不到
    透明区下面的别的软件」。

    先量，别猜：91 个 `assets/thumb/*.webm` 全是 640×360、不透明像素 bbox 都在画面中间，
    **没有任何一张自带画气泡** ⇒ 「那几张图」只能是应用自己发的 HTML 气泡（`bubble` 帧）。
    老公式宽 `max(560, petW+80)`、高 `max(380, petH+260)`：留白全落在窗底，**贴上边的
    宠物头顶一像素没多出来**，气泡照样挤在 `marginY` 那 100px 里；气泡 CSS 又写死
    `max-width: min(420px,…)` + `-webkit-line-clamp: 3` ⇒ 131 字实测只能看见 90 字。

    治法（462 的宠物 + `top-right`、marginX 24 / marginY 100 ⇒ 实测窗 **622×470**）：
    - 窗 = 宠物 + 四边留白：`STAGE_PAD_X=80`、`STAGE_PAD_TOP=150`、`STAGE_PAD_BOTTOM=60`；
      配置里的 `marginX/marginY` **降级成下限**（不够就抬到留白 —— 贴上边的宠物头顶本来就
      该宽一点，那截空白本来就是给气泡的舞台）。
    - 气泡：最宽 560、最多 6 行；高度不写死，`clampBubble()` 量头顶真实空间
      （`room = 容器顶 - 18`）再写 `max-height` + `webkitLineClamp`。「说点什么」的输入态
      只封 `bubbleText`（`BUBBLE_INPUT_H=44`）—— 输入框 append 在气泡**底部**，封整个
      气泡会把它裁掉，用户没法打字。
    - 实测：长气泡 586×129（6 行）**完整落在窗内**（左内边距 28 / 右 8）；131 字从
      「看得见 90 字」变成「看得见 129 字」。
    - ⚠️ 刚 `show` 出来那下量到的是**上一段文案**留下的布局（宽度行数都还没按新文案排完），
      `dx/dy` 算在旧几何上 ⇒ 气泡右缘探出窗 38px 被切。治法：下一帧 `requestAnimationFrame`
      再夹一次。这不是动画，代价可以忽略。

    **反例：别按高度差挪窗**（本来想「贴上边的宠物让窗往上长」）。高度差里只有一部分来自
    头顶偏移（150−100=50，而高度差 90，差的 40 是从底下留白里出的），按高度差挪窗 →
    宠物在屏幕上挪走 40px、live 窗被夹到 `y=-37`、x 漂了 486。正确做法：**窗左上角不动**
    （宠物在窗里的偏移是「离窗边多少像素」这种常量，窗不动它就不动 —— 实测窗从
    `(1738,143) 542×560` 变 `(1738,143) 622×470`，右下角和宠物都在原处）。
    副作用要知道：留白把贴上边宠物的头顶从 100 抬到 150，**启动后宠物比上次低 50px**；
    `marginY` 本来就是「离窗边多少像素」不是「离屏边多少像素」，用户不会觉得被改。

    留白点得穿 —— 形状 = 宠物 + 气泡的包围盒（**不含留白**），靠三条保证撑着，缺一条就断：
    - 渲染进程上报前把矩形**夹进窗内**（`collectHitRects`：空块 `continue`，不是塞 0 宽的
      废矩形）；主进程再按 `getContentBounds()` 求交一遍。少了任一头，别处的坐标就能把
      形状撑到窗外去。
    - 窗一变必**重裁**（启动时按配置长大、DPI、拔显示器都会走这条路）：渲染进程
      `resize → clampBubbles() + pushHitRegion(true)`（`if (asleep && !force) return` 这个洞
      靠 `force` 补），主进程 `win.on("resize") → resyncShape()`（重放 `lastShape` 并清
      `shapeKey`，不然会被去重吃掉）。
    - ⚠️ `win.getContentBounds()` 的返回形状：**现代 Electron 返回对象**（`.x/.y/.width/.height`），
      老版本返回数组（`[x,y,w,h]`）。当初按数组写，于是「大小没变就早退」那条判断永远成立 ⇒
      **启动第一报被吃掉**，窗一直停在 620×560，而且日志一个字都不打。现在 `contentSize()`
      两种形状都认。
    - 实测（真光标，桌宠窗底下摆一扇会计数的普通窗，点 3 个点）：留白区 2/3 穿到下面的窗，
    宠物身上那次被形状吃掉 —— **2/3 就是对**。
    - ⚠️ 测穿透前先把气泡关掉（别发 `say`）：气泡本来就是实体 UI，形状里含着它，采样点落在
    气泡矩形里，量出来的「0/3」是假的（气泡本来就该吃点击）。

22. **气泡的宽度上限只能有一个出处：窗宽。写死在 CSS 里必然走偏。**
    症状：「左右留白不够、气泡放不下」。原来 `pet.css` 里写死 `max-width: 560px`，
    而窗是按「宠物 + 左右各 80」算的（462 + 160 = 622）—— 留白只探出 80，气泡最多探出
    49，两边都不够，长文案先被**行数**封顶吃掉（用户看到的「气泡放不下」）。

    改法（三条一起，缺一条就还是放不下）：
    - `STAGE_PAD_X` 80 → **200**（用户定的）：窗 462 + 400 = **862**。
    - 气泡封顶改成 CSS 变量 `--bubble-max-w`，由 `stageSize() → applyBubbleMaxWidth()`
      按「窗宽 - 16」写进去，`pet.css` 读 `var(--bubble-max-w, 544px)`。
      ⚠️ 别再在 CSS 里写死一个数：两份数一定会走偏（这次就是 560 vs 80 的留白不配）。
      算式也只留这一处：`stageSize()` 是「报尺寸 / 摆位置 / 气泡封顶」三处共用的纯函数。
    - `.pet-bubble` 加 `box-sizing: border-box`。⚠️ 这一条不是洁癖：`--bubble-max-w`
      说的是**外框**宽，而 `max-width` 默认按**内容盒**算，差着 24px padding + 2px
      （`.sticky` 的边框）。按内容盒算出来的气泡（856px）比窗（862px）还宽 ⇒ 左右两个
      8px 边距永远夹不住，`clampBubble` 每次把它往另一边推 10px：**实测气泡在 -12 和
      -22 之间来回甩**（多夹一次反而更糟）。

    实测（harness 跑真 `pet.js`，`tmp/probe/measure-bubble.cjs`；宠物 462 / top-right）：

      窗      气泡封顶   边距 L/R   280 字    560 字    840 字
      622×470 560(内容)  28 / 8     5 行 110px 6 行 129px（封顶）
      862×470 846(外框)   8 / 8     3 行  73px 6 行 129px（封顶）

    也就是说：窗只多宽了 240px，但同样一段文案从 5 行降到 3 行 —— 封顶行数不变，
    **能完整显示的字数从 ~250 涨到 ~380**。输入态（「说点什么…」）一起量过：气泡
    846×105、输入框 26px 全在窗内。

    ⚠️ 留白变大有副作用：**窗更容易挂到屏幕外**（拖到边上时），而气泡只按**窗**夹取、
    不知道屏幕 —— 实测窗顶挂到屏幕外 120px 时，110px 的气泡有 90px 在屏幕外看不见
    （宠物离屏顶只剩 30px）。这条和「位置记忆把宠物顶到窗顶、头顶 0 留白」一起，
    已在 §9.23（整扇窗夹在屏内 + 站位记忆夹留白）和 §9.24（左右 200 撤掉）里处理。
    ⚠️⚠️ 本条的**结论后来被推翻了**：左右留白 200 对「显示」没有任何改善 —— 动画只占
    size 宽，留白再多也不会让它变大一点，宽动画反而被顶到窗边（量过的数字见 §9.24）。
    保留上面的表是因为它量的是「封顶行数不变时能显示多少字」，那条仍然成立。

23. **位置记忆是「窗内的比例」，而窗会变 —— 不换算就会漂；站位还必须给气泡留出头顶。**
    症状：「上下高度不够 气泡无法完全显示」。量出来的根：本地 `positions.json` 里
    `ry = 0.2764627659574468`，套到 470 高的窗上 = `0.2764627… × 470 − 129.9375 = 0`
    —— 宠物**恰好贴在窗顶**，头顶 0 留白 → `clampBubble` 的 `room` 算成 24，气泡被压成
    **846×24** 的一条，字全裁没。
    - 站位记忆套回来时也要走 `stageKeepIn()`：窗内 top 至少 `topOffsetOf(cfg)`（150），
      横向左右各 32、底 `bottomPadOf(cfg)`；夹完把 `customPos.rx/ry` **回写成实际值**，
      否则漫游起点（读 customPos）会先跳一下再走。
      漫游/拖动**不**夹（`clampPos` 仍从 0 起夹）：漫游只改 left 不改 top，纵向由站位打底。
      实测（窗 1262×560）：老落点套上去宠物落在 (501,150)，纵向从贴顶变成 150，
      气泡 846×73 / 3 行 / y=67（原来 24px 高 1 行）。
    - 位置记忆多存一个**可选** `w/h`（存的时候窗多大）：窗变宽时按 `r' = r·W_old/W_new`
      换算回同一个窗内绝对位置。实测同一份老落点，老记录套到 1262 宽的窗上宠物 x=501，
      带 w=622 换算后 x=200（横向差 301px = 老的 139px 平移放大版），纵向两组都夹到 150。
      老记录没有 `w/h` 时按原比例照套，不报错（走 `rescalePos` 的 `!wo > 0` 分支）。
      协议侧只加不改：`sanitizePositions` 认 `w/h`（0 < w,h ≤ 20000 才写）。
    - 拖窗的夹取从「宠物别出屏」（允许窗挂出 `il-6`）改成「**整扇窗**在屏内」
      （`loX = w.x; hiX = w.x + w.width - cs.w`）。只要窗完整在屏内，气泡那个「按窗夹取」
      就等于「按屏夹取」，气泡必然完整可见。代价是拖到边上时宠物离屏边 = 它在窗里贴的
      那条边（左右 32、顶 150）。窗尺寸按拖拽开始时缓存一次（`windowDrag`），别每帧
      `getContentBounds()`。

24. **左右留白救不了「显示不全」——该给的是高度，宽度要跟着动画走。**
    用户口径：「移除 padding 和强制尺寸设置吧，对显示没有任何改善，现在比较宽的动画还是
    显示不全，我觉得应该设置高度，自适应宽度」。先把「显示不全」量实：

      size   窗（§9.23 前）  容器在窗内      动画右边离窗边   左边空着
      462    862×470        l=376          24px            376px
      900    1300×716       l=376          24px            376px

    动画**只占 size 宽**，左右留白再多也不会让它变大一点；而贴右上角摆位时
    `left = 窗宽 − size − marginX`，留白越厚动画越往窗中间挤、窗右缘余量越小 ——
    看着就是「被窗边切了一角」。所以撤掉：
    - `STAGE_PAD_X` 200 → **32**（只当「离窗边的余量」）；
    - 强制窗宽 `max(MIN_STAGE_W, 动画宽 + 400)` → **窗宽 = 动画宽 + 2×余量**，跟着动画走；
    - 气泡封顶改成 `min(窗宽 − 16, BUBBLE_W_MAX 820)`，不再等于窗宽（宽屏上不会横跨半屏）。
    - ⚠️ 窗宽**不许**再为气泡撑（试过 `max(动画宽, 气泡基准 560) + 余量`）：窗一比
      「动画 + 余量」宽，气泡（封顶 = 窗宽−16）就比动画宽很多，居中时必被 `clampBubble`
      推到贴一边 —— 实测 592 宽的气泡居中于 462 的动画，左探 196px、右探 16px。宁可窄。
    - 新增可选配置 **`height`**（只加不改）：给了高度，宽度按 16:9 自适应（`petSizeOf`），
      下限 214 高（= 380 宽）。桌面上占多高才是显不显得下的真实口径。
    撤完实测（harness 真窗，`tmp/probe/measure-bubble.cjs` + `--size=`）：

      size   窗          动画在窗内    窗内余(左/右)   气泡          窗内余(左/右)  封顶
      380    428×424     (24,168)     24 / 24         412×54        8 / 8         412
      462    510×470     (24,172)     24 / 24         494×54        8 / 8         494
      900    948×716     (24,192)     24 / 24         741×35       104 / 103      820

      三个尺寸都：动画四周留白对称、气泡对称居中、纵向完整（头顶 150 装得下 6 行 129px）。



规则 `YYYY.MM.DD.NNNN`（UTC 日期 + 当天第几个流水号），例：`2026.09.30.0001`。三个 job：`version`（算号 + 跑测试 + source zip + 建 tag）→ `exe`（Windows 打 portable）→ `release`（挂资产、发说明）。

### 10.1 打包链上的硬约束

1. **`permissions: contents: write` 不能省。** 缺了它，`GITHUB_TOKEN` 会被削成一个只读的
   token，发布那一步报出来的却是
   `GitHub Personal Access Token is not set, neither programmatically, nor using env "GH_TOKEN"`
   —— 一句完全指错方向的错（看着像「忘配 token」，实际是「权限被削空」）。
   顶层写一遍还不够，`release` job 里再写一遍。
2. **发布用 `gh` CLI + `GH_TOKEN`，不引第三方 action。** runner 上自带 `gh`，
   少一层「token 从哪来」的玄学，报错也直白。`GH_PAT`（若配了）优先于默认 token，
   给「组织限制了 GITHUB_TOKEN」的后门。
3. **exe job 按 commit SHA 检出，不按 tag。** tag 是上游 job 末尾现推的，
   推失败（权限/网络）就会以 `couldn't find remote ref v…` 把整个发布拖红。
   源码包和 exe 因此完全解耦；推 tag 那步 `continue-on-error`：
   推不动就在摘要里留证据，绝不连累 exe。
4. **`concurrency` 必须是全局一把锁，group 里不许出现 `${{ github.ref }}`。** 这个错
   **GitHub 一句提示都不会给**（YAML 合法、两个 run 都是绿的），但本 workflow 自己会
   push tag —— tag 事件和 main 事件是两个不同的 ref，按 ref 分组就等于**一次发布并行跑
   两个 run**：同时打两次 exe、同时 `gh release create` 同一个 tag，抢出
   `422 already_exists`，白烧一台 Windows runner。所以 `group` 写**字面量**
   （`pi-dsh-pet-release`）+ `cancel-in-progress: true`（新来的取消还在跑的；排队在这里
   等于不设防，排到队尾时它要发的东西早过时了）。
   为什么取消不会把发布搞坏：
   - 取消**只可能由成功的 tag push 引起**（tag 推失败就没有 tag 事件，也就没有新 run
     来取消谁）—— 被取消的前提，恰恰是已经有人接手了。
   - 被取消的 run 没发完没关系：tag 触发的 run 走 `ref_type == 'tag'` 分支直接认 tag
     上的版本号，不重算、不重建 tag，照常 exe → release，把发布做完。
   - 万一取消正好卡在 `gh release create` 中间（留下一个没资产的空 release），下一次跑到的
     release job 会先 `gh release view` 认出来，然后 `upload --clobber` + `edit` ——
     那段本来就是幂等的（为「重跑同一个 run」写的），能自愈。
5. **产物名里不放版本号。** `YYYY.MM.DD.NNNN` 是四段、还带前导零，**不是合法
   semver**，electron-builder 读 package.json 时会自己规范化它，实测
   `2026.09.30.0002` → `${version}` 变成 `2026.9.3-0.2`。
   后果有两个：名字难看且不稳定（规范化规则随版本变），以及**不能拿版本号做 CI 断言**
   —— 那是拿别人的内部实现当契约，改个 electron-builder 版本就假失败。
   产物固定叫 `pi-dsh-pet.exe`（portable，**只此一个**）。
   曾经还出过一个 `pi-dsh-pet-setup.exe`（NSIS），已经取消：同项目两个 exe 时
   「双击没反应」最容易被误报成程序挂了（setup 双击先弹 UAC 和安装向导），
   而免安装单文件双击即用，不给人第二种可能。
   版本信息另有地方存：tag、release 说明、asar 里的 package.json。

### 10.2 产物长什么样

`version` job 出 `*-source.zip`；`exe` job 先 `--dir` 出 `dist/win-unpacked/`
（唯一能**当场真跑一次**的产物），冒烟通过后再出 `pi-dsh-pet.exe`（免安装单文件，
唯一的发布产物）。冒烟只起服务不起窗（`--no-window`），用临时
`PI_PET_HOME`，验 `port` 文件 + `/health` 的 `role` + `/` 与 `/config.jsonc`
能从 `app.asar` 里读出来，验完 taskkill 清理；它 `continue-on-error`，
挂了写进摘要但不拦产物（别因为 runner 的图形环境卡死整次发布）。

打包后运行期的两个前提：`app/electron.cjs` 就是 Electron 主进程
（窗 = 同一个 exe 的第二个实例，`--pi-pet-window <port>`）；
`pi/assets/*` 与 `assets/thumb/*` 虽然打进 asar，但**由本机的 HTTP 服务**读给
渲染进程（`/pet.html`、`/thumb/*.webm`），不依赖 Chromium 直接读 asar 里的媒体。
`npm run build` / `npm run build:dir` 是本地等价物（`npx electron-builder`），
仓库本身仍然零运行时依赖。

asar 也会丢：「files 白名单漏了」照样能打出一个 exe，症状是**双击开窗、窗里啥也没有**。
所以「列产物」那步除了看三个固定名，还要看 `dist/win-unpacked/resources/app.asar`
在不在、大小是不是离谱（5MB 门槛：91 个 webm 素材都在里面）。
