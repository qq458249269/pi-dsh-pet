# pi-dsh-pet 🐾

[English](./README.en.md)

<p align="center">
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/pi-dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/pi-dsh-pet?label=下载&color=brightgreen"></a>
  <a href="https://github.com/SOMWHY/pi-dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/SOMWHY/pi-dsh-pet?style=social"></a>
  <a href="https://github.com/SOMWHY/pi-dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/SOMWHY/pi-dsh-pet?color=orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-pi%20coding%20agent-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-91%20animations-ff69b4">
</p>

一只住在 **pi 终端编程助手**里的大肥鱼：待机呼吸、随机动作（含打瞌睡）、偶尔转向、屏幕漫游、点击反应、可拖拽。

> 现在它是一个**独立应用**：自己带一个 127.0.0.1 的 HTTP/WS 端口，pi、dsh、curl 都能驱动同一只宠物。
> 下行协议完全没变，老版本窗照旧能跑。

> Fork 自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（[npm](https://www.npmjs.com/package/dsh-pet)），本项目专为 pi 平台适配 —— 响应 pi agent 工作状态（思考/写代码/空闲），通过 Electron 全屏透明浮窗渲染。原 dsh-pet 用户请使用 npm 原版。

---

## 快速开始

```sh
npm install -g pi-dsh-pet
pi-pet start          # 起桌宠（自带服务 + 窗）
```

在 pi 中运行（扩展会**自动**把宿主拉起来，不用手动 start）：

```
/pet             →  显示桌宠（正常大小 400px）
/pet small       →  小号（260px）
/pet large       →  大号（540px）
/pet-stop        →  隐藏桌宠（服务留着，pi/dsh 还能用）
/pet-say 摸鱼中  →  让它说句话
/pet-status      →  宿主在哪、探活多少毫秒
```

不想装 pi 扩展也行，纯当本地服务用：

```sh
pi-pet status                 # 端口 / token / 生产者一览
pi-pet say 起来干活了          # 手动冒个泡
curl -X POST 127.0.0.1:47653/event -H "authorization: Bearer $(pi-pet token)" \
     -H 'content-type: application/json' -d '{"type":"thinking","task":"写代码"}'
```

也提供免安装单文件 exe（release 里就叫 `pi-dsh-pet.exe`），双击即可，不用 Node；
想装到开始菜单就用 `pi-dsh-pet-setup.exe`。
只有 exe 也能接自己的程序：端口与 token 在 `%APPDATA%\pi-dsh-pet\port` 与
`%APPDATA%\pi-dsh-pet\token`（右键菜单里有「复制服务地址」「打开数据文件夹」）；
要完整的 `pi-pet status/feed/say` 命令行则用 `npm i -g pi-dsh-pet`。

> 💡 首次运行需下载 Electron ≈100MB，后续启动秒开。

### 不想用 CI？本地打包

```sh
npm i --no-save electron@33 electron-builder@25   # 只在打包这一步装，运行时依旧零依赖
npm run build          # → dist/pi-dsh-pet.exe（免安装单文件）+ dist/pi-dsh-pet-setup.exe（安装包）
npm run build:dir      # 只出免安装目录版 dist/win-unpacked/，跑得快，适合先验证
```

CI（推 main / 手动触发 `release` workflow）走同一条链，只是多两件事：
先用 `win-unpacked/pi-dsh-pet.exe` 真跑一次冒烟（起服务、查 `/health`、确认 asar 里的
页面与 91 个素材读得出来），再把 exe 与源码 zip 一起挂到 release。
产物名里**没有版本号**（版本号 `YYYY.MM.DD.NNNN` 不是合法 semver，electron-builder 会
把它规范化成 `2026.9.3-0.2` 这种鬼样子），版本认 tag / release 说明。
发布链的约束（token 权限、跨 job 依赖）见 [DESIGN.md §10](./DESIGN.md)。

宠物会出现在屏幕右下角，开始动画链。当你在 pi 里写代码或提问时，宠物会自动响应：

| pi agent 状态 | 宠物动画 | 气泡 |
|---------------|----------|------|
| 开始思考 | 深度思考碎碎念 | 「任务」思考中… |
| 调用工具（bash/edit/write） | 写代码 | 执行中：npm test |
| 完成 | 回到随机动画链 | 完成：xxx ✓ |
| 空闲 | 恢复随机动画链 | 待命中… |

> 💡 思考/写代码状态中点击宠物 → 播放「点击回应-傲娇生气」→ 完整播完后自动回到当前状态动画。
> 💡 **右键桌宠** = 原生菜单：当前状态、事件来源、暂停响应、说点什么、换一只、尺寸、
> 添加一只、隐藏宠物、在浏览器打开、复制服务地址、打开数据文件夹、关于、退出。

---

## 目录结构

```
pi-dsh-pet/
├── app/                # 宿主：协议 / 状态机 / HTTP+WS 服务 / 窗看护 / 单例锁 / CLI
├── bin/pi-pet.cjs      # 命令行入口（pi-pet = dsh-pet）
├── pi/extensions/      # pi 侧薄客户端（自动起宿主、事件 → 状态帧）
├── dsh/pi-pet.mjs      # dsh 侧适配（cordis 风格）
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
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="待机呼吸休闲">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dongzhangxiwang.gif" width="160" alt="东张西望">
</p>

**移动**

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/pangxie-zoulu.gif" width="160" alt="螃蟹走路">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="原地漂浮踏步">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-zuozhuan-benpao.gif" width="160" alt="原地左转奔跑">
</p>

**小动作**

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/youxian-hengga.gif" width="160" alt="悠闲哼歌">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chaoda-shenlanyao.gif" width="160" alt="超大伸懒腰">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-qiaoji-zhuomian-hudong.gif" width="160" alt="原地敲击桌面互动">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-zhongli-xiadun-yasuo.gif" width="160" alt="原地重力下蹲压缩">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/haqian-liantian.gif" width="160" alt="哈欠连天">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="原地小憩沉眠">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/nvpu-quxi-liyi.gif" width="160" alt="女仆屈膝礼仪">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/beixiayitiao-zhamao.gif" width="160" alt="被吓一跳">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/xiaofudu-yuandi-360du-xuanzhuan-zhanshi.gif" width="160" alt="小幅度原地360度旋转展示">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/touchi-lingshi-bei-zhuazhu.gif" width="160" alt="偷吃零食被抓住">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yong-jingyu-weiba-paidadi.gif" width="160" alt="用鲸鱼尾巴拍打地面">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/da-keshui-bei-jingxing.gif" width="160" alt="打瞌睡被惊醒">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/zhao-jingzi.gif" width="160" alt="照镜子">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/zhengti-huanzhuang-shise.gif" width="160" alt="整体换装试色">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/qingkuai-jilu.gif" width="160" alt="轻快记录">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/xie-daima.gif" width="160" alt="写代码">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yaoshan-naliang.gif" width="160" alt="摇扇纳凉">
</p>

**玩耍**

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-zhuanxin-wan-mofang.gif" width="160" alt="原地专心玩魔方">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-dunxia-wan-wanju-qiche.gif" width="160" alt="原地蹲下玩玩具汽车">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/jingyu-tu-paopao-texiao.gif" width="160" alt="鲸鱼吐泡泡特效">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/yuandi-tiaoyue-zhuasui-touding-wupin.gif" width="160" alt="原地跳跃抓碎头顶物品">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/wan-youxi-qijibaituai.gif" width="160" alt="玩游戏气急败坏">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/wan-shuiqiang.gif" width="160" alt="玩水枪">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/xiaotiqin-yanzou.gif" width="160" alt="小提琴演奏">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/lanjing-xianshi.gif" width="160" alt="蓝鲸现世">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/youya-nvpuwu.gif" width="160" alt="优雅女仆舞">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/qingkuai-yaobaiwu.gif" width="160" alt="轻快摇摆舞">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/keai-zhaiwu.gif" width="160" alt="可爱宅舞">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chui-qiqiu.gif" width="160" alt="吹气球">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dongwu-huanrao.gif" width="160" alt="动物环绕">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/fang-fengzheng.gif" width="160" alt="放风筝">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chai-liwu.gif" width="160" alt="拆礼物">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/bian-gezi.gif" width="160" alt="变鸽子">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/puke-moshu.gif" width="160" alt="扑克魔术">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chou-tuoluo.gif" width="160" alt="抽陀螺">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chui-dizi.gif" width="160" alt="吹笛子">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/hudie-mifeng-huanrao-touding-kaihua.gif" width="160" alt="蝴蝶蜜蜂环绕头顶开花">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/lu-mao.gif" width="160" alt="撸猫">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/pingkong-shenghua.gif" width="160" alt="凭空生花">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/qi-muma.gif" width="160" alt="骑木马">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/sanqiu-paojie.gif" width="160" alt="三球抛接">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/ti-jianzi.gif" width="160" alt="踢毽子">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/xiawuziqi.gif" width="160" alt="下五子棋">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dangqiuqian.gif" width="160" alt="荡秋千">
</p>

**吃什么**

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-baifan.gif" width="160" alt="吃白饭">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dakou-chi-lingshi.gif" width="160" alt="大口吃零食">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-token.gif" width="160" alt="吃Token">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-zaocan.gif" width="160" alt="吃早餐">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-wucan.gif" width="160" alt="吃午餐">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-wancan.gif" width="160" alt="吃晚餐">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-bingqilin-ronghua.gif" width="160" alt="吃冰淇淋融化">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-dazhaxie.gif" width="160" alt="吃大闸蟹">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-tanghulu.gif" width="160" alt="吃糖葫芦">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-changshoumian.gif" width="160" alt="吃长寿面">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-xigua.gif" width="160" alt="吃西瓜">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/shuan-huoguo.gif" width="160" alt="涮火锅">
</p>

**时节**

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/beiluoye-yanmo.gif" width="160" alt="被落叶淹没">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/zhongqiu-shangyue-chi-yuebing.gif" width="160" alt="中秋赏月吃月饼">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/duixueren.gif" width="160" alt="堆雪人">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/fang-yanhua.gif" width="160" alt="放烟花">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-zongzi.gif" width="160" alt="吃粽子">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-niangao.gif" width="160" alt="吃年糕">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-qingtuan.gif" width="160" alt="吃青团">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-labazhou.gif" width="160" alt="吃腊八粥">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chi-chongyanggao.gif" width="160" alt="吃重阳糕">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/shou-hongbao.gif" width="160" alt="收红包">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/xie-fuzi.gif" width="160" alt="写福字">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chuanzhenqiqiao.gif" width="160" alt="穿针乞巧">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/wu-shitou.gif" width="160" alt="舞狮头">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/taotang-nanguadeng.gif" width="160" alt="讨糖南瓜灯">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/cha-zhuyu-shangju.gif" width="160" alt="插茱萸赏菊">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/fanghedeng.gif" width="160" alt="放河灯">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/menghua-xiaoyouling.gif" width="160" alt="萌化小幽灵">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/zhuangdian-shengdanshu.gif" width="160" alt="装点圣诞树">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/fang-kongmingdeng.gif" width="160" alt="放孔明灯">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chitangyuan.gif" width="160" alt="吃汤圆">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/chijiaozi.gif" width="160" alt="吃饺子">
</p>

**文字**

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/shia-chishenme.gif" width="160" alt="是啊，吃什么">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/shendu-sikao-suisuinian.gif" width="160" alt="深度思考碎碎念">
</p>

**点击回应 / 拖拽**

<p>
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="点击回应-开心跃动">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dianji-huiying-haixiu-jingya.gif" width="160" alt="点击回应-害羞惊讶">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dianji-huiying-aojiao-shengqi-ceshen-zhanshi.gif" width="160" alt="点击回应-傲娇生气">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dianji-huiying-naoyang-gegexiao.gif" width="160" alt="点击回应-挠痒咯咯笑">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/dianji-huiying-yuanqi-huishou.gif" width="160" alt="点击回应-元气挥手">
  <img src="https://raw.githubusercontent.com/SOMWHY/pi-dsh-pet/main/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="被鼠标拖拽悬空反馈">
</p>

---

## 自定义大小

大小映射定义在 `pi/assets/pet.js`（`SIZE_MAP`）与 `app/protocol.cjs`（`SIZES`）里，**两边必须一致**：

```js
var SIZE_MAP = { small: 260, normal: 400, large: 540 };
```

- **改数字** — 修改小/中/大的 px 宽度（高度自动 = 宽 × 9/16）
- **加档位** — 添加 `tiny`、`xlarge` 等新条目，例如 `{ tiny: 180, ..., xlarge: 720 }`（记得两处都改）

修改后 `/pet` 生效，新增命令（如 `/pet tiny`、`/pet xlarge`）自动可用。已开着的窗需要
`/pet` 或右键菜单换尺寸（换窗生效）。

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