# pi-dsh-pet 🐾

[English](./README.en.md)

<p align="center">
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/pi-dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/pi-dsh-pet?label=下载&color=brightgreen"></a>
  <a href="https://github.com/qq458249269/pi-dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/qq458249269/pi-dsh-pet?style=social"></a>
  <a href="https://github.com/qq458249269/pi-dsh-pet/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/github/license/qq458249269/pi-dsh-pet?color=orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-pi%20coding%20agent-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-91%20animations-ff69b4">
</p>

一只住在 **pi 终端编程助手**里的大肥鱼：待机呼吸、随机动作（含打瞌睡）、偶尔转向、屏幕漫游、点击反应、可拖拽。

> 现在它是一个**独立应用**：自己带一个 127.0.0.1 的 HTTP/WS 端口，pi、dsh、opencode、curl 都能驱动同一只宠物。
> 下行协议完全没变，老版本窗照旧能跑。

> Fork 自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（[npm](https://www.npmjs.com/package/dsh-pet)），本项目专为 pi 平台适配 —— 响应 pi agent 工作状态（思考/写代码/空闲），通过 Electron 透明置顶小浮窗渲染（原 dsh-pet 用户请使用 npm 原版）。

> 💡 浮窗**只包住宠物本身**，不是全屏：全屏透明置顶窗每产生一帧，DWM 都得把整块桌面重新合成一遍，别的程序的后台窗口就抢不到合成预算（「桌宠一开，浏览器就不刷新了」）。想把它放到别处就**拖它**（拖 = 搬整扇窗，见 [移动与位置记忆](#移动与位置记忆)）。

---

## 快速开始

```sh
npm install -g pi-dsh-pet
pi-pet start          # 起桌宠（自带服务 + 窗）
```

在 pi 中运行（扩展会**自动**把宿主拉起来，不用手动 start）：

```
/pet             →  显示桌宠（正常大小 400px）
/pet small       →  小号（380px）
/pet large       →  大号（540px）
/pet-stop        →  隐藏桌宠（服务留着，pi/dsh 还能用）
/pet-say 摸鱼中  →  让它说句话
/pet-status      →  宿主在哪、探活多少毫秒
```

在 opencode 中用（插件会**自动**把宿主拉起来）：

```sh
# 拷到全局插件目录（opencode 启动时自动加载），项目内用 .opencode/plugins/ 也行
node -e "require('fs').copyFileSync('node_modules/pi-dsh-pet/opencode/pi-pet.ts', require('os').homedir()+'/.config/opencode/plugins/pi-pet.ts')"
```

opencode 没有客户端 `/pet` 这类斜杠命令注册（命令是 markdown 模板，每按一次都烧一次模型调用），
所以控制面是一个 `pet` 工具，让 agent 自己调：让它 `show` / `show large` / `hide` /
`say 你今天摸鱼了吗` / `status`；直接跟它说「把桌宠藏起来」也行。

不想装 pi 扩展也行，纯当本地服务用：

```sh
pi-pet status                 # 端口 / token / 生产者一览
pi-pet say 起来干活了          # 手动冒个泡
curl -X POST 127.0.0.1:47653/event -H "authorization: Bearer $(pi-pet token)" \
     -H 'content-type: application/json' -d '{"type":"thinking","task":"写代码"}'
```

也提供免安装单文件 exe（release 里就叫 `pi-dsh-pet.exe`），双击即可，不用 Node；
只有 exe 也能接自己的程序：端口与 token 在 `%APPDATA%\pi-dsh-pet\port` 与
`%APPDATA%\pi-dsh-pet\token`（右键菜单里有「复制服务地址」「打开数据文件夹」）；
要完整的 `pi-pet status/feed/say` 命令行则用 `npm i -g pi-dsh-pet`。

> 💡 首次运行需下载 Electron ≈100MB，后续启动秒开。

#### 为什么 exe 还是这么大

| 块 | 大小 | 能动吗 |
| --- | --- | --- |
| Electron 运行时 | ≈74MB（压后） | 不能，去掉就不是 Electron 了 |
| 91 个 webm 素材 | ≈46MB | 只能重编码降码率（`npm run slim:assets`） |
| locales 语言包 | ≈41MB → 2MB | 已砍：只留 `zh-CN` / `en-US` |

默认产物 ~120MB 就是这个拆解的结果：locales 已砍、压缩已开到 `maximum`。
还嫌大就在 CI 上勾 `slim_assets`（或本地 `npm run slim:assets`）把素材重编码到
512px/CRF 34，能再省三四十 MB，代价是画质；`npm run assets:restore` 一键还原。
`scripts/slim-assets.cjs` 需要本机有 `ffmpeg`，没有就报错退出、不动原文件。

### 不想用 CI？本地打包

```sh
npm i --no-save electron@33 electron-builder@25   # 只在打包这一步装，运行时依旧零依赖
npm run build          # → dist/pi-dsh-pet.exe（只有这一个：免安装单文件）
npm run build:dir      # 只出免安装目录版 dist/win-unpacked/，跑得快，适合先验证
```

> 不再出安装包（NSIS setup）：一个项目两个 exe 时最容易踩的是「双击了没反应」——
> setup 双击先弹 UAC 和安装向导，用户以为程序挂了。免安装单文件双击即用。

CI（推 main / 手动触发 `release` workflow）走同一条链，只是多两件事：
先用 `win-unpacked/pi-dsh-pet.exe` 真跑一次冒烟（起服务、查 `/health`、确认 asar 里的
页面与 91 个素材读得出来），再把 exe 与源码 zip 一起挂到 release。
产物名里**没有版本号**（版本号 `YYYY.MM.DD.NNNN` 不是合法 semver，electron-builder 会
把它规范化成 `2026.9.3-0.2` 这种鬼样子），版本认 tag / release 说明。
发布链的约束（token 权限、跨 job 依赖）见 [DESIGN.md §10](./DESIGN.md)。

改 `.github/workflows/release.yml` 前先知道这三件事（前两件报错都指不到病根，第三件**根本不报错）：

| 坑 | 症状 | 后果 |
|----|------|------|
| 事件键顶格：`workflow_dispatch:` 写在第 0 列 | 编辑器报 `Unexpected value 'workflow_dispatch'` | 它变成**根级**键，`on:` 里只剩 `push` —— **手动触发入口静默消失**，推 tag/main 才跑 |
| 半截 step：`- name: xxx` 后面既没 `run:` 也没 `uses:` | 编辑器报 `There's not enough info to determine what you meant. Add one of these properties: cancel, run, shell, uses…` | 那一步是空转（重排步骤时留下的残渣），不是「忘了写 run」 |
| `concurrency.group` 里写 `${{ github.ref }}` | **没有任何报错**，两个 run 都是绿的 | 本 workflow 自己会 push tag：tag 事件和 main 事件是两个不同的 ref → 两个组 → **一次发布并行跑两个 run**，同时打 exe、同时建同一个 tag 的 release，抢出 `422 already_exists` |

前两行都是**合法 YAML**，所以 `npm test` 一度是绿的；第三行连 YAML 都不是问题所在，
GitHub 一句提示都不会给。`npm run test:workflow`（已挂在 `npm test` 第一步）钉这三件事，
外加「每个 job 都要有 `runs-on`/`steps`」、「`on:` 里必须真的有 `workflow_dispatch`」，
以及「concurrency 必须是**全局一把锁**（group 是字面量 + `cancel-in-progress: true`）」；
零依赖、离线跑。

**所以发布期间的规矩：全局只会有一个发布在跑，新来的会取消还在跑的。**
想连着发两个版本，就等前一个跑完再推——推第二个会把第一个的 exe 构建中途掐掉
（GitHub 上点那个被取消的 run 能看到）。推 tag 触发的那个 run 会把发布做完（它认
tag 上的版本号，不重算、不重建 tag）。零依赖、离线跑。

宠物会出现在屏幕右下角，开始动画链。当你在 pi 里写代码或提问时，宠物会自动响应：

| pi agent 状态 | 宠物动画 | 气泡 |
|---------------|----------|------|
| 开始思考 | 深度思考碎碎念 | 「任务」思考中… |
| 调用工具（bash/edit/write） | 写代码 | 执行中：npm test |
| 完成 | 回到随机动画链 | 完成：xxx ✓ |
| 空闲 | 恢复随机动画链 | 待命中… |

> 💡 思考/写代码状态中点击宠物 → 播放「点击回应-傲娇生气」→ 完整播完后自动回到当前状态动画。
> 💡 **右键桌宠** = 原生菜单：当前状态、事件来源、暂停响应、说点什么、换一只、
> 添加一只、隐藏宠物、在浏览器打开、复制服务地址、打开数据文件夹、关于、退出。
> （换尺寸与省电模式都已从菜单拿掉：换尺寸走 `/control {action:"set-ctrl", size, restartNonce}`，
> 省电接口已屏蔽，见下面「省电 / 占用」）

---

## 目录结构

```
pi-dsh-pet/
├── app/                # 宿主：协议 / 状态机 / HTTP+WS 服务 / 窗看护 / 单例锁 / CLI
├── bin/pi-pet.cjs      # 命令行入口（pi-pet = dsh-pet）
├── pi/extensions/      # pi 侧薄客户端（自动起宿主、事件 → 状态帧）
├── dsh/pi-pet.mjs      # dsh 侧适配（cordis 风格）
├── opencode/pi-pet.ts  # opencode 侧适配（Bun 插件 + pet 工具）
├── pi/assets/          # Electron 窗口 UI（pet.html + pet.js + pet.css + preload + 主进程）
├── assets/preview/     # 91 个预览 GIF
├── assets/thumb/       # 91 个透明 WebM 动画
├── assets/config.jsonc # 动画到事件/标签的映射
├── electron-builder.yml# 打单文件 exe 用（日常开发不需要）
├── package.json        # npm 包清单
├── DESIGN.md           # 架构、协议、状态机、互斥、已知坑
├── LICENSE             # MIT
└── README.md
```

## 动画预览

全部 91 个动画（640×360 透明 WebM）：

**待机 / 转向**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望">
</p>

**移动**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/pangxie-zoulu.gif" width="160" alt="螃蟹走路">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="原地左转奔跑">
</p>

**小动作**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/youxian-hengga.gif" width="160" alt="悠闲哼歌">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chaoda-shenlanyao.gif" width="160" alt="超大伸懒腰">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="原地敲击桌面互动">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-zhongli-xiadun-yasuo.gif" width="160" alt="原地重力下蹲压缩">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/haqian-liantian.gif" width="160" alt="哈欠连天">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/nvpu-quxi-liyi.gif" width="160" alt="女仆屈膝礼仪">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/beixiayitiao-zhamao.gif" width="160" alt="被吓一跳">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/xiaofudu-yuandi-360du-xuanzhuan-zhanshi.gif" width="160" alt="小幅度原地360度旋转展示">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/touchi-lingshi-bei-zhuazhu.gif" width="160" alt="偷吃零食被抓住">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yong-jingyu-weiba-paidadi.gif" width="160" alt="用鲸鱼尾巴拍打地面">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="打瞌睡被惊醒">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/zhao-jingzi.gif" width="160" alt="照镜子">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/zhengti-huanzhuang-shise.gif" width="160" alt="整体换装试色">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/qingkuai-jilu.gif" width="160" alt="轻快记录">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/xie-daima.gif" width="160" alt="写代码">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yaoshan-naliang.gif" width="160" alt="摇扇纳凉">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chenjian-shuaya.gif" width="160" alt="晨间刷牙">
</p>

**玩耍**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="原地专心玩魔方">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-dunxia-wan-wanju-qiche.gif" width="160" alt="原地蹲下玩玩具汽车">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/jingyu-tu-paopao-texiao.gif" width="160" alt="鲸鱼吐泡泡特效">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/yuandi-tiaoyue-zhuasui-touding-wupin.gif" width="160" alt="原地跳跃抓碎头顶物品">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="玩游戏气急败坏">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/wan-shuiqiang.gif" width="160" alt="玩水枪">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/xiaotiqin-yanzou.gif" width="160" alt="小提琴演奏">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/lanjing-xianshi.gif" width="160" alt="蓝鲸现世">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/youya-nvpuwu.gif" width="160" alt="优雅女仆舞">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/qingkuai-yaobaiwu.gif" width="160" alt="轻快摇摆舞">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/keai-zhaiwu.gif" width="160" alt="可爱宅舞">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chui-qiqiu.gif" width="160" alt="吹气球">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dongwu-huanrao.gif" width="160" alt="动物环绕">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/fang-fengzheng.gif" width="160" alt="放风筝">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chai-liwu.gif" width="160" alt="拆礼物">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/bian-gezi.gif" width="160" alt="变鸽子">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/puke-moshu.gif" width="160" alt="扑克魔术">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chou-tuoluo.gif" width="160" alt="抽陀螺">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chui-dizi.gif" width="160" alt="吹笛子">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/hudie-mifeng-huanrao-touding-kaihua.gif" width="160" alt="蝴蝶蜜蜂环绕头顶开花">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/lu-mao.gif" width="160" alt="撸猫">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/pingkong-shenghua.gif" width="160" alt="凭空生花">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/qi-muma.gif" width="160" alt="骑木马">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/sanqiu-paojie.gif" width="160" alt="三球抛接">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/ti-jianzi.gif" width="160" alt="踢毽子">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/xiawuziqi.gif" width="160" alt="下五子棋">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dangqiuqian.gif" width="160" alt="荡秋千">
</p>

**吃什么**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-baifan.gif" width="160" alt="吃白饭">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dakou-chi-lingshi.gif" width="160" alt="大口吃零食">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-token.gif" width="160" alt="吃Token">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-zaocan.gif" width="160" alt="吃早餐">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-wucan.gif" width="160" alt="吃午餐">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-wancan.gif" width="160" alt="吃晚餐">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-bingqilin-ronghua.gif" width="160" alt="吃冰淇淋融化">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-dazhaxie.gif" width="160" alt="吃大闸蟹">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-tanghulu.gif" width="160" alt="吃糖葫芦">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-changshoumian.gif" width="160" alt="吃长寿面">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-xigua.gif" width="160" alt="吃西瓜">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/shuan-huoguo.gif" width="160" alt="涮火锅">
</p>

**时节**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/beiluoye-yanmo.gif" width="160" alt="被落叶淹没">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/zhongqiu-shangyue-chi-yuebing.gif" width="160" alt="中秋赏月吃月饼">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/duixueren.gif" width="160" alt="堆雪人">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/fang-yanhua.gif" width="160" alt="放烟花">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-zongzi.gif" width="160" alt="吃粽子">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-niangao.gif" width="160" alt="吃年糕">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-qingtuan.gif" width="160" alt="吃青团">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-labazhou.gif" width="160" alt="吃腊八粥">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chi-chongyanggao.gif" width="160" alt="吃重阳糕">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/shou-hongbao.gif" width="160" alt="收红包">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/xie-fuzi.gif" width="160" alt="写福字">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chuanzhenqiqiao.gif" width="160" alt="穿针乞巧">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/wu-shitou.gif" width="160" alt="舞狮头">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/taotang-nanguadeng.gif" width="160" alt="讨糖南瓜灯">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/cha-zhuyu-shangju.gif" width="160" alt="插茱萸赏菊">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/fanghedeng.gif" width="160" alt="放河灯">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/menghua-xiaoyouling.gif" width="160" alt="萌化小幽灵">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/zhuangdian-shengdanshu.gif" width="160" alt="装点圣诞树">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/fang-kongmingdeng.gif" width="160" alt="放孔明灯">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chitangyuan.gif" width="160" alt="吃汤圆">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/chijiaozi.gif" width="160" alt="吃饺子">
</p>

**文字**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/shia-chishenme.gif" width="160" alt="是啊，吃什么">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/shendu-sikao-suisuinian.gif" width="160" alt="深度思考碎碎念">
</p>

**点击回应 / 拖拽**

<p>
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应-开心跃动">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dianji-huiying-haixiu-jingya.gif" width="160" alt="点击回应-害羞惊讶">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="点击回应-傲娇生气">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dianji-huiying-naoyang-gegexiao.gif" width="160" alt="点击回应-挠痒咯咯笑">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/dianji-huiying-yuanqi-huishou.gif" width="160" alt="点击回应-元气挥手">
  <img src="https://raw.githubusercontent.com/qq458249269/pi-dsh-pet/main/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈">
</p>

> 💡 **拖到哪儿就记住哪儿**：松手时把落点（比例坐标）报给宿主，落盘在数据目录的
> `positions.json`；下次启动（或右键「换一只」重启窗）还在同一个地方，不用每次重拖。
> 换分辨率/换显示器也跟着走 —— 存的是比例不是像素。
> 想清掉记忆：删掉 `positions.json`，或 `POST /control {action:"set-position"}` 手改。

---

## 自定义大小

> 菜单里已经**不提供**换尺寸的入口（小/中/大）。下面的映射仍在用：默认尺寸走
> `assets/config.jsonc` 的 `pets[].size`，`/control {action:"set-ctrl", size, restartNonce}`
> 与 pi 的 `/pet small|large` 也能换。

大小映射定义在 `pi/assets/pet.js`（`SIZE_MAP`）与 `app/protocol.cjs`（`SIZES`）里，**两边必须一致**：

```js
var SIZE_MAP = { small: 380, normal: 400, large: 540 };
```

- **改数字** — 修改小/中/大的 px 宽度（高度自动 = 宽 × 9/16）。⚠️ 最小档别低于 380：舞台太窄时头顶气泡会被挤到屏幕边上，看着像被裁了一半
- **加档位** — 添加 `tiny`、`xlarge` 等新条目，例如 `{ tiny: 180, ..., xlarge: 720 }`（记得两处都改）

修改后 `/pet` 生效，新增命令（如 `/pet tiny`、`/pet xlarge`）自动可用。已开着的窗需要
`/pet` 或 `set-ctrl + restartNonce` 才换（都要换窗才生效）。

## 移动与位置记忆

浮窗**只包住宠物**（默认约 620×560，拿到配置后按「最大宠物 + 头顶气泡」重算），
不覆盖整块桌面 —— 见开头那条提示：全屏透明窗每帧都要 DWM 重合成整块桌面，会拖垮别的程序。

| 操作 | 效果 |
|------|------|
| **拖宠物** | 搬整扇窗（宠物在窗里的相对位置不变，看起来就是跟着手走）；松手时窗的落点记进 `stage.json`，下次启动还在那儿 |
| **放到别的显示器** | 一样直接拖过去；显示器拔过/分辨率变过时旧坐标会自动夹回可见范围 |
| `POST /control {"action":"set-position"}` | 改宠物**在窗里**的站位（比例坐标，落盘 `positions.json`，与上面的窗位置记忆是两回事） |

窗位置记忆文件：`%APPDATA%/pi-dsh-pet/stage.json`（`{x, y}`，屏幕像素）。
删掉它就回到默认的右下角。

## 检查更新 / 自动更新

- **启动自动检查**：宿主起来 12s 后查一次，有新版就直接装上并换一扇窗（渲染层立刻用上新代码）；
  6h 内不重复查，全程只写日志**不弹窗**。
- **手动检查**：右键菜单「检查更新…」→ 有新版可以当场「现在更新」。
  也走同一套 API：`POST /control {"action":"check-update"}` → `{"action":"do-update"}`，
  结果也会落在 `GET /state` 的 `state.update` 里。

两种装法分别处理（`app/updater.cjs`）：

| 装法 | 怎么更 | 自动 |
|------|--------|------|
| git 检出（pi 扩展装法、`git clone`） | `git fetch` 比远端 → `git pull --ff-only` | ✅ 全自动 |
| npm 全局装 | 查 registry → `npm i -g pi-dsh-pet@latest` | ✅ 全自动 |
| npm 非全局装 / 解压即用 / asar 打包版 | **只报告当前版本和该去哪儿手动更**，不代劳 | ❌ |

几条硬规矩：**工作区脏（有本地改动）就拒绝自动更**（别让更新盖掉你的代码）、
**只用 `--ff-only`**（有分叉就报出来，不自动 merge）、**更新完宿主进程不换代码**
（它是 detached 的，没人负责再拉起它）—— 渲染层立刻生效，`app/*` 要下次 `pi-pet restart`。

开关（给测试和不喜欢自动更新的人）：

```sh
PI_PET_NO_UPDATE=1        # 全关（连启动时的自动检查也没有）
PI_PET_UPDATE=check       # 只查不装
PI_PET_UPDATE_NO_FETCH=1  # 查也不联网，只比本地已有的远端 ref（看「我落后几个提交」）
PI_PET_UPDATE_GAP_MS=…    # 自动检查的最小间隔（默认 6h）
PI_PET_UPDATE_DELAY_MS=…  # 启动后等多久再查（默认 12s，别跟起窗抢 IO）
```

## 待机节奏（动画被切一半 / 待机太短）

管两件事，**整段删掉也会用同样的默认值**：

```jsonc
"timing": {
  "minPlayMs": 7600,     // 一段动画最少播多久才允许被切走
  "idleDwellMs": 11000   // 待机片放完后原地续播多久，再抽下一个
}
```

| 参数 | 治什么 | 调 0 / 调大会怎样 |
|------|--------|------------------|
| `minPlayMs` | 鼠标扫过宠物（hover 移出就回待机）、拖拽落点回待机、待机链重抽，把正演到一半的动作从中间砍掉 —— 看着就是「动画没执行完就跳下一个」 | 0 = 回到「谁来都立刻切」的老行为；调大 = 一段动画更不容易被打断 |
| `idleDwellMs` | 权重是 `idle 10 / turn 5 / move 5 / action 80`，一段待机呼吸刚放完就有 90% 概率直接跳去演随机动作，宠物一直忙个不停 | 0 = 不停留（旧行为）；调大 = 每轮待机更长（加待机片本身约 10s+） |

前两个只管**被动**的切换：点一下、拖起来、拖完落回待机、以及 pi/dsh 的状态帧（思考中/写代码）
永远立刻生效，不受这两个数管 —— 状态必须马上反映到屏幕上。停留期间只要用户一动（点/拖）
或来了状态帧，待机立刻收摊。

### 省电 / 占用

- **不再有「空闲 N 秒自动冻住」**：宠物就该一直动，空闲也照常放（原 `timing.idleSleepMs` 已拿掉）。
- **窗看不见时自动停**：最小化 / 屏保锁屏 / 系统挂起 → 主进程直接喊它睡（不经过服务）。
- **手动省电模式：已屏蔽**（2026-10 起接口一律回「暂时屏蔽」，右键菜单里也没这一项）。
  代码没删，恢复只改一个总闸：`app/host.cjs` 顶上的 `POWER_SAVE_ENABLED = false` 改成 `true`。
  接口长这样（屏蔽期间调它得到 `{"ok":false,"error":"省电模式暂时屏蔽（宠物一直动）"}`）：

  | 调用 | 效果（恢复后） |
  |------|------|
  | `POST /control {"action":"power-save","on":true|false}` | 手动开关省电，落盘 `%APPDATA%/pi-dsh-pet/ctrl.json` 的 `powerSave`（换窗、重启都还保持着） |
  | `POST /control {"action":"set-ctrl","powerSave":true|false}` | 同上，set-ctrl 顺带改意图文件的那条路 |
  | `GET /state` 里的 `ctrl.powerSave` | 只读当前值 |

  开着时：动画冻在当前帧（`video.pause()`、停漫游 rAF、不再上报命中区），气泡文字照常更新、
  能「说点什么」；关掉即从当前帧无缝接着放（不跳回第一帧）。宿主会向窗补发
  `{"type":"power","sleep":true|false}` 帧，窗侧 `applyPowerFrame` 认这个帧。
- 漫游拖动时也掐着：窗内写样式/上报命中区封顶 30fps，主进程那次 `setShape` 有 2px 去重 +
  60ms 节流 —— 不动的宠物不该反复触发整屏重合成。

## 接自己的程序

宿主只听 127.0.0.1，token 在 `%APPDATA%/pi-dsh-pet/token`（`pi-pet token` 打印）。

**端口别写死**：默认 47653 被占时宿主会退到随机端口，真实端口写在 `%APPDATA%/pi-dsh-pet/port`
（一行纯文本，宿主每次起来就写、退出就删）。pi 扩展和 dsh 插件都走这条路：

```js
const port = fs.readFileSync(portFile, "utf8").trim(); // 例如 "12035"
const token = fs.readFileSync(tokenFile, "utf8").trim();
```

上行只有两种方式，语义完全一样：

```js
// 1) WS（推荐，能一直连着，每个来源独立一份会话状态）
const ws = new WebSocket(`ws://127.0.0.1:${port}/feed?source=my-tool&token=${token}`);
ws.onopen = () => {
  ws.send(JSON.stringify({ type: "thinking", task: "拉取数据" }));
  ws.send(JSON.stringify({ type: "tool_call", tool: "bash", detail: "npm run build" }));
  ws.send(JSON.stringify({ type: "done", summary: "构建完成" }));
};

// 2) REST（一次性）
await fetch(`http://127.0.0.1:${port}/event`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ type: "thinking", task: "拉取数据" }),
});
```

`dsh/pi-pet.mjs` 就是这么接的（直接 `import` 丢进 dsh 插件目录即可）。协议细节（下行 v1/v1.1
帧格式、状态机、多会话语义）见 [DESIGN.md](./DESIGN.md)。

## 文档

- [设计与实现](DESIGN.md) —— 架构、协议 v1/v1.1、状态机与气泡、互斥四层、运维命令、已知坑

## 许可

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**