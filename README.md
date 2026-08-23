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

> Fork 自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（[npm](https://www.npmjs.com/package/dsh-pet)），本项目专为 pi 平台适配 —— 响应 pi agent 工作状态（思考/写代码/空闲），通过 Electron 全屏透明浮窗渲染。原 dsh-pet 用户请使用 npm 原版。

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

宠物会出现在屏幕右下角，开始动画链。当你在 pi 里写代码或提问时，宠物会自动响应：

| pi agent 状态 | 宠物动画 |
|---------------|----------|
| 开始思考 | 深度思考碎碎念 |
| 调用工具（bash/edit/write） | 写代码 |
| 空闲 | 恢复随机动画链 |

---

## 目录结构

```
pi-dsh-pet/
├── pi/extensions/       # pi 扩展入口（HTTP + WebSocket + Electron 浮窗启动器）
├── pi/assets/           # Electron 窗口 UI（pet.html + pet.js + pet.css + preload）
├── assets/preview/      # 91 个预览 GIF
├── assets/thumb/        # 91 个透明 WebM 动画
├── assets/config.jsonc  # 动画到事件/标签的映射
├── package.json         # npm 包清单
├── DESIGN.md            # 设计与实现文档
├── LICENSE              # MIT
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

大小映射定义在 `pi/assets/pet.js` 第 589 行：

```js
var SIZE_MAP = { small: 260, normal: 400, large: 540 };
```

- **改数字** — 修改小/中/大的 px 宽度（高度自动 = 宽 × 9/16）
- **加档位** — 添加 `tiny`、`xlarge` 等新条目，例如 `{ tiny: 180, ..., xlarge: 720 }`

修改后重新 `/pet` 生效，新增命令（如 `/pet tiny`、`/pet xlarge`）自动可用。

## 文档

- [设计与实现](DESIGN.md) —— 架构、pi 事件映射、素材链

## 许可

- 代码：MIT
- 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**