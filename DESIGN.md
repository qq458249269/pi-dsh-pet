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
| `app/protocol.cjs` | 协议常量 + v1/v1.1 帧解析（**下行 v1 线格式一字未改**） |
| `app/bus.cjs` | 事件总线：多会话语义、状态机、气泡、单只闸门 |
| `app/server.cjs` | HTTP 路由 + 鉴权 + 静态文件；WS 升级交给 wsserver |
| `app/wsserver.cjs` | 自研 RFC6455 服务端（为了零运行时依赖） |
| `app/window.cjs` | 找 electron、拉起窗进程、看护（掉了拉回来） |
| `app/single.cjs` | 单例锁（mkdir 原子性）、token、状态文件、pid 探活 |
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
| `POST /control` | 是 | `shutdown / restart-window / add-pet / drop-pets / say / pause / resume / hide-window / show-window / set-ctrl / state / release-lock` |

token 存在 `%APPDATA%/pi-dsh-pet/token`，**只绑 127.0.0.1**。不开 LAN。

### 3.5 端口是怎么告诉客户端的

`47653` 只是**期望值**：被占时 `listen()` 会退到随机空闲端口，真实端口只有运行期才知道。
所以除了 `state.json`，宿主每次 listen 成功还会写一个一行纯文本的 `<home>/port`（退出时删掉）：

```
%APPDATA%/pi-dsh-pet/
  port        12035          ← cat 一下就知道连哪个端口
  token       6f2a…          ← /feed 与 /control 的口令
  state.json  {…}            ← 给本项目代码读（心跳、pid、角色）
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

- 全屏透明置顶窗，默认整窗**鼠标穿透**；渲染进程在宠物命中框内 hover 时通过
  `preload.setPassthrough(false)` 临时关掉穿透，于是能点、能拖。
- 右键菜单用 Electron 原生 `Menu`（透明穿透窗上 HTML 菜单会飘/穿），所有动作都走
  `/control`：当前状态、事件来源、暂停响应、说点什么、换一只、尺寸、添加一只、
  隐藏宠物（服务留着）、在浏览器打开、复制服务地址、打开数据文件夹、关于、退出。
- 「说点什么」：菜单 → `pet:say-ask` → 渲染进程在气泡位置弹出输入框 → Enter 提交 →
  `preload.say` → 主进程带 token → `/control {action:"say"}`。
- 窗是**独立进程**：窗崩了宿主还在，`keepAlive` 会把它拉回来。打包版里这个"第二个进程"
  就是 exe 自己（`pi-dsh-pet.exe --pi-pet-window <port>`）。

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
`host.lock/owner.json`、`token`、`state.json`、`ctrl.json`、`config.json`、`log.txt`、`electron.json`。

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

## 10. 版本号与发布

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
4. **产物名里不放版本号。** `YYYY.MM.DD.NNNN` 是四段、还带前导零，**不是合法
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
