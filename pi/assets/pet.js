/**
 * pi-dsh-pet — pet.js (vanilla JS, no bundler)
 *
 * Port of dsh-pet/src/client/*.ts to vanilla JavaScript.
 * Runs in the browser, connects to pi's WebSocket server for event reactivity,
 * plays the full animation chain with 91 WebM assets.
 *
 * Dependencies: none (pure HTML5 APIs: <video>, WebSocket, Fetch, DOMParser)
 */
(function () {
  "use strict";

  // ========================================================================
  // 1. Constants (from constants.ts)
  // ========================================================================
  var CANVAS_H = 360;
  var FEET_Y = 330;
var HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
  var DRAG_THRESHOLD = 5;

  /**
   * 角色的**可见框**（ink box）：16:9 舞台画布里真正有像素的那一块，640×360 基准。
   *
   * 为什么横向几何要按它算（§9.27，实测出来的）：
   *   动画画布里角色只占中间约 **37.5%**（就是上面那个 HIT_BOX 量出来的），两边各约 31% 是
   *   透明边。size=462 时角色其实只有 173px 宽，容器左右各空 144px。
   *   而贴边是拿**舞台**（容器）去贴的 —— 于是屏幕上看到的角色离边还差那 144px：
   *   实测把窗拖到屏幕 x=0、容器也贴到 0，截图逐像素比出来的可见 ink 还在屏幕 x=153。
   *   用户口径：「左右拉不到很靠边，有一大块距离」。
   *
   * ⚠️ 别反过来去裁素材（把透明边从动画里切掉）：素材是共享的，改一处满盘皆变。
   *   这里只让**几何**（夹取 / 贴边 / 居中 / 漫游道 / 窗宽 / 气泡封顶）按可见框算：
   *   舞台元素仍然是 size 宽、视频仍然铺满它，多出来那截透明边挂在窗外，
   *   被窗边裁掉也**看不见**（实测最外侧被切掉的 144px 全是透明处）。
   *
   * 纵向**不**改：纵向早就按脚底（FEET_Y + bottomPad）对齐了，量过没这问题。
   */
  var INK_X0 = HIT_BOX.x0 / 640;
  var INK_X1 = HIT_BOX.x1 / 640;
  /** 角色可见宽（px）：size 是**舞台**宽，可见宽只有它的 37.5%。 */
  function inkWidth(size) {
    return (Number(size) || 0) * (INK_X1 - INK_X0);
  }

  /** 每段动画**自己**的可见框（640×360 画布坐标），**运行时量**，量不到就没有（用 null）。
   *
   * 为什么必须量：HIT_BOX(200..440) 只框得住角色本体，而有些动画画出来的效果比角色宽得多 ——
   * 「深度思考碎碎念」自带一个气泡（实测逐帧真值 93..551）、「蝴蝶蜜蜂环绕头顶开花」几乎铺满
   * 画布（4..629）。拿 HIT_BOX 当它们的框，形状（SetWindowRgn）就把那截像素切了：
   * 用户口径「思考动画的气泡左右还是会被截断」（不是文案气泡，是动画里画的那个）。
   *
   * ⚠️ 别再把量出来的数硬编成一张表（以前是 pi/assets/ink-boxes.js）：那是 24 帧采样的结果，
   *   采漏的帧照样被切（实测真值右边界 551，表里只有 547 —— 用户反馈「右边还是展示不全」），
   *   而且以后每加一段新动画都得重新量一遍。现在改成起动时自己扫一遍、结果存 localStorage，
   *   加多少新动画都不用改代码、也不会被采样精度坑到。
   */
/* 缓存键带版本号：换了**素材本身**（重新转码、等比补边、抠底）就得升一位，
   * 否则旧框会一直沿用。实测踩到：「夜晚躺在床上睡觉」重新生成前 ink 是 0..640（整幅不透明），
   * 生成后（方形容 360 居中 + 抠底）是 140..500 —— 缓存不升版就还按整幅宽去夹位置。 */
  var INK_CACHE_KEY = "petInkBoxV3";
  var INK_BOXES = (function () {
    var out = {};
    try {
      var raw = window.localStorage.getItem(INK_CACHE_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === "object") {
        Object.keys(o).forEach(function (k) {
          var v = o[k];
          if (Array.isArray(v) && v.length === 4 && v.every(function (n) { return typeof n === "number" && isFinite(n); })) {
            out[k] = [Math.round(v[0]), Math.round(v[1]), Math.round(v[2]), Math.round(v[3])];
          }
        });
      }
    } catch (e) {
      /* localStorage 不可用（隐私模式）就只留内存里的结果，功能不受影响 */
    }
    return out;
  })();
  /** 某一段动画的可见框；没量过就 null（调用方退回 HIT_BOX，退回的是老行为，不会更糟）。 */
  function animInkBox(name) {
    var b = name ? INK_BOXES[name] : null;
    return b ? { x0: b[0], x1: b[1], y0: b[2], y1: b[3] } : null;
  }

  /** 量一段动画要取多少帧（640 画布坐标下的扫描分辨率是 320×180 ⇒ 2px 一格）。
      32 帧均匀铺满整段 ≈ 1~2s 一段动画，够快也不至于把起动卡住。 */
var INK_FRAMES = 32;
  /** 采样漏掉的余量（640 画布坐标，size 462 时 ≈6px）：只给**形状**用（collectHitRects）——
      实测 32 帧采样比逐帧真值少 4~11px（思考气泡真值右边界 551，采样 547）。 */
  var INK_MARGIN = 8;
var INK_QUEUE = [];
  var INK_PENDING = {};
  var INK_BUSY = false;
  /** 扫描用的全局唯一 video+canvas（懒建）。理由见 scanInkBox 里的注释。 */
  var INK_STAGE = null;

  function ensureScanStage() {
    if (INK_STAGE) return INK_STAGE;
    var video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    // ⚠️⚠️ 必须挂进 DOM：不挂的 <video> 不走渲染管线，seek 完了 drawImage 拿到的还是**首帧**
    //   （实测：量出来 15 段全是 202..436 的「只有角色」的框 = 整段都画成了第 0 帧，
    //   后半段才长出来的气泡一个没量到，而看着还「量过了」—— 最坏的一种错）。
    //   1px + opacity 0：不占地方、不被点到，也看不见。挂着不动，别扫完就拔。
    video.style.cssText =
      "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    var canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    INK_STAGE = { video: video, canvas: canvas, g: canvas.getContext("2d", { willReadFrequently: true }) };
    (document.body || document.documentElement).appendChild(video);
    return INK_STAGE;
  }

  function rememberInkBox(name, box) {
    INK_BOXES[name] = [box.x0, box.x1, box.y0, box.y1];
    try {
      window.localStorage.setItem(INK_CACHE_KEY, JSON.stringify(INK_BOXES));
    } catch (e) {
      /* 写不进去（配额/隐私模式）就只在内存里留着 */
    }
  }

  /**
   * 量一段动画的可见框：解一次 webm，按固定步长 **seek**，把每帧缩到 320×180 扫 alpha>24 取并集。
   *
   * ⚠️ 必须 seek，不能「play() + requestVideoFrameCallback」等它自己播完：这扇窗是常驻透明层，
   *   Chromium 会按「看不见」节流它的媒体播放（实测：这种窗里 play() 根本不动，seeked 照常来）。
   *   seek 一次解一帧，一次一段、段间让开 —— 别跟正在播的动画抢解码。
   */
  function measureInkBox(name) {
    var url = "/thumb/" + encodeURIComponent(name) + ".webm";
    return fetch(url)
      .then(function (r) { return r.ok ? r.blob() : null; })
      .catch(function () { return null; })
      .then(function (blob) { return blob ? scanInkBox(name, URL.createObjectURL(blob)) : null; });
  }

  /**
   * 扫一段动画的可见框：把 webm 按固定步长 **seek**，每帧缩到 320×180 扫 alpha>24 取并集。
   *
   * ⚠️⚠️ src 必须是 **blob: URL**，不能直接 "/thumb/x.webm"：
   *   本地服务端不支持 Range（sendFile 一次发整个文件），Chromium 就把这个 <video> 的
   *   `seekable` 判成 [0,0] —— 即使整个文件已经在 buffer 里，seek 也会「立刻 seeked
   *   回到 0」。于是 32 次扫描量的是**同一帧**，量出来 202..436 的「只有角色」的框，
   *   后半段才长出来的气泡/道具一个没量到，而日志/缓存看着还「量过了」——
   *   最坏的一种错（实测踩过）。先 fetch 成 blob 再喂给 video 就没有这层限制。
   * ⚠️ 必须 seek，不能「play() + requestVideoFrameCallback」等它自己播完：这扇窗是常驻透明层，
   *   Chromium 会按「看不见」节流它的媒体播放（实测：这种窗里 play() 根本不动，seeked 照常来）。
   * ⚠️ <video> 必须挂在 DOM 上：不挂的 video 不走渲染管线，drawImage 拿到的还是首帧。
   */
function scanInkBox(name, src) {
    return new Promise(function (resolve) {
      // ⚠️⚠️ **全局只有一个**扫描 video + canvas，全程复用，扫完不回收。
      //   每段动画现建现毁一个 <video>（load + removeChild）看着「干净」，实际是
      //   解码器/GPU 纹理反复重建：全量扫 91 段 → GPU 进程 94MB 涨到 **5090MB**，
      //   扫完不降（实测），渲染进程也卡在 600MB 不回落。扫描是串行的
      //   （INK_BUSY 一把锁），所以一个就够；上一个动画扫完了直接换 src 接着量。
      var sc = ensureScanStage();
      var video = sc.video;
      var canvas = sc.canvas;
      var g = sc.g;
      var minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, i = 0;
      var step = 1 / 24; // loadedmetadata 后改成「时长 / 帧数」：必须铺满整段
      var ended = false;
var finish = function (box) {
        if (ended) return;
        ended = true;
        clearTimeout(guard);
        if (finish.off) finish.off();
        try { URL.revokeObjectURL(src); } catch (e) { /* 回收失败只是内存 */ }
        // ⚠️ 别在这里 load()/removeChild()：下一个动画还要用同一个元素。
        //   只把画面擦干净（否则上一段的残帧会混进这一段的并集框里）。
        try { g.clearRect(0, 0, canvas.width, canvas.height); } catch (e) { /* ignore */ }
        resolve(box);
      };
var guard = setTimeout(function () { finish(null); }, 20000); // 坏文件别把队列卡死
      // ⚠️ 监听器必须成对摘掉：元素是全局复用的，留着就会堆一串旧闭包，
      //   旧闭包拿着旧的 resolve/minX/maxX（下一段的 seeked 会同时喂给它们）。
      var onError = function () { finish(null); };
      var onMeta = function () {
        // ⚠️ 步长必须按**整段时长**摊：固定 1/24 只看得到头 1.3s，而这些动画的气泡/道具
        //   是后半段才长出来的（实测「深度思考碎碎念」整段 10s，头 1.3s 只有角色 ——
        //   量出来 206..434，看着「量过了」其实把气泡整段漏了）。
step = Math.max(video.duration / INK_FRAMES, 1 / 120);
        video.currentTime = 0;
      };
      var onSeeked = function () {
        if (ended) return;
        try {
          g.clearRect(0, 0, 320, 180);
          g.drawImage(video, 0, 0, 320, 180);
          var d = g.getImageData(0, 0, 320, 180).data;
          for (var y = 0; y < 180; y++) {
            var row = y * 320 * 4;
            for (var x = 0; x < 320; x++) {
              if (d[row + x * 4 + 3] > 24) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
        } catch (e) {
          finish(null); // 画不出来（还没解出帧）就放弃这一段
          return;
        }
        i++;
        if (i >= INK_FRAMES || video.ended || video.currentTime >= video.duration - step * 1.5) {
          if (maxX < 0) return finish(null); // 一帧像素都没有 = 名字对不上/文件坏
          // 存**原始**量值，不把采样余量烘进来：余量是给形状（§9.28 的裁剪）用的，
          // 烘进缓存的话它会一路渗进夹取/贴边的几何，待机那种窄动画就会白白差 9px
          // （实测带余量的待机框 188..444 vs 角色框 200..440）。余量在 collectHitRects 加。
          finish({
            x0: minX * 2,
            x1: maxX * 2 + 2,
            y0: minY * 2,
            y1: maxY * 2 + 2,
          });
          return;
        }
// 同帧 seek 不会再触发一次 seeked（会死等），所以每次都要往前挪一格
        video.currentTime = Math.min(video.duration, video.currentTime + step);
      };
      video.addEventListener("error", onError);
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("seeked", onSeeked);
      finish.off = function () {
        video.removeEventListener("error", onError);
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("seeked", onSeeked);
      };
video.pause();
      video.src = src;
    });
  }

  /** 量完一段：位置重夹（宽出来的那截得往窗里挪）+ 命中区重报。 */
  function onInkBoxReady() {
    for (var i = 0; i < pets.length; i++) {
      var p = pets[i];
      if (p && typeof p.refitInk === "function") p.refitInk();
    }
    pushHitRegion();
  }

  /** 排队量一段动画（正在播的插队最前：它马上要用）。 */
  function queueInkMeasure(name) {
    if (!name || INK_BOXES[name] || INK_PENDING[name]) return;
    if (INK_QUEUE.indexOf(name) < 0) INK_QUEUE.unshift(name);
    drainInkQueue();
  }

  function drainInkQueue() {
    if (INK_BUSY) return;
    var name = INK_QUEUE.shift();
    if (!name) return;
    INK_BUSY = true;
    INK_PENDING[name] = true;
    measureInkBox(name).then(function (box) {
      delete INK_PENDING[name];
      INK_BUSY = false;
      if (box) {
        rememberInkBox(name, box);
        onInkBoxReady(name);
      }
      setTimeout(drainInkQueue, 200); // 让解码器喘口气，别和正在播的动画抢
    });
  }

  /** 起动时先排上「马上就会播到」的那几段：状态 override（agent 一有事就放）→ 待机/转身/
      拖拽/点击/悬停 → 走路。分类动作（几十段）不排：等真播到它时 switchTo 会插队量
      （queueInkMeasure），热路径不受影响，也不用起动就烧三分钟解码。 */
  function prewarmInkBoxes() {
    var a = (config && config.animations) || {};
    var names = [];
    var push = function (n) { if (typeof n === "string" && n && !INK_BOXES[n] && names.indexOf(n) < 0) names.push(n); };
    Object.keys(EVENT_ANIM_MAP).forEach(function (k) { push(EVENT_ANIM_MAP[k]); });
    Object.keys(TOOL_ANIM_MAP).forEach(function (k) { push(TOOL_ANIM_MAP[k]); });
    ["idle", "turn", "drag", "clicks", "hover"].forEach(function (k) {
      (Array.isArray(a[k]) ? a[k] : []).forEach(push);
    });
    var moves = a.moves || {};
    (Array.isArray(moves.actions) ? moves.actions : []).forEach(function (m) { push(m && m.name); });
    names.forEach(function (n) {
      if (!INK_BOXES[n] && INK_QUEUE.indexOf(n) < 0) INK_QUEUE.push(n);
    });
    drainInkQueue();
  }

  /**
   * 宠物（动画）的**最小宽度**，px。
   *
   * 用户口径：宽度低于 380 就「动画展示不全」——16:9 的舞台上角色只占中间一小块，
   * 窗/舞台一窄，角色两侧（手脚、拖拽反馈、两行气泡）就被切掉。
   * 所以这个数是**硬下限**，三处都得用它：
   *   ① 配置校验（老配置 / 手改 JSON 写小了 → 抬到下限，不报错）
   *   ② SIZE_MAP / add_pet（换尺寸档位）
   *   ③ reportWindowSize（舞台窗宽度下限，= 380 + 边距）
   */
  var MIN_PET_SIZE = 380;
  /** 宠物（动画）的**最小高度**，px —— 「按高度配置」（height）时的下限。
   *  380 宽 × 9/16 ≈ 214：比它再矮，16:9 的画布就窄过 380 宽那条线（同一个下限）。 */
  var MIN_PET_H = 214;

  /**
   * 一只宠物的显示**宽度**，px（纯计算，配置 → 像素只有一个出处）。
   *
   * 两种写法（只加不改，老配置照旧）：
   *   • size: 462   —— 旧口径：给宽度，高度按 16:9 推（默认行为，一字未变）
   *   • height: 260 —— 新口径（§9.24）：给高度，**宽度自适应** = height × 16/9
   * 「按高度设置」才是屏幕上的真实口径：桌面上占多高才 deciding 了显不显得下，
   * 宽高比是动画自己的事（16:9），不该让人手算宽度。
   */
  function petSizeOf(cfg) {
    var h = Number(cfg && cfg.height);
    if (isFinite(h) && h > 0) {
      if (h < MIN_PET_H) h = MIN_PET_H;
      return Math.round((h * 16) / 9);
    }
    var w = Number(cfg && cfg.size);
    if (!isFinite(w) || w <= 0) w = 400;
    return Math.max(MIN_PET_SIZE, Math.round(w));
  }

  /**
   * 换动画时，等「新的一段首帧真的贴上屏幕」最多等多久（ms）。
   *
   * 正常只要 30~50ms（requestVideoFrameCallback 一回调就换手，见 switchTo）。这是给
   * 「回调一直不来」的兜底：宁可让旧姿势多顶一会儿，也不能让宠物卡在旧动作上不动。
   */
var FRAME_WAIT_MS = 220;
  // 等整段 webm 都进本地缓存的耐心（见 switchTo 里的说明）。预热过的段早就到了，不花时间。
  var BUFFER_WAIT_MS = 2000;

  // ========================================================================
  // 2. Config helpers (from config.ts)
  // ========================================================================

  /** Strip JSONC comments (// and /* * /) → pure JSON string */
  function stripJsonc(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^\\:])\/\/.*$/gm, "$1")
      .trim();
  }

  /**
   * 节奏参数（可选，写在 config.jsonc 的 timing 里）。写错/漏写都回落到默认值 ——
   * 手感参数不值得为它把整扇窗搞崩（assertClientConfig 抛错 = 宠物直接不出现）。
   *
*   minPlayMs    一段动画**最少**播多久才允许被别人切走（毫秒）
   *   idleDwellMs  待机动画播完之后原地续播多久再由链子往下抽（毫秒）
   *
   * 这两个数是同一件事的两头：minPlayMs 治「动画没演完就被切一半」，
   * idleDwellMs 治「待机太短，一口气连着演、看着一直忙个不停」。
   *
   * ⚠️ 用户要求：**每段动画的播放时间统一延长 5 秒**，免得看着总在「切来切去」不停歇。
   *   于是两个默认数都在原基础上 +5000ms（2.6s→7.6s / 6s→11s）。
   *   写进 config.jsonc 的 timing 优先（配置里没写才用这几个默认值）。
   */
var TIMING_DEFAULT = { minPlayMs: 7600, idleDwellMs: 11000 };

  function readTiming(raw) {
    var t = raw && typeof raw === "object" ? raw : {};
    function num(key, def) {
      var v = Number(t[key]);
      if (!isFinite(v) || v < 0) return def;
      return Math.min(60000, Math.round(v));
    }
    return {
      minPlayMs: num("minPlayMs", TIMING_DEFAULT.minPlayMs),
idleDwellMs: num("idleDwellMs", TIMING_DEFAULT.idleDwellMs),
    };
  }

/**
   * 聊天/碎碎念（config.jsonc 的 chatter 段，§9.33）。
   *
   * **没写就闭嘴**（返回 null），不在代码里藏第二份默认文案：文案只有用户手里那份，
   * 删掉整段就等于关掉这个功能，写坏了也只是没人碎碎念（绝不抛错把宠物搞没）。
   */
  function readChat(raw) {
    var c = raw && raw.chatter;
    if (!c || typeof c !== "object") return null;
    function list(v) {
      if (!Array.isArray(v)) return [];
      return v.filter(function (s) { return typeof s === "string" && s.trim() !== ""; });
    }
    var idle = list(c.idle);
    var fallback = list(c.fallback);
    var replies = {};
    if (c.replies && typeof c.replies === "object") {
      Object.keys(c.replies).forEach(function (k) {
        var v = list(c.replies[k]);
        if (k && v.length) replies[k] = v;
      });
    }
    var sec = Array.isArray(c.idleSec) ? c.idleSec.map(Number) : [];
    var lo = isFinite(sec[0]) && sec[0] > 0 ? sec[0] : 90;
    var hi = isFinite(sec[1]) && sec[1] >= lo ? sec[1] : lo * 2;
    if (!idle.length && !fallback.length && !Object.keys(replies).length) return null;
    return { enabled: c.enabled !== false, idleSec: [lo, hi], idle: idle, fallback: fallback, replies: replies };
  }

  /** 窗里到处都要问这两个数（config 可能还没加载完，所以都带兜底） */
  function minPlayMs() {
    return config && config.timing ? config.timing.minPlayMs : TIMING_DEFAULT.minPlayMs;
  }
  function idleDwellMs() {
    return config && config.timing ? config.timing.idleDwellMs : TIMING_DEFAULT.idleDwellMs;
  }

  var CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
  var CORNER_SET = {};
  CORNERS.forEach(function (c) { CORNER_SET[c] = true; });

  /** Validate raw config object → return sane ClientConfig or throw */
  function assertClientConfig(raw) {
    if (!raw || typeof raw !== "object") throw new Error("config not object");

    // pets
    var petsArr = Array.isArray(raw.pets) ? raw.pets : [];
    if (!petsArr.length) throw new Error("missing pets");
    var seen = {};
    var pets = [];
    for (var i = 0; i < petsArr.length; i++) {
      var p = petsArr[i];
      var id = String(p.id || "");
      if (!id || seen[id]) throw new Error("pet id invalid or duplicate: " + id);
      var size = Number(p.size);
      var height = Number(p.height);
      // 「设置高度、自适应宽度」（§9.24）：写了 height 就以它为准，size 变成推导值。
      if (isFinite(height) && height > 0) {
        if (height < MIN_PET_H) {
          try {
            console.warn("[pi-dsh-pet] pet " + id + " 的 height " + height + " 小于下限 " + MIN_PET_H + "，按 " + MIN_PET_H + " 算");
          } catch (e) {
            /* 浏览器里没 console 就算了 */
          }
          height = MIN_PET_H;
        }
        size = Math.round((height * 16) / 9);
      } else {
        if (!isFinite(size) || size <= 0) throw new Error("pet " + id + " size invalid");
        // 小于下限的（老配置、手改 JSON）**抬到下限**而不是照用：宽度不够就展示不全。
        if (size < MIN_PET_SIZE) {
          try {
            console.warn("[pi-dsh-pet] pet " + id + " 的 size " + size + " 小于下限 " + MIN_PET_SIZE + "，按 " + MIN_PET_SIZE + " 算");
          } catch (e) {
            /* 浏览器里没 console 就算了 */
          }
          size = MIN_PET_SIZE;
        }
      }
      var corner = (p.position && p.position.corner) || "";
      if (!CORNER_SET[corner]) throw new Error("pet " + id + " corner invalid");
      var marginX = Number(p.position && p.position.marginX);
      var marginY = Number(p.position && p.position.marginY);
      if (!isFinite(marginX) || !isFinite(marginY)) throw new Error("pet " + id + " margin invalid");
      seen[id] = true;
      var out = { id: id, size: size, position: { corner: corner, marginX: marginX, marginY: marginY } };
      // 高度原样带下去：reportWindowSize/stageSize 会重算一次，两边用同一个 petSizeOf
      if (isFinite(height) && height > 0) out.height = height;
      pets.push(out);
    }

    // animations
    var a = raw.animations;
    if (!a || typeof a !== "object") throw new Error("missing animations");
    ["idle", "turn", "drag", "clicks"].forEach(function (k) {
      if (!Array.isArray(a[k])) throw new Error("animations." + k + " missing");
    });
    // 可选池：没写就不播（老配置照样能用）
    if (a.hover !== undefined && !Array.isArray(a.hover)) throw new Error("animations.hover must be an array");
    if (!a.moves || typeof a.moves !== "object" || !a.moves.default || !Array.isArray(a.moves.actions)) {
      throw new Error("animations.moves structure invalid");
    }
    if (!Array.isArray(a.categories)) throw new Error("animations.categories missing");

    // weights
    var w = raw.animationWeights;
    if (!w || typeof w !== "object") throw new Error("missing animationWeights");
    ["idle", "turn", "move"].forEach(function (k) {
      var v = Number(w[k]);
      if (!isFinite(v) || v < 0) throw new Error("animationWeights." + k + " invalid");
    });

return { pets: pets, animations: a, animationWeights: w, timing: readTiming(raw.timing), chatter: readChat(raw), gestures: raw.gestures && typeof raw.gestures === "object" ? raw.gestures : null };
  }

  // ========================================================================
  // 3. Pickers (from pickers.ts)
  // ========================================================================

  function pick(pool, exclude) {
    var entries = exclude ? pool.filter(function (n) { return n !== exclude; }) : pool;
    var src = entries.length ? entries : pool;
    return src[Math.floor(Math.random() * src.length)];
  }

  function randomBetween(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  /** 该不该随行进方向镜像（scaleX(-1)）。
   *
   * ⚠️⚠️ 只有 **turn（转身）+ moves.actions（走路）** 镜像（§9.28）：镜像是为了让角色
   *   朝着它正在走的那边。以前是「facingRef 一变就镜像所有动画」，于是待机、小动作、
   *   点击回应、状态 override 有一半时间在看镜像 —— 文字、写字、玩道具那些一翻过来就
   *   全不对（用户口径「为什么有的动画是镜像的」）。素材作者本来就把动作画成了他们要的样子，
   *   只有「行进方向」才需要程序替它翻面。
   */
  function isDirAnim(name) {
    var a = config && config.animations;
    if (!a || !name) return false;
    if (Array.isArray(a.turn) && a.turn.indexOf(name) >= 0) return true;
    var moves = a.moves || {};
    var actions = Array.isArray(moves.actions) ? moves.actions : [];
    for (var i = 0; i < actions.length; i++) {
      if (actions[i] && actions[i].name === name) return true;
    }
    return false;
  }

  function pickWeightedCategory(categories, facing) {
    var cats = categories.filter(function (c) { return c.actions.length > 0; });
    if (!cats.length) return null;
    var filtered = cats.filter(function (c) { return !(c.noMirror && facing === "right"); });
    var eligible = filtered.length ? filtered : cats;
    var totalW = eligible.reduce(function (s, c) { return s + c.weight; }, 0) || 1;
    var t = Math.random() * totalW;
    for (var i = 0; i < eligible.length; i++) {
      t -= eligible[i].weight;
      if (t <= 0) return eligible[i];
    }
    return eligible[eligible.length - 1];
  }

  function rollKind(roll, w) {
    var topEnd = (w.idle + w.turn + w.move) / 100;
    if (roll < w.idle / 100) return "idle";
    if (roll < (w.idle + w.turn) / 100) return "turn";
    if (roll < topEnd) return "move";
    return "action";
  }

  function pickCategoryAction(categories, idlePool, facing, current) {
    var cat = pickWeightedCategory(categories, facing);
    if (!cat) return { id: "FALLBACK", name: pick(idlePool, current) };
    return { id: cat.id, name: pick(cat.actions, current) };
  }

  // ========================================================================
  // 4. Motion (from motion.ts)
  // ========================================================================

  function planMove(o) {
    var distance = randomBetween(o.minDist, o.maxDist);
    var target = o.cx + o.dir * distance;
    var leftBound = o.margin + o.halfW;
    var rightBound = o.W - o.margin - o.halfW;
    if (target < leftBound || target > rightBound) return null;
    return {
      startRatio: o.cx / o.W,
      startYRatio: o.cy / o.H,
      targetRatio: target / o.W,
      totalRatio: Math.abs(target - o.cx) / o.W,
    };
  }

  // ========================================================================
  // 4.5 命中区（Hit region）
  //
  // 窗是全屏的，如果不去管它，鼠标一扫到宠物身上就把整屏点击都吃了（下面的窗口全部
  // 点不动，必须把鼠标移出宠物才恢复）。所以把「宠物包围盒」实时报给主进程，
  // 由主进程 setShape 把整窗命中区裁到宠物身上：只有宠物能点，别处的点击照常落到下面。
  //
  // 取的是**真正能点的那块**（.pet-hit），不是宠物容器：容器是 16:9 的整块画布，
  // 四边留着一圈透明边。按容器报会把那圈透明边也划进命中区，鼠标停在那儿
  // 点下去什么都不会发生（被透明窗吃掉），却又到不了下面的窗口 —— 正是本节要消灭的毛病。
  //
  // 包围盒还要包含头顶的气泡（否则正在输入的「说点什么…」会被裁掉），四周留一点余量。
  // ========================================================================

var HIT_PAD_X = 10;
  var HIT_PAD_TOP = 12;
  var HIT_PAD_BOTTOM = 10;
/** 气泡行高（13px × 1.4 ≈ 18.2），算「头顶能塞几行/几条」用（见 clampBubble / fitCount） */
  var BUBBLE_LINE_H = 18.2;
  /** 一条气泡最少占的高度：一行的字 + 上下内边距（pet.css 的 padding 5 + border 2） */
  var BUBBLE_MIN_H = 30;
  /** 气泡头顶要让出来的：外边距 10 + 贴边 8。
      （尾巴那 6px 是画在气泡框**下面**的，正好落在 10px 的外边距里，不占头顶空间；
        早先按 36 算，白白少给一行 —— 见 §9.21 的实测） */
var BUBBLE_CHROME_H = 18;
/** 气泡与容器之间的外边距（pet.css 的 margin-bottom，恒在头顶就是这一条）。
      算「无偏移时气泡在哪」时必须算上它，忘了就恒差 10px（实测偏移差 10）。 */
var BUBBLE_GAP = 10;
/** 气泡之间（以及输入行）的间隙，clampBubble 分头顶空间时要用（§9.34） */
  var BUBBLE_GAP_PX = 4;
  /** 头顶最多同时泡几条（§9.34）。**上限**；真能留几条由 fitCount() 按头顶实测空间算
   *  （贴上边、窗口小的时候自动降），超出就把最老的收掉。 */
  var BUBBLE_MAX = 5;
  /**
   * 舞台窗的留白（§9.24）：窗 = 宠物 + 四边 padding。
   *
   * 配置里的 marginX/marginY 当**下限**用：比 padding 小的抬到 padding。理由：
   *   ① 头顶那截不是装饰，是气泡的舞台（150 = 6 行字 113 + 贴边 18，实测）；
   *   ② 左右那截只当「动画离窗边的余量」（24px）—— 宽气泡**不再**靠它，
   *      窗宽改成**跟着动画走**（下面 stageSize），气泡宽度 = min(窗宽-16, BUBBLE_W_MAX)。
   *   ③ 但这截窗里除了宠物和气泡全是透明的 —— 它不能挡住别的软件，
   *      所以窗可以大、形状必须小（见 pet-electron.cjs 的 setShape）。
   *
   * ⚠️ 左右留白曾经被抬到 200（§9.22/§9.23），量完撤了：窗从 622 涨到 862，
   *   动画并没有因此变大一点 —— 动画只占 size 宽（实测量：size=900 时窗 1300 宽，
   *   贴右上角后动画右边离窗边只剩 marginX=24px，左边却空着 376px，
   *   看着就是「动画被窗边切了一角 / 显示不全」）。真正该给的是**高度**
   *   （头顶 150 装气泡），宽度按内容自适应，见 stageSize()。
   *
* ⚠️⚠️ 但**留白**和**行程**是两回事（§9.25）：留白是装饰（撤了），行程是动画要用的道
   *   —— 撤到 32 之后窗里只剩 24px 能走，而走路动画一程 60~320px，于是走路动画
   *   放不出来、放出来也只挪两步就被夹住（用户口径：「动画左右被裁剪限制」）。
   *   所以左右要给的不是常数，是**按配置算出来的行程**（见 roamRoom）。
   *
   * ⚠️⚠️⚠️ 窗宽的基数是**可见框**不是舞台（§9.27）：动画画布里角色只占中间 37.5%，
   *   size=462 时舞台 462 而角色只有 173 宽、左右各 144px 全是透明区。
   *   按舞台算的话窗里左右各白留一大块，角色永远离屏边那么远（实测：容器贴到屏边
   *   x=0，可见 ink 还在 x=153）—— 用户口径「左右拉不到很靠边，有一大块距离」。
   */
  var STAGE_PAD_X = 32;
  var STAGE_PAD_TOP = 150;
  var STAGE_PAD_BOTTOM = 60;

  /**
   * 漫游（走路）要的**横向行程**：窗宽里除了动画还得有多少能走的道（§9.25）。
   *
   * 口径与 planMove 完全一致 —— 那边要求落点中心落在
   *   [margin + 半宽, 窗宽 − margin − 半宽] 里，所以「走得满一趟」的条件是
   *   **窗宽 − 动画宽 ≥ 2×margin + maxDist**。减掉两侧本来就有的留白，缺多少补多少。
   * 为什么不写死一个数：moves 是配置（minDist/maxDist/margin 谁都能改），
   * 写死就会出现「配置要 320、窗只给 64」——动画被限制在原地，或者走到窗边被切。
* 拿不到 moves（配置没到）就按 0 补：先摆着，配置到了会重报窗宽（reportWindowSize）。
   *
   * ⚠️ 「动画宽」= **可见框**宽（§9.27 的 inkWidth），不是舞台宽 —— 漫游道也是道，
   *   角色走到道的一头就该贴住窗边，多出来那截透明舞台区不占地也不该算进行程。
   */
  function roamRoom(sidePad) {
    var pad = Math.max(0, Number(sidePad) || 0);
    var moves = (config && config.animations && config.animations.moves) || null;
    if (!moves) return 0;
    var d = moves.default || {};
    var maxDist = Math.max(0, Number(d.maxDist) || 0);
    var margin = Math.max(0, Number(d.margin) || 0);
    (moves.actions || []).forEach(function (a) {
      var p = (a && a.params) || {};
      var md = Number(p.maxDist);
      var mg = Number(p.margin);
      if (isFinite(md) && md > 0) maxDist = Math.max(maxDist, md);
      if (isFinite(mg) && mg > 0) margin = Math.max(margin, mg);
    });
    if (!(maxDist > 0)) return 0;
    return Math.max(0, Math.ceil(maxDist + 2 * margin - 2 * pad));
  }

  /**
   * 显示器工作区（渲染进程自己的一份，§9.25）。
   *
   * 为什么渲染进程也得有一份：拖宠物时「能不能贴到屏幕边」是**两个自由度**的事 ——
   *   屏幕位置 = 窗的位置 + 宠物在窗里的位置。
   * 主进程只管第一个（它把整扇窗夹在屏内，§9.23），第二个自由度以前是**死的** ——
   * 拖拽全程宠物在窗里一动不动。于是窗一被屏幕边夹住，宠物就永远差
   * 「它在窗里贴着的那条边」那么远：头顶 150、底下 60、左右 32 —— 那「一大块距离」，
   * 也就是「拖到边上贴不上」。
   * 修法：主进程把各显示器的工作区推过来（pet:displays，量变时才发），
   * 渲染进程拿它算出窗被夹住的那份**差额**，把差额挪到宠物在窗里的位置上（见 slideTo）。
   * 每帧**不新增任何 IPC**，而宠物照旧贴着光标、贴到边时正好贴住。
   * 拿不到（老主进程 / 没发过来）就退回老行为：窗夹住、宠物停在原地。
   */
  var displayList = [];
  function setDisplays(list) {
    displayList = (Array.isArray(list) ? list : [])
      .filter(function (d) {
        return d && d.workArea && isFinite(Number(d.workArea.x)) && isFinite(Number(d.workArea.width));
      })
      .map(function (d) {
        return { bounds: d.bounds || d.workArea, work: d.workArea };
      });
  }
  /** 等价于主进程的 screen.getDisplayNearestPoint({x,y})：先找含着该点的屏，否则找中心最近的。 */
  function workAreaNear(x, y) {
    if (!displayList.length) return null;
    var px = Number(x) || 0;
    var py = Number(y) || 0;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < displayList.length; i++) {
      var d = displayList[i];
      var b = d.bounds || d.work;
      if (px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height) return d.work;
      var cx = b.x + b.width / 2;
      var cy = b.y + b.height / 2;
      var dd = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (dd < bestD) {
        bestD = dd;
        best = d.work;
      }
    }
    return best;
  }
  /**
   * 窗的位置夹进这块工作区：**整扇窗**在屏内（§9.23 的口径，和主进程同一套数 ——
   * 两边算法不一样的话，窗和宠物就会各夹各的，贴边时差出一截）。
   * 窗比屏还宽/高时区间会翻过来，这时靠上/靠左摆。
   */
  function clampWinToScreen(want, winW, winH, wa) {
    if (!wa) return { x: Math.round(want.x), y: Math.round(want.y) };
    var loX = wa.x;
    var hiX = wa.x + wa.width - winW;
    var loY = wa.y;
    var hiY = wa.y + wa.height - winH;
    return {
      x: Math.round(loX > hiX ? loX : Math.min(Math.max(want.x, loX), hiX)),
      y: Math.round(loY > hiY ? loY : Math.min(Math.max(want.y, loY), hiY)),
    };
  }
  /** 气泡**定宽**（§9.34）：宽度不再跟文案走 → 折行稳定 → 位置不动、不会自己乱跳。
   *  BUBBLE_W_MAX 是上限（再宽就横跨半个屏，不像「宠物说话」），BUBBLE_W_MIN 防窄窗里夹成一条。 */
  var BUBBLE_W_MAX = 340;
  var BUBBLE_W_MIN = 220;
  /**
   * 贴上边的宠物在窗里离窗顶多远：至少 STAGE_PAD_TOP。
   * applyPosition（摆位）与 reportWindowSize（报窗大小）必须用**同一个**算法，
   * 否则报的高度和实际偏移差一截，窗顶/窗底就空出一截死区（白占合成预算）。
   */
function topOffsetOf(cfg) {
    var m = Number(cfg && cfg.position ? cfg.position.marginY : 0);
    if (!isFinite(m)) m = 0;
    return Math.max(m, STAGE_PAD_TOP);
  }
  /**
   * 贴下边的宠物在窗里离窗底多远。贴上边时底下只留拖拽/漫游的余量，用定值；
   * 贴下边时才认配置里的 marginY（不然窗底会空出一截死区，见 §9.21）。
   * ⚠️ stageSize() 算窗高、stageKeepIn() 算站位区间都必须走这里 —— 又一份算法
   *   就会又一处对不上（§9.22 就是窗和气泡两份数对不上）。
   */
  function bottomPadOf(cfg) {
    var corner = String((cfg && cfg.position && cfg.position.corner) || "bottom-right");
    if (corner.indexOf("top") === 0) return STAGE_PAD_BOTTOM;
    var m = Number(cfg && cfg.position ? cfg.position.marginY : 0);
    if (!isFinite(m)) m = 0;
    return Math.max(m, STAGE_PAD_BOTTOM);
  }
  /**
     * 夹取时宠物在**窗里**能站的范围。
     *
     * 纵向 **从 STAGE_PAD_TOP（150）起夹**（§9.35）：头顶那截留给气泡栈。
     *   中间试过 0 起夹（§9.28），想让宠物能贴到屏顶、气泡改盖头顶 ——
     *   实测头顶 0 留白时 fitCount() 只给 1 条，多条气泡根本长不起来（用户口径
     *   「气泡要多个、依次向上滚」）。窗高本来就是 topOff + 宠物 + 脚下留白算的
     *   （见 stageSize），下界放回 150 不额外占窗内空间。
     *
     * ⚠️ 横向的下界是 **0**（§9.25）：贴边是**屏幕**上的概念，
     *   而窗和宠物的偏移是两个自由度。夹在 32 就等于「永远不许宠物贴到窗边」——
     *   拖到屏幕边（窗也被夹到屏幕边）时宠物还差 32，而且下次启动这 32 还会把它拽回来。
     *   横向留白的气泡问题 clampBubble 已经管了（它按**窗**夹），不需要在这儿再留一道。
   *
* ⚠️ 窗比「宠物 + 两侧留白」还窄时（多开时窗按最大的那只算，小的那只就在区间外）
   *   区间会翻过来，这时取中间值而不是硬贴左边 —— 否则照样贴到窗边、同样没头顶。
   *
   * ⚠️ 横向量的是**可见框**宽（§9.27 的 inkW），纵向量的是**舞台**高（stageH）：
   *   两者不是一回事 —— 舞台左右各有 144px 透明边，按舞台宽算就永远贴不上屏边。
   *   返回值也是**可见框**左边（调用方自己减掉 inkOff 才是容器左边）。
   */
function stageKeepIn(left, top, inkW, stageH) {
    var W = window.innerWidth;
    var H = window.innerHeight;
    var loX = 0;
    var hiX = W - inkW;
    if (hiX < loX) loX = hiX = Math.max(0, (W - inkW) / 2);
    // §9.35：下界回到 STAGE_PAD_TOP —— 头顶那截是气泡的台子。
    //   改成 0（§9.28）以后记住的落点把宠物钉在窗顶，头顶空间 0 ⇒ fitCount() 只给 1 条，
    //   多条气泡根本长不起来（用户口径「气泡要多个、依次向上滚」）。
    var loY = STAGE_PAD_TOP;
    var hiY = H - stageH;
    if (hiY < loY) loY = hiY = Math.max(0, (H - stageH) / 2);
    return {
      left: Math.min(Math.max(left, loX), hiX),
      top: Math.min(Math.max(top, loY), hiY),
    };
  }

  /**
   * 舞台内的横向居中位置（§9.26）。
   *
   * 为什么单独一个函数：摆位（applyPosition）、多开错位、站位回夹三处都要它 ——
   * 散开写就会出现「一只居中、另一只贴边」这种看着像 bug 的不一致。
   *
   * 多开：两只都居中会**完全重叠**（以前靠 corner 的 left/right 两支错开，
   * §9.26 起那两支改成居中了）。所以按序号在「舞台里的横向行程」上等分：
   * 一只 → 正中间；n 只 → 从最左到最右等距（仍然对称，不会有一侧全空）。
* 位置记忆（customPos）优先，记住的落点不受这个影响。
   *
   * ⚠️ size 传的是**可见框**宽（§9.27），返回的也是可见框左边 ——
   *   调用方自己减掉 inkOff 才是容器左边。
   */
function centeredLeft(size, index, total) {
    var W = window.innerWidth;
    var lane = Math.max(0, W - size);
    var n = Math.max(1, total || 1);
    var i = Math.max(0, Math.min(index || 0, n - 1));
    if (n === 1) return Math.round(lane / 2);
    return Math.round((lane * i) / (n - 1));
  }
  /** 漫游/拖拽时每帧都在动，而主进程每次都要 SetWindowRgn：50ms 一次（20fps）跟手又不至于卡 */
  var HIT_THROTTLE_MS = 50;
  /** 命中区量化到 2px 的网格。不动的宠物不该因为亚像素抖动一直让主进程重裁形状
   *  （主进程那边每次 setShape = 一次全屏重合成，见 pet-electron.cjs 的说明）。 */
  var HIT_QUANT = 2;
  var regionQueued = false;
  var regionTimer = null;
  var lastRegionKey = "";
  var lastRegionAt = 0;

  /** 量化：把亚像素抖动抹平（主进程只认量化后的值，这边也就只按量化后的值去重） */
  function quant2(v) {
    return Math.round(Number(v) / HIT_QUANT) * HIT_QUANT;
  }

  /** 把每只宠物的可见气泡夹在屏幕内（超出就往回挪），挪完再算命中区，
      保证主进程拿到的形状和屏幕上画出来的是同一个位置。 */
  function clampBubbles() {
    for (var i = 0; i < pets.length; i++) {
      var p = pets[i];
      if (p && typeof p.clampBubble === "function") p.clampBubble();
    }
  }

  function collectHitRects() {
    var out = [];
    for (var i = 0; i < pets.length; i++) {
      var p = pets[i];
      var el = p.hitEl || p.el;
      if (!el || !el.getBoundingClientRect) continue;
      var r = el.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) continue;
var box = {
        left: r.left - HIT_PAD_X,
        top: r.top - HIT_PAD_TOP,
        right: r.right + HIT_PAD_X,
        bottom: r.bottom + HIT_PAD_BOTTOM,
      };
      // ⚠️ 形状是**又当裁剪用**的（主进程 SetWindowRgn），所以它必须罩住当前动画画出来的
      //   全部像素：拿 HIT_BOX 一条（只框角色）去报，动画里自带的气泡/火花就被切掉一截
      //   （「思考动画的气泡左右还是会被截断」）。所以并上 animInkBox(playing)。
      var ab = animInkBox(p.playing);
      if (ab && p.el && p.el.getBoundingClientRect) {
        var sr = p.el.getBoundingClientRect();
        if (sr && sr.width > 0) {
          var kx = sr.width / 640;
          var mg = INK_MARGIN * kx; // 采样余量只在这层加（几何层用它会让贴边白差 9px）
          box.left = Math.min(box.left, sr.left + ab.x0 * kx - mg - HIT_PAD_X);
          box.right = Math.max(box.right, sr.left + ab.x1 * kx + mg + HIT_PAD_X);
          box.top = Math.min(box.top, sr.top + ab.y0 * kx - mg);
          box.bottom = Math.max(box.bottom, sr.top + ab.y1 * kx + mg);
        }
      }
      // 气泡长在头顶（bottom:100%），可见时并进来
      var b = p.bubbleEl;
      if (b && b.classList && b.classList.contains("show")) {
        var br = b.getBoundingClientRect();
        if (br && br.width > 0) {
          box.left = Math.min(box.left, br.left - 6);
          box.right = Math.max(box.right, br.right + 6);
          box.top = Math.min(box.top, br.top - 6);
        }
      }
      // ⚠️ 必须先夹回窗内再报。主进程只会 Math.max(0, x) —— 它拿不到窗有多大，
      //   越界的矩形在它那边会被「推」到窗边：x=-200,w=260 变成 x=0,w=260，
      //   形状整体挪到左上角，那一块透明区就点不动了（宠物贴边/漫游到边上时真会发生）。
      //   窗外的部分本来也点不到，夹掉不亏。
      var vw = window.innerWidth || 0;
      var vh = window.innerHeight || 0;
      if (vw > 0) {
        box.left = Math.max(0, box.left);
        box.right = Math.min(vw, box.right);
      }
      if (vh > 0) {
        box.top = Math.max(0, box.top);
        box.bottom = Math.min(vh, box.bottom);
      }
      if (!(box.right > box.left) || !(box.bottom > box.top)) continue; // 整块在窗外
      out.push({
        x: quant2(box.left),
        y: quant2(box.top),
        width: Math.max(HIT_QUANT, quant2(box.right - box.left)),
        height: Math.max(HIT_QUANT, quant2(box.bottom - box.top)),
      });
    }
// 「掉线了」提示条长在屏幕右上角，不在宠物身上，一并算进去免得被裁掉
    var banner = document.getElementById(DISCONNECT_BANNER_ID);
    if (banner && banner.classList && banner.classList.contains("show")) {
      var rr = banner.getBoundingClientRect();
      if (rr && rr.width > 0) {
        var bx = quant2(rr.left) - 4;
        var by = quant2(rr.top) - 4;
        var bw = quant2(rr.width) + 8;
        var bh = quant2(rr.height) + 8;
        var bwMax = window.innerWidth || 0;
        var bhMax = window.innerHeight || 0;
        if (bwMax > 0) { bx = Math.max(0, bx); bw = Math.min(bw, bwMax - bx); }
        if (bhMax > 0) { by = Math.max(0, by); bh = Math.min(bh, bhMax - by); }
        if (bw > 0 && bh > 0) out.push({ x: bx, y: by, width: bw, height: bh });
      }
    }
    return out;
  }

  /** 真发一次：矩形没变就不发（省掉一次跨进程 + 一次 SetWindowRgn）。 */
  function emitHitRegion() {
    clampBubbles(); // 先把气泡夹回屏幕内，形状才算得准
    var api = window.__petElectron__;
    if (!api || !api.setHitRegion) return;
    var rects = collectHitRects();
    // 一只都算不出来（还没布局完）就别报：主进程收到空数组会保持上一次的形状，
    // 报上去反而可能把命中区清空。
    if (!rects.length) return;
    var key = "";
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      key += r.x + "," + r.y + "," + r.width + "," + r.height + "|";
    }
    if (key === lastRegionKey) return;
    lastRegionKey = key;
    lastRegionAt = Date.now();
    try {
      api.setHitRegion(rects);
    } catch (e) {
      /* 主进程还没 ready 就算了，下一次变化还会再报 */
    }
  }

  /**
   * 请求上报命中区。同一帧里的多次请求会合并，连续移动时按 HIT_THROTTLE_MS 节流。
   * ⚠️ 被节流挡掉的那次**必须补一个尾巴定时器**，否则这次移动就永远丢了：
   *   rAF 只在我们主动排下一次时才跑，不排就没有「下一帧」这回事。
   *
   * force=true = 无视「睡着了不报」（删掉一只宠物时必须报，否则形状留在老地方）。
   */
  function pushHitRegion(force) {
    if (asleep && !force) return; // 冻住时位置不变，形状也就不会变
    if (regionQueued || regionTimer) return;
    var wait = HIT_THROTTLE_MS - (Date.now() - lastRegionAt);
    if (wait <= 0) {
      regionQueued = true;
      var fired = false;
      var fallback = 0;
      var fire = function () {
        if (fired) return;
        fired = true;
        regionQueued = false;
        if (fallback) clearTimeout(fallback);
        emitHitRegion();
      };
      // rAF 不是保险的：窗只要有一阵子不合成帧（被另一只透明全屏窗盖住、屏保、锁屏、
      // 远程桌面断开），rAF 就一直不回调 —— 于是命中区永远发不出去，宠物看着好好的
      // 却点不动（主进程还停在 1×1 的起步形状）。所以 setTimeout 兜底，谁先到算谁。
      fallback = setTimeout(fire, 32);
      requestAnimationFrame(fire);
      return;
    }
    regionTimer = setTimeout(function () {
      regionTimer = null;
      pushHitRegion();
    }, wait);
  }

  /** 漫游时写样式/上报命中区的帧率上限（毫秒/帧）。全屏透明窗每改一次样式就得
   *  重合成一次（见 4.7），60fps 的漫游 = 每秒 60 次全屏重合成。 */
  var MOVE_FRAME_MS = 33;

  // ========================================================================
  // 4.6 位置记忆（拖到哪儿，下次启动还在哪儿）
  //
  // 以前拖完就丢：宠物下一次启动又回 config.jsonc 写死的那个角落，用户得每次重拖。
  // 现在：
  //   写：松手 → savePosition() → preload → 主进程 → /control set-position
  //        → 宿主落盘 home/positions.json（**比例** 0~1，不是像素：换分辨率/换屏幕
  //        之后仍落在同一个「地方」，而不是停在旧分辨率下的坐标上跑到屏外）
  //   读：窗连上 /ws 时宿主补发一帧 {"type":"positions",...}（老窗不认识 → 直接忽略）
  //        → applySavedPositions() 盖掉 config 的角落。
  // ⚠️ 只在「本次运行还没人拖过它」时套用：用户已经动过的宠物，不能被迟到的补发帧拽回去。
  // ========================================================================

  var savedPositions = {}; // id → {rx, ry}

/**
   * 位置记忆换算：r 是「窗内比例」，wOld 是存下去那会儿的窗宽，wNow 是现在的。
   *
   * ⚠️ 存比例是为了换分辨率/换显示器还能落在同一个「地方」（见 paths.cjs），
   *   但比例是**相对窗**的，而舞台窗的尺寸会变：这一版就把左右留白从 80 提到 200
   *   （622 → 862），老落点 rx=0.5797 套上去宠物就水平平移 (862-622)*0.58 = **139px**
   *   （用户看得见「启动后宠物自己跑了一边」）。
   *   修法：存的时候把当时窗宽一起存下来（可选字段，老记录没存就当没变过），
   *   套的时候换算回同一个**窗内绝对位置**：
   *     left = rx*W - halfW  要不变 ⇒  rx' = rx * W_old / W_new（halfW 两边抵消）。
   */
  function rescalePos(r, wOld, wNow) {
    var wo = Number(wOld);
    var wn = Number(wNow);
    if (!isFinite(wo) || !(wo > 0) || !(wn > 0)) return r;
    return (r * wo) / wn;
  }

  /** 把宿主给的位置套到宠物身上（按 id；单只且只有一条记录时允许借用，见下）。 */
  function applySavedPositions() {
    var keys = Object.keys(savedPositions || {});
    if (!keys.length || !pets.length) return;
    for (var i = 0; i < pets.length; i++) {
      var p = pets[i];
      if (!p || p.movedLocally || p.destroyed) continue;
      var pos = savedPositions[p.id];
      // config.jsonc 里的 id 被改过时位置会认不出来。只有**单只 + 只有一条记录**才借：
      // 多条记录时猜（拿 keys[0]）会把宠物放到别的只记住的地方去，那更糟。
      if (!pos && pets.length === 1 && keys.length === 1) pos = savedPositions[keys[0]];
      if (!pos) continue;
p.customPos = { rx: rescalePos(Number(pos.rx), Number(pos.w), window.innerWidth), ry: rescalePos(Number(pos.ry), Number(pos.h), window.innerHeight), w: window.innerWidth, h: window.innerHeight };
      if (typeof p.applyPosition === "function") p.applyPosition();
    }
    pushHitRegion(); // 位置变了 = 命中区变了（宠物挪走了，得跟着走）
  }

  /** 记住一只的落点（拖拽松手时调）。没有桥（浏览器里直接看）就静默跳过。 */
  function savePosition(pet) {
var api = window.__petElectron__;
    if (!api || !api.savePosition || !pet || !pet.customPos) return;
    try {
      // 窗宽/窗高一起存（见 rescalePos）：下次窗变大/变小，宠物才不会被比例拽走。
      api.savePosition(pet.id, pet.customPos.rx, pet.customPos.ry, window.innerWidth, window.innerHeight);
    } catch (e) {
      /* 主进程还没 ready —— 下次拖就存上了 */
    }
  }

  /**
   * Electron 里的「拖宠物」和「挪容器」是两回事：
   *   窗只包住宠物（见 pet-electron.cjs 文件头），所以拖 = 搬窗（moveWin 有值）。
   *   浏览器里没有窗可搬，就退回「在视口里挪容器」（moveWin 为 null）。
   * 两个口都在就优先搬窗：漫游/站位已经在窗内完成了，不搬窗用户就没法把宠物
   * 放到别的显示器上去。
   */
  var moveWin = (window.__petElectron__ && window.__petElectron__.moveWindow) || null;
  var endWinDrag = (window.__petElectron__ && window.__petElectron__.endWindowDrag) || null;

// ========================================================================
  // 4.7 省电 / 看不见时别产生帧（别抢别的窗口的渲染预算）
  //
  // 症状：这扇窗是**全屏透明 + 置顶**的。它每产生一帧，DWM 就得把整块桌面重新合成一遍
  // （连带下面所有窗口一起）。画面没人看的时候，就该彻底停下来：
  //   · 主进程喊：窗被最小化 / 隐藏 / 屏保锁屏 / 系统挂起 → 睡（pet:power，见 pet-electron.cjs）。
  //   · 页签被切走（浏览器里打开的宠物页）→ 睡。
  //   · 手动省电模式（power 帧 / `/control {"action":"power-save"}`）→ 无条件睡。
  // 冻住 = 视频 pause()、漫游的 rAF 停、命中区不再上报。逻辑（定时器）还留着，
  // 醒来时状态机还在原地，不会有「要重新选一段动画」的突变。
  //
  // ⚠️ 这里**不再有「空闲 N 秒自动冻住」**（原 timing.idleSleepMs，已按用户意见拿掉）：
  //   宠物就该一直动，空闲也照常放。省电只由用户显式开，或窗真的看不见时自动发生。
  //
  // 睡 ≠ 暂停响应（那个是「不理 agent 状态」）：省电时气泡文字照常更新，
  // 只是没有新帧而已。
  // ========================================================================

var asleep = false;    // 冻住了吗（= 一帧都不再产生）
  var powerSave = false; // 用户手动开的省电模式：除了关掉它，谁都叫不醒

  /**
   * ⚠️ 省电“冻住/隐藏”总闸（2026-10 屏蔽）：**关掉就永远不冻**。
   *
   * 四个触发源全都汇进 goSleep（窗 hide/minimize、powerMonitor 锁屏/挂起、
   *  document.visibilitychange、powerSave 帧），所以一道闸就够：
   *   · visibilitychange：这扇是透明置顶常驻窗，Chromium 判不判 hidden 很看
   *     遮挡情况 —— 判成 hidden 就冻住，而「唤醒」只能等下一次可见，偶发就
   *     再也醒不过来（用户看到的「宠物自己不见了」）；
   *   · lock-screen / suspend 同理：事件不来或对不上就永久冻着。
   * 代价是看不见时仍在解码 WebM（见 4.7 的说明）。改回 true 即恢复。
   */
  var SLEEP_ENABLED = false;

  /** 睡：所有宠物冻在当前帧。
   *  ⚠️ 不因为「已经 asleep」就早退：省电模式下新加一只宠物时，它照样得冻住
   *  （PetCard.sleep/wake 自己幂等，这里只是多走一遍）。
   */
  function goSleep() {
    if (!SLEEP_ENABLED) return;
    asleep = true;
    for (var i = 0; i < pets.length; i++) {
      if (pets[i] && typeof pets[i].sleep === "function") pets[i].sleep();
    }
  }

  /** 醒：接着当前这一帧往下放（pause/play 不改 currentTime，不会跳回第一帧）。
   *  省电模式下醒不了 —— 唯一出口是 applyPowerFrame(false)（用户关掉省电）。 */
  function goWake() {
    if (powerSave) return goSleep();
    asleep = false;
    for (var i = 0; i < pets.length; i++) {
      if (pets[i] && typeof pets[i].wake === "function") pets[i].wake();
    }
}

  // ========================================================================
  // 5. PetCard class (port of pet.ts PetCard component)
  // ========================================================================

  /** Shared config (loaded from /config.jsonc + WebSocket update) */
  var config = null;

function PetCard(cfg, rootEl, slot) {
    var self = this;
    this.cfg = cfg;
    // 多开时在舞台里第几格（§9.26 的居中/错位）：构造时传进来，别在 applyPosition 里
    // 反查 pets —— 构造那一刻 self 还没进数组（indexOf = -1），第一只会被摆到最左。
    this.slot = Math.max(0, Number(slot) || 0);
    // 尺寸只认 petSizeOf（height 优先 / size 兜底）：别处再读一次 cfg.size 就又一份算法
    this.size = petSizeOf(cfg);
    this.facing = "left";
    this.facingRef = "left";

    // ---- Derived ----
var halfW = this.size / 2;
    var halfH = (this.size * 9) / 16 / 2;
    // ---- 可见框（§9.27）----
    // 动画画布里角色只占中间 37.5%（HIT_BOX 量出来的），所以「容器宽」≠「角色宽」。
    // 横向的几何（夹取、贴边、居中、漫游道）一律按**角色**算，否则屏幕上永远差一截
    // 透明边（实测：容器贴到屏边 x=0，可见 ink 还在 x=153）。纵向仍旧按舞台（脚底对齐那套）。
    var inkW = inkWidth(this.size);   // 角色可见宽
    var inkHalf = inkW / 2;           // 角色中心到容器中心的距离（可见框居中 ⇒ 就是 halfW）
    var inkOff = INK_X0 * this.size;  // 可见框左边 = 容器左边 + inkOff

    /**
     * 横向要保证「不越出窗」的那一段（px，相对容器左边）：角色可见框 ∪ **当前动画**可见框。
     *
     * ⚠️ 为什么要把动画的框也算进来（§9.28）：形状（SetWindowRgn）报多宽，窗外那截就被裁掉；
     *   而窗宽是固定的，于是宠物贴近窗边时，画出来的那截像素（思考气泡 93..551、蝴蝶 4..629）
     *   必然有一边跑到窗外被切 —— 用户口径「右侧还是展示不全」。
     *   两害相权：宁可宽动画播放时宠物往里挪一点，也不切像素。
     *   待机/走路这类窄动画的框本来就没超角色框 ⇒ inkSafe() 就等于角色可见框，
     *   §9.27 的「左右贴边」行为**一字不变**。
     */
    function inkSafe() {
      var s = self.size / 640;
      var b = animInkBox(self.playing);
      var x0 = HIT_BOX.x0, x1 = HIT_BOX.x1;
      if (b) {
        x0 = Math.min(x0, b.x0);
        x1 = Math.max(x1, b.x1);
      }
      return { off: x0 * s, w: (x1 - x0) * s };
    }

    /** 量出更宽的可见框之后重夹一次位置：不动的话，宽出来的那截就在窗外被裁掉了。
        夹取以**角色**可见框当前的位置为入参 ⇒ 角色不跳，只是整只往里挪。 */
    this.refitInk = function () {
      if (!container.getBoundingClientRect) return;
      var r = container.getBoundingClientRect();
      if (!(r.width > 0)) return;
      var m = clampPos(r.left + inkOff, r.top);
      if (Math.abs(m.left - r.left) > 0.5) {
        container.style.left = Math.round(m.left) + "px";
        container.style.right = "auto";
        clampBubbles();
        // ⚠️ 位置记忆必须跟着改（同 applyPosition）：currentCenterX/Y（漫游起点）读的是
        //   customPos.rx*W，不回写的话它还记着「夹之前」那个点 —— 下一次走路起手先跳回
        //   旧位置、窗一 resize 也会用 applyPosition 弹回原地（宽动画的像素又被顶出窗外）。
        //   语义同 applyPosition：存**实际落点**，不是计划点。
        if (self.customPos) {
          self.customPos.rx = (m.left + halfW) / window.innerWidth;
          self.customPos.ry = (m.top + halfH) / window.innerHeight;
        }
      }
      pushHitRegion();
    };

    /**
     * 把容器位置夹回屏幕内。不夹的话宠物能被拖到只剩半个身子在屏幕里（头顶的气泡
     * 跟着出屏，再被主进程的 SetWindowRgn 裁一刀，看着就像「气泡被切了一半」）。
     * extraBottom = 舞台额外的下移量（站位对齐脚底用的），算下边界时算进去。
     *
     * ⚠️ left 进的是**可见框**左边（调用方传「中心 − 可见半宽」），出的是**容器**左边
     *   —— 样式只能写容器左边。省一次换算的机会，但反过来算错就是「贴边差 144px」，
     *   而那种错看着还挺像正常（就差一点），所以固定成「进可见框、出容器」。
     * ⚠️⚠️ 纵向 **0 起夹**（§9.28）：以前下界是 topOffsetOf（150），上边必须给气泡留台子，
     *   结果就是「左右能贴边了、上下贴不上」。现在两头都 0 起夹：宠物能真的贴到屏幕上/下边，
     *   代价是贴上边时头顶没有空间 —— 那时气泡改成**盖在头顶上**（见 clampBubble），
     *   而不是被压成 24px 的一条。
     */
    function clampPos(inkLeft, top) {
      // 横向夹的是「角色 ∪ 当前动画」的可见框（inkSafe），所以宽动画的像素不会跑出窗；
      // 窄动画下 inkSafe 就等于角色可见框，退回 §9.27 那套贴边行为。
      var safe = inkSafe();
      var safeLeft = inkLeft - inkOff + safe.off;
      safeLeft = Math.min(Math.max(safeLeft, 0), Math.max(0, window.innerWidth - safe.w));
      // 容器底 = 脚底（stage 有 translateY(bottomPad) 把脚下那段透明留白顶下去，见 §9.22），
      // 所以下界就是「容器底贴窗底」：不再减 bottomPad，宠物才能贴到屏幕最下边。
      var maxTop = Math.max(0, window.innerHeight - halfH * 2);
      return {
        left: safeLeft - safe.off,
        top: Math.min(Math.max(top, 0), maxTop),
      };
    }

    // ---- State ----
    this.anim = "";
    this.once = true;
    this.seq = 0;
    this.customPos = null; // {rx, ry}
    this.id = cfg.id;       // 位置记忆的键（和宿主 home/positions.json 对齐）
    this.movedLocally = false; // 本次运行里用户自己拖过：之后就别再用宿主补发的位置覆盖它
    this.dragging = false;
    this.overrideAnim = null;  // WS-driven temporary override
    this.overrideTimer = null;
    this.currentOverrideAnim = null; // Name of active WS override (for click-during-override)
    this.overrideActive = null;     // Name currently looping as override (anti-replay)
    this.clickFromOverride = false;  // flag: click happened during override
    this.hovering = false;           // 鼠标是否在命中框里
    this.hoverAnim = "";             // 本次 hover 放的动画名
    // 节奏三件套：playing=屏幕上真正在放的那一段，playedAt=它开始播的时刻。
    // ⚠️ 判定「屏幕上是什么」一律用 playing，别用 self.anim —— anim 是**链子刚决定**的名字，
    // 切换被门禁挡下来的时候两者会差一段（那时 anim 已经是下一个了，屏幕还在放上一个）。
    this.playing = "";               // 正在显示的动画名
    this.playedAt = 0;               // playing 开始播放的时刻（0 = 还没播过）
    this.queued = null;              // 被最小播放时长挡下来的切换请求 {anim, once}
    this.queuedTimer = null;
    this.dwellTimer = null;          // 待机停留计时器
    this.destroyed = false;
    this.asleep = false;             // 冻住（见 4.7）
    this.asleepNext = null;          // 冻住期间「该演哪一段」，醒来补上

    // ---- Refs ----
    this.gen = 0;
    this.pending = null;   // {anim, once, gen}
    this.frontIdx = 0;     // 0 or 1
    this.moveRef = null;
    this.moveToken = 0;
    this.pendingMove = null;
    this.justDragged = false;

    var dragState = { active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 };

    // ---- Build DOM ----
    var container = document.createElement("div");
    container.className = "pet-container";
    container.setAttribute("data-pet-id", cfg.id);

    var stage = document.createElement("div");
    stage.className = "pet-stage";

    var videoA = document.createElement("video");
    videoA.className = "pet-video is-front";
    videoA.muted = true;
    videoA.playsInline = true;

    var videoB = document.createElement("video");
    videoB.className = "pet-video";
    videoB.muted = true;
    videoB.playsInline = true;

    var hit = document.createElement("div");
    hit.className = "pet-hit";

    stage.appendChild(videoA);
    stage.appendChild(videoB);
    stage.appendChild(hit);

    container.appendChild(stage);
    rootEl.appendChild(container);
    self.el = container; // 定位/漫游时用来量包围盒
    self.hitEl = hit; // 命中区上报用真正能点的那块（见 4.5）

    // ---- Position (corner-based initial) ----
    applyPosition();
    pushHitRegion();
window.addEventListener("resize", function () {
      // ⚠️ 每次 resize 都要重新摆位（§9.26）
      //   而窗宽是拿到配置之后才报上去的（构造宠物时窗还是主进程那个 620 默认值）。
      //   只在有位置记忆时重摆的话，「刚摆好」的宠物会停在 620 上算出来的位置：
      //   实测窗涨到 822 之后宠物还留在 left=79（左右留白 79/281，不居中）。
      //   有记忆的按记忆夹回去（stageKeepIn），没记忆的回到舞台正中。
      applyPosition();
      // 窗一变，气泡的可用空间和对齐全变了（头顶行数、左右放不放得下）：重新夹一次。
      // 不夹的话，气泡会保持旧的位置 —— 窗从 620 缩到 566 那一下，右边就少一截，
      // 句子末尾直接被窗边切掉（§9.21 实测）。
      clampBubbles();
      // ⚠️ 必须 force：窗一变（启动时按配置长大、往上长、显示器/DPI 变化）布局就重排，
      //   冻住的宠物位置不变，但**别的**东西动了（头顶空出来的气泡区、漫游目标重算），
      //   形状留在老地方 = 那一块点不到、宠物身上反而点不动（见 §9.21）。
      pushHitRegion(true);
    });

    function applyPosition() {
if (self.customPos) {
        var cp = self.customPos;
        // 横向夹的是「角色 ∪ 当前动画」的可见框（§9.28）：靠边时宽动画画出来的像素也得到窗里，
        //   不能只在漫游/拖拽时才保证（老落点照样会把思考气泡的左侧顶到窗外）。
        //   overhang = art 比角色框往左多出来的那截；art 不比角色宽时它就是 0 ⇒ 与旧行为一致。
        var safe = inkSafe();
        var over = inkOff - safe.off;
        var keep = stageKeepIn(cp.rx * window.innerWidth - inkHalf + over, cp.ry * window.innerHeight - halfH, safe.w, halfH * 2);
        container.style.left = keep.left - over - inkOff + "px";
        container.style.top = keep.top + "px";
        container.style.right = "auto";
        container.style.bottom = "auto";
        // 夹完把内存里的落点也改回实际值：不改的话漫游起点（currentCenterX/Y 读的是
        // customPos）会从「夹之前」那个点算，宠物在窗里先跳一下再走。
self.customPos.rx = (keep.left + inkHalf) / window.innerWidth;
        self.customPos.ry = (keep.top + halfH) / window.innerHeight;
        return;
      }
container.style.removeProperty("top");
      container.style.removeProperty("bottom");
      container.style.removeProperty("left");
      container.style.removeProperty("right");
      var corner = cfg.position.corner;
      // ---- 横向一律居中（§9.26）----
      // 以前按 corner 写 `right/left = marginX`：窗宽自适应之后（动画宽 + 余量 + 漫游行程），
      // 贴一侧摆位会让**另一侧空出一整块**（实测 size 462 / 窗 822：右边贴 24 时左边空 336），
      // 用户看着就是「舞台歪着、有一大块没用上」。现在两侧留白对称，舞台才叫舞台。
      // corner 的 left/right 两支不再决定窗内位置（窗在屏幕哪一侧由窗的位置记忆决定）。
// ⚠️ 居中算的是**可见框**（§9.27）：舞台里左右各 144px 是透明的，按舞台居中
      //   就等于按「角色外面一圈空地」居中，贴边时那圈空地正好留在屏幕边上。
container.style.left = centeredLeft(inkW, self.slot, Math.max(pets.length, self.slot + 1)) - inkOff + "px";
      // 纵向还由 corner 决定（top-* 贴上、bottom-* 贴下），这个别动：
      //   头顶那截是气泡的舞台（topOffsetOf），底下是脚下留白（marginY）。
      if (corner === "bottom-right" || corner === "bottom-left") { container.style.bottom = cfg.position.marginY + "px"; }
      else { container.style.top = topOffsetOf(cfg) + "px"; }
    }
    self.applyPosition = applyPosition; // 位置记忆套用时要重新贴位（见 4.6）

    // ---- Stage size ----
    stage.style.width = this.size + "px";
    stage.style.height = (this.size * 9) / 16 + "px";

    // ---- Floor alignment ----
    var bottomPad = (this.size * (9 / 16) * (CANVAS_H - FEET_Y)) / CANVAS_H;
    stage.style.transform = "translateY(" + bottomPad + "px)";

    // ---- Hit area ----
    hit.style.left = (HIT_BOX.x0 / 640) * 100 + "%";
    hit.style.top = (HIT_BOX.y0 / 360) * 100 + "%";
    hit.style.width = ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100 + "%";
    hit.style.height = ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100 + "%";

    // ---- Electron mouse passthrough ----
    // 正常路径：主进程用 setShape 把命中区裁到宠物身上，这里不用管穿透。
    // 老 Electron（没有 setShape）才走开关式：进命中框收事件、离开穿回去。
    var passthrough = true;
    function setPassthrough(on) {
      if (passthrough === on) return;
      passthrough = on;
      if (window.__petElectron__) {
        window.__petElectron__.setPassthrough(on);
      }
    }

    /**
     * 鼠标移入 = 打招呼（hover 动画），移出 = 收回。
     * 不打断：拖拽中 / 正在响应 agent（override）/ 正在放点击回应。
     *
     * ⚠️ 移入是**用户自己动的**，立刻播（不然打招呼要等两秒才反应过来）；
     * 移出是**被动**的，走门禁 —— 不许把屏幕上正演到一半的动作砍掉（老实现就是
     * 一移出鼠标立刻换回待机动画，动画没演完就被切掉，观感上就是「待机太短」）。
     */
    this.setHover = function (on) {
      if (self.hovering === on) return;
      self.hovering = on;
      var hover = config.animations.hover;
      if (!hover || !hover.length) return;

      if (on) {
        if (dragState.active || self.dragging || self.currentOverrideAnim || self.clickFromOverride) return;
        if (config.animations.clicks.indexOf(self.playing) >= 0 || hover.indexOf(self.playing) >= 0) return;
        self.stopDwell();
        self.stopMove();
        self.hoverAnim = pick(hover, self.anim);
        self.anim = self.hoverAnim;
        // once=false：hover 不算「一次性反应动画」，所以不会把左键点击也一并禁掉
        self.once = false;
        self.seq++;
        self.switchTo(self.hoverAnim, true, { force: true }); // 播一遍就好，不循环
      } else {
        // 还在放 hover 就回待机，但**别从中间砍**：门禁会等这一段放完再换
        if (self.hoverAnim && self.playing === self.hoverAnim && !self.currentOverrideAnim && !dragState.active) {
          self.hoverAnim = "";
          if (config.animations.idle.length) {
            self.anim = pick(config.animations.idle, self.anim);
            self.once = true;
            self.seq++;
            self.switchTo(self.anim, true);
          }
        }
      }
    };

hit.addEventListener("mouseenter", function () {
    self.grabbed = ""; self.grabAnim(); // 手还没按上就先解好拖拽姿势
    gestureSay("hover", 2600, self); // 移入打个招呼（池子空就静默）
      setPassthrough(false);
      hit.style.cursor = "grab";
      self.setHover(true);
    });
hit.addEventListener("mouseleave", function () {
      setPassthrough(true);
      hit.style.cursor = "";
      self.setHover(false);
    });

    // ---- Right-click → menu ----
    // The menu itself is native (built in the main process) because the window is a
    // transparent click-through overlay — an in-page menu would fight the passthrough.
    // It only needs to say "what state am I in"; every action goes through the host's
    // control API, so the menu and pi/dsh/curl all drive the same state owner.
    hit.addEventListener("contextmenu", function (e) {
e.preventDefault();
      if (!window.__petElectron__ || !window.__petElectron__.openMenu) return;
      bubbleTarget = self;
      window.__petElectron__.openMenu({
        state: describeState(self),
        size: self.size,
        facing: self.facing,
        pets: pets.length,
      });
    });

// ---- 气泡栈 + 手动输入（§9.34）----
    // 状态文案、人打的字、自己冒的碎碎念全都走这里。它**不是** v1 线格式的一部分：
    // 宿主发 {"type":"bubble",...}，窗只负责渲染，老窗照旧忽略这帧。
    //
    // ⚠️ 改成「一摞」而不是「一个复用的框」：每条消息一个 .pet-bubble，新的一条在**下面**，
    //   老的被顶上去（看着就是滚动），同时最多留 BUBBLE_MAX(3) 条 —— 再多就把最老的收摊。
    //   宽度**定死**（--bubble-w，见 applyBubbleWidth）：以前是 max-content，气泡宽度跟着
    //   文案变 → 折行变 → 夹取算出的偏移变 → 每来一句话气泡就横向跳一下（用户口径
    //   「气泡框丑、位置乱动」）。定宽之后几何只跟宠物位置有关，它钉在头顶不动。
    var stack = document.createElement("div");
    stack.className = "pet-bubble-stack";
    container.appendChild(stack);
    self.bubbleEl = stack; // 命中区要把整摞气泡算进去（collectHitRects 看它有没有 .show）
    /** 活着的消息气泡：下标越大越新 = 越靠下。 */
    var bubbles = [];

    function stackEmpty() {
      return bubbles.length === 0 && !inputOpen;
    }

    /** 头顶**实测**能放下几条（§9.34）：每条至少「一行字 + 上下内边距 + 间隙」。
        BUBBLE_MAX 只是上限，真留几条看头顶有多少 —— 贴上边、窗口小的时候自动降。
        为什么不用「分摊高度」硬撑：分摊下来每条只剩 20px，**字被裁掉半行** ——
        裁半行比少一条难看得多。 */
    function fitCount() {
      var cr = container.getBoundingClientRect();
      var roomAbove = Math.max(0, Math.round(cr.top - BUBBLE_CHROME_H));
      if (roomAbove < BUBBLE_LINE_H * 2) return 1; // 头顶不够两行 → 走「盖头顶」那档，不分摊
      var per = BUBBLE_MIN_H + BUBBLE_GAP_PX;
      return Math.max(1, Math.min(BUBBLE_MAX, Math.floor((roomAbove + BUBBLE_GAP_PX) / per)));
    }

    /** 留多了就收最老的（先淡后摘，动画跟 dropBubble 走）。 */
    function trim() {
      while (bubbles.length > fitCount()) dropBubble(bubbles[0]);
    }

    /** 收掉一条：先淡出，动画走完再摘节点（直接 remove 就没有那一下淡出了）。 */
    function dropBubble(el) {
      if (!el || el.parentNode !== stack) return;
      if (el._timer) {
        clearTimeout(el._timer);
        el._timer = 0;
      }
      var i = bubbles.indexOf(el);
      if (i >= 0) bubbles.splice(i, 1);
el.classList.remove("show", "has-tail");
      el.classList.add("gone");
      stack.classList.toggle("show", !stackEmpty());
      setTimeout(function () {
if (el.parentNode) el.parentNode.removeChild(el);
        ageAll(); // 少了一条 ⇒ 剩下的都往前排一档（变亮一点）
        markTail(); // 底下那条收了，尾巴得挪到现在的最后一条上
        self.clampBubble(); // 条数少了 ⇒ 剩下的能分到更多行，重新分一次高
        pushHitRegion();
      }, 200);
    }

/** 尾巴只长在最底下那一条上（气泡栈看着才像一句话的尾巴，而不是一堆箭头）。
        ⚠️ 输入框开着时不长尾巴：它就贴在输入框正上方，一支箭插在输入框里比没有更怪。 */
    function markTail() {
      var last = bubbles.length - 1;
      for (var i = 0; i < bubbles.length; i++) {
        bubbles[i].classList.toggle("has-tail", i === last && !inputOpen);
      }
    }

    /** 越老越退后（§9.34）：最新的满亮，老的一条按档位变淡（文字 + 底色一起）。
        淡的是 `--fade`，不动 opacity —— opacity 是入场动画用的（.show），抢它就闪。 */
    var AGE_FADE = [1, 0.72, 0.5, 0.34, 0.22] // 5 档对上 BUBBLE_MAX;
    function ageAll() {
      for (var i = 0; i < bubbles.length; i++) {
        var slot = bubbles.length - 1 - i; // 0 = 最新
        bubbles[i].style.setProperty("--fade", String(AGE_FADE[slot] == null ? AGE_FADE[AGE_FADE.length - 1] : AGE_FADE[slot]));
      }
    }

/** FLIP（§9.34）：新的一条进来，老的会**被顶上去** —— 但布局一变就是瞬间到位，
        看着是「跳」。所以插入前先量一遍各自的位置，插入后算差多少，用 transform 把它们
        放回原处，下一帧撤掉 transform ⇒ 浏览器自己补一段上移动画。
        ⚠️ 只动 transform：动 top/height 没有过渡可补（那是布局，不是动画）。
⚠️ 曲线与入场分开（cubic-bezier(0.22,0.78,0.26,1)、比入场慢一档）：老的上推是
        「被挤上去」，该慢而稳；入场是「新冒出来」，该快。
        时长按**上推多远**缩放：被顶得越高，走得越久（远远的那条一眼能跟上），
        就近的（差 6px）快快让一下就够 —— 一律 0.26s 的话，近的拖着尾巴、远的赶不上。 */
    function flipFrom(tops) {
      for (var i = 0; i < tops.length && i < bubbles.length; i++) {
        var el = bubbles[i];
        var dy = tops[i] - el.getBoundingClientRect().top;
        if (!dy) continue; // 本来就没动（第一条 / 高度没变）—— 别白跑一次过渡
        // ⚠️ 第一帧必须**禁掉过渡**：否则「拉回原位」这一步自己也会补一段动画，
        //   两段接起来 = 老的气泡先往下坠一下再上去（实测会闪）。
        el.style.transition = "none";
        el.style.transform = "translateY(" + dy + "px)";
        (function (e2, dist) {
          // 120ms 起步，每 10px 加 30ms，上封 420ms（顶一整条很高时才封顶）
          var ms = Math.min(420, 120 + Math.round(Math.abs(dist) * 3));
          requestAnimationFrame(function () {
            e2.style.transition = "transform " + (ms / 1000) + "s cubic-bezier(0.22, 0.78, 0.26, 1)";
            requestAnimationFrame(function () {
              e2.style.removeProperty("transform");
              // 过渡走完把内联曲线撤掉（回到样式表的入场曲线）；兜底 ms + 120：
              // 过渡被打断（又来一条）时不留残值。
              var done = function () {
                e2.style.removeProperty("transition");
              };
              e2.addEventListener("transitionend", done, { once: true });
              setTimeout(done, ms + 120);
            });
          });
        })(el, dy);
      }
    }

    /** 气泡贴到屏幕边（宠物拖到边角）时把它挪回来，不然半边在屏幕外 = 看着被切了一半。
        偏移走 left/bottom（不在 transition 里，改完立刻到位，不会一边补一边抖）。
        ⚠️ 量的是**整摞**（stack），不是单条：位置是这一摞共同的，夹一次就够。 */
    self.clampBubble = function () {
      if (stackEmpty()) {
        stack.style.removeProperty("left");
        stack.style.removeProperty("bottom");
        return;
      }
      var r = stack.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) return;
      var W = window.innerWidth;
      var H = window.innerHeight;

      // ---- 高度：按头顶**真实**空间收（§9.21），且**恒在头顶**（§9.27）----
      // 以前高度交给 CSS 的「最多几行」：宠物贴上边时头顶只有 marginY 那么点，一行都塞不下。
      // 现在按容器顶到窗顶的距离算能塞几行，写 max-height + 行数，两个方向都封死。
      //
      // ⚠️⚠️ 不再「头顶不够就翻到身下」（§9.25 那支实测后删掉了）：身下那侧**永远**不够 ——
      //   脚下只有 bottomPad 60 的余量，翻下去等于把气泡塞进一条 60px 的缝里，字被裁成
      //   两行还压着脚。现在高度只按头顶空间收；真的贴到屏幕上边（头顶 0）时**不封高**
      //   （§9.28）—— 气泡盖在头顶上，字全都在。
      var cr = container.getBoundingClientRect();
      var roomAbove = Math.max(0, Math.round(cr.top - BUBBLE_CHROME_H));
      // 头顶放不下两行 → 放弃「按空间封高」，改盖在头顶上（见下面的 overlap 分支）。
      // 不封高的话 max-height 只剩下限，气泡是一条 24px 的东西，字全裁没。
var overlap = roomAbove < BUBBLE_LINE_H * 2;
      if (!overlap) {
        trim(); // 贴到边上 / 窗口变小 ⇒ 头顶不够了，先收几条再分（顺序不能反）
        // 一摞的话要**分**：N 条 + N−1 个间隙，头顶那点地方平均分给每条。
        // N 已按 fitCount 收敛（留不下的早收了），所以分下来每条至少一行字。
        var n = bubbles.length + (inputOpen ? 1 : 0);
        var room = Math.max(BUBBLE_MIN_H, Math.floor((roomAbove - BUBBLE_GAP_PX * Math.max(0, n - 1)) / n));
        for (var i = 0; i < bubbles.length; i++) {
          var b = bubbles[i];
          b.style.maxHeight = room + "px";
          b.style.webkitLineClamp = String(Math.max(1, Math.min(6, Math.floor((room - 14) / BUBBLE_LINE_H))));
        }
      } else {
        for (var j = 0; j < bubbles.length; j++) {
          bubbles[j].style.removeProperty("max-height");
          bubbles[j].style.removeProperty("-webkit-line-clamp");
        }
      }
      cr = container.getBoundingClientRect(); // 上面被写样式弄脏了？重拿一份干净的（下方 baseL/baseT 用它）

      // ⚠️⚠️ 高度写完之后**必须重新量**：上面那一步会改变几何 —— max-height / 行数一变，
      //   文字重新折行，**宽度也跟着变**。拿旧几何算 dx/dy = 把气泡夹在旧位置上
      //   （实测贴右边时探出窗边 40px，而 showBubble 那次「下一帧再夹」也救不回来）。
      //   这里量的是布局，代价可以忽略。
      r = stack.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) return;

      // ⚠️⚠️ 偏移是**绝对**的，不是增量（实测踩过的坑：算增量、写绝对）。
      //   写下去的是 `left: calc(50% ± X)` —— X 是相对「容器水平居中位」的**总偏移**，
      //   每次写都把上一次的 X 顶掉。而「差多少」的算法（dx = 8 - r.left）算的是增量：
      //   容器一动气泡跟着平移，于是每次只补回一部分，永远夹不准。
      //   正确算法：先把「X=0 时这一摞的绝对左边」算出来，再把想要的绝对位置减掉它。
      var baseL = cr.left + (cr.width - r.width) / 2;
      // 竖向的「居中位」= 头顶那套 bottom:100% + margin-bottom 10px（pet.css；
      // 忘了算这个 10px，偏移就会恒差 10px）。
      var baseT = cr.top - BUBBLE_GAP - r.height;
      var wantL = r.left;
      var wantT = r.top;
      if (wantL < 8) wantL = 8;
      else if (r.right > W - 8) wantL = W - 8 - r.width;
      // 越界只有两种：顶出窗顶、掉出窗底（后者只在没封高、盖在头顶上的那档可能出现）。
      if (r.top < 8) wantT = 8;
      else if (r.bottom > H - 8) wantT = H - 8 - r.height;
      var dx = Math.round(wantL - baseL);
      var dy = Math.round(wantT - baseT);
      // 写一样的值没有代价，但每帧都写新值会让浏览器白排一次版
      if (!dx) stack.style.removeProperty("left");
      else stack.style.left = "calc(50% + " + dx + "px)";
      if (!dy) stack.style.removeProperty("bottom");
      else stack.style.bottom = "calc(100% " + (dy > 0 ? "- " : "+ ") + Math.abs(dy) + "px)";
      stack.style.removeProperty("top");
    };

    /**
     * 冒一条。sticky = 状态还在（宿主每 10s 续期一帧）：全局只留**一条** sticky，
     * 新状态来了旧的立刻收摊 —— 状态是「当前是什么」，不是聊天记录。
     */
    self.showBubble = function (text, opts) {
      opts = opts || {};
      var t = String(text == null ? "" : text).trim();
      if (!t) return;
      // sticky（「思考中…」这类状态气泡）全局互斥：任何后续消息（新状态 / 空闲文案 /
      // 手动 say）都顶掉旧的 sticky —— 否则状态回 idle 后那条 sticky 没有计时器，永远挂着。
      // 唯一例外：同一句的续期帧，留着续命（下面 dup 分支处理）。
      for (var s = bubbles.length - 1; s >= 0; s--) {
        if (bubbles[s].classList.contains("sticky") && !(opts.sticky === true && bubbles[s].getAttribute("data-text") === t)) {
          dropBubble(bubbles[s]);
        }
      }
      // 同一句已经泡着（续期帧 / 重复事件）→ 不再堆一条，直接续命。
      var dup = null;
      for (var d = 0; d < bubbles.length; d++) if (bubbles[d].getAttribute("data-text") === t) dup = bubbles[d];
      if (dup) {
        if (opts.sticky === true) dup.classList.add("sticky");
        var dm = Number(opts.ms) || 0;
        if (dup._timer) { clearTimeout(dup._timer); dup._timer = 0; }
        if (opts.sticky !== true && dm > 0) {
          var target = dup;
          dup._timer = setTimeout(function () { dropBubble(target); }, dm);
        }
        return;
      }

      var b = document.createElement("div");
      b.className = "pet-bubble";
      b.classList.toggle("sticky", opts.sticky === true);
      b.setAttribute("data-text", t);
      // 文案单独占一个节点：以后要在同一条里挂输入框/别的，直接改 bubble.textContent 会把它删掉。
      var span = document.createElement("span");
      span.className = "pet-bubble-text";
      span.textContent = t;
b.appendChild(span);
      // 插入前量一遍老的位置（FLIP 的 First），插入点在输入框**之上** ——
      // 否则新消息会排到输入框下面，把正在打的字顶走。
      var tops = [];
      for (var t = 0; t < bubbles.length; t++) tops.push(bubbles[t].getBoundingClientRect().top);
      stack.insertBefore(b, inputOpen ? inputRow : null);
      bubbles.push(b);
      // ⚠️⚠️ .pet-bubble 基础样式就是 opacity:0，**只有 .show 才可见**（pet.css）。
      //   成栈那版（3573710）漏了这行 ⇒ 每条消息气泡全透明（用户口径「气泡还是没有」）。
      //   放下一帧补，入场过渡（opacity/transform 0.2s）也才跑得起来；
      //   补之前已经被收掉的（gone）就别再点亮，否则淡出到一半又亮了。
      requestAnimationFrame(function () {
        if (b.parentNode === stack && !b.classList.contains("gone")) b.classList.add("show");
      });
markTail();
      ageAll();
      trim(); // 头顶放不下的先收掉（宁可少几条，也不要裁半行字）
      flipFrom(tops);
      while (bubbles.length > BUBBLE_MAX) dropBubble(bubbles[0]); // 上限保险
      stack.classList.add("show");
      self.clampBubble();
      // 再夹一次：刚 show 出来那下量到的可能是**上一条文案**留下的布局（宽度、行数
      // 都还没按新文案排完）。下一帧再夹一次就稳了 —— 这是布局，不是动画，代价可以忽略。
      requestAnimationFrame(function () { self.clampBubble(); });
      pushHitRegion(); // 气泡会改变命中区（它在宠物头顶）
      // sticky = 状态还在：不清计时器，靠宿主每 10s 的续期帧接着
      var ms = Number(opts.ms) || 0;
      if (opts.sticky !== true && ms > 0) {
        var el = b;
        el._timer = setTimeout(function () { dropBubble(el); }, ms);
      }
    };
// 「说点什么…」：输入框是气泡栈里**独立的最后一行**（不是塞在某条消息里）——
    // 消息一条条冒，框的位置就不会被上一条文案顶来顶去。Enter 提交，Esc 取消。
    // 提交走主进程 → 宿主 /control（只有主进程手里有 token）。
    var inputRow = document.createElement("div");
    inputRow.className = "pet-bubble pet-bubble-row";
    var input = document.createElement("input");
    input.className = "pet-bubble-input";
    input.type = "text";
    input.maxLength = 80;
    input.placeholder = "说点什么…（Enter 发送）";
    // 亮不亮全看 class：写内联 display:none 的话优先级压过 .on{display:block}，框永远出不来
    input.classList.remove("on");
    inputRow.appendChild(input);
    stack.appendChild(inputRow);

    /** 输入框开着？（主进程靠这个决定要不要把窗切成可聚焦） */
    var inputOpen = false;

    /** 收工：清框、收输入行（历史气泡留着 —— 那是聊天记录，不该被关框带走）、
        告诉主进程把键盘焦点还给下面的窗口。所有关闭路径都走这里。 */
    function closeInput() {
      if (!inputOpen) return;
      inputOpen = false;
      input.value = "";
      input.classList.remove("on");
inputRow.classList.remove("show", "on");
      stack.classList.toggle("show", !stackEmpty());
      markTail(); // 框关了，尾巴回到最底下那条
      self.clampBubble();
      pushHitRegion();
      if (window.__petElectron__ && window.__petElectron__.sayInputEnd) window.__petElectron__.sayInputEnd();
    }

    /** 焦点要等主进程把窗切成可聚焦才留得住，所以补几遍（第一下常常被系统吐掉）。
        补到最后一遍还没拿到焦点 = 这扇窗根本激活不了（少见，但以前就是这么变成
        「框挂在屏幕上打不进字也关不掉」的）→ 干脆收框，把键盘还给用户。 */
    var FOCUS_LADDER = [0, 40, 120, 300, 600, 1200];
    function focusInput() {
      if (!inputOpen) return;
      FOCUS_LADDER.forEach(function (ms, idx) {
        setTimeout(function () {
          if (!inputOpen) return;
          try { input.focus(); } catch { /* ignore */ }
          var last = idx === FOCUS_LADDER.length - 1;
          if (last && document.activeElement !== input) closeInput();
        }, ms);
      });
      // 立刻也要一下：主进程已经把窗激活时，同帧 focus() 就够（input.select 只补选中态）
      try { input.select(); } catch { /* ignore */ }
    }

    function submitInput() {
      var v = input.value.trim();
      closeInput();
      if (!v) return;
      if (window.__petElectron__ && window.__petElectron__.say) window.__petElectron__.say(v);
      else self.showBubble(v, { ms: 5000 });
      // 回一句：宿主把用户那句话原样弹回来（宠物「听到了」），这里补它自己的回答。
      // 延一小拍才有来有回的感觉；不管闲不闲 —— 有人跟它说话就得应。
      var r = chatReply(v);
      if (r) setTimeout(function () { chatSay(r); }, 700 + Math.random() * 600);
    }

self.askSay = function () {
inputOpen = true;
      input.classList.add("on"); // ⚠️ 不能写 style.display = ""：样式表里的 display:none
      //    优先级更高，空的内联样式等于「按样式表来」，框还是出不来
inputRow.classList.add("show", "on");
      stack.classList.add("show");
      markTail(); // 输入框一开，尾巴让位
      self.clampBubble();
      requestAnimationFrame(function () { self.clampBubble(); });
      pushHitRegion();
      focusInput();
    };
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") submitInput();
      else if (e.key === "Escape") closeInput();
    });
    // 点输入框时别触发宠物的点击/拖拽逻辑
    input.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    input.addEventListener("click", function (e) { e.stopPropagation(); });
    // 鼠标落回框上时再要一次焦点（Windows 上第一次点击往往只是把窗激活）
    input.addEventListener("mouseup", function () { focusInput(); });
    // 点宠物身上 = 「不说了」：顺便把焦点还给下面的窗口
    input.addEventListener("blur", function () {
      setTimeout(function () {
        if (inputOpen && document.activeElement !== input) closeInput();
      }, 120);
    });
    self.closeInput = closeInput;

    // 右键菜单里的「说点什么…」→ 主进程叫这一声
    if (window.__petElectron__ && window.__petElectron__.onAskSay) {
      window.__petElectron__.onAskSay(function () { self.askSay(); });
    }
    // 主进程强制收（失焦 / 开了菜单）：别让框赖在屏幕上不走
    if (window.__petElectron__ && window.__petElectron__.onSayCancel) {
      window.__petElectron__.onSayCancel(function () { closeInput(); });
    }

// ---- Switch to animation (dual buffer, hard cut) ----
    //
    // ⚠️ 门禁：一段动画**没播够 minPlayMs 就不许被别人切走**（用户自己动手除外）。
    // 待机时把一段动作从中间砍掉的全是**被动**切换 —— 鼠标扫过宠物（hover 移出就回待机）、
    // 拖拽落点回待机、待机链重抽。老实现直接换 src，正在播的那段当场消失，屏幕上就是
    // 「动画还没执行完就跳下一个」。现在这些请求先排队（queueSwitch），等当前这段播完
    // （ended）或播够 minPlayMs 再切；只有用户自己的动作（点一下 / 拖起来 / 拖完落回待机）
    // 和状态驱动的 override 才立刻打断 —— 打断本来就是它们的本意。
    //
    // ⚠️ 换手是**硬切**，不是淡入淡出（CSS 里 .pet-video 没有 opacity 过渡了）：
    //   两头一起淡的话，中间那 180ms 里旧的一半 + 新的一半叠着，宠物整整淡掉一半还带重影
    //   —— 拖一次要换两次姿势（抓起 + 落下），状态抖一下还要再换几次，于是「一拖就闪」。
    //   代价是新视频的第一帧得先解码出来（约 40ms），所以等
    //   requestVideoFrameCallback —— 它回调 = 这一帧真的贴到屏幕上了，这时候换手不���会闪。
    this.switchTo = function (next, nextOnce, opts) {
      if (!next) return;
      // 冻住时**连 src 都不换**（换 src = 解码首帧 + 一次重绘，那正是要省掉的开销）。
      // 只记下该演哪一段，醒来（wake）再补上。
      if (self.asleep) {
        self.asleepNext = { anim: next, once: nextOnce };
        return;
      }
      var force = !!(opts && opts.force);
      if (!force && !self.canInterrupt()) {
        self.queueSwitch(next, nextOnce);
        return;
      }
      // 同一段还在放 → 别从头重播（重播 = 跳回第一帧，看着就是「闪了一下」）。
      // ⚠️ 只对**一次性**动画生效：循环中的（override / 待机停留）跳过一次就会永远卡在
      // 那一条里 —— 它的 onended 是 null，链子再也接不上（宠物再也不动了）。
      if (!force && next === self.playing && !self.pending) {
        var cur = self.frontIdx === 0 ? videoA : videoB;
        if (!cur.ended && !cur.loop) return;
      }
      self.clearQueue();
      var pending = self.pending;
      if (pending && pending.anim === next && pending.once === nextOnce) return;
      var gen = ++self.gen;
      self.pending = { anim: next, once: nextOnce, gen: gen };
      var target = self.frontIdx === 0 ? videoB : videoA;
      var url = "/thumb/" + encodeURIComponent(next) + ".webm";
      // 预热过的（warmAnim）别再赋一次 src：同一个 URL 重写会重新走一遍资源选择，
      // 白白把刚解好的首帧扔掉，等于又变回「切过去要等 40ms」。
      if (target.getAttribute("src") !== url || target.readyState < 2) target.src = url;
      target.loop = !nextOnce;
      target.onended = nextOnce ? handleEnded : null;

      var swapped = false;
      var fallback = 0;
      /** 真正换手：旧的一帧都不淡，直接换成新的（见上面为什么要硬切）。 */
      var commit = function () {
        if (swapped) return;
        swapped = true;
        if (fallback) clearTimeout(fallback);
        if (self.pending && self.pending.gen !== gen) return;
        var old = self.frontIdx === 0 ? videoA : videoB;
        target.classList.add("is-front");
        old.classList.remove("is-front");
        self.frontIdx = self.frontIdx === 0 ? 1 : 0;
        self.pending = null;
self.playing = next;   // 屏幕上真正在放的（判定「演到哪了」只看它）
        // 命中区跟着「当前这段动画画了多大」变（见 animInkBox）；emitHitRegion 会按矩形去重
// ⚠️⚠️ 换手后必须**重夹一次位置**（§9.31）：形状会罩住宽动画，可窗不会跟着变大 —
        //   宠物停在窗的右半边时，宽出来那截（思考气泡 95..551）直接顶出窗外被切，
        //   用户口径「右侧还是展示不全」。以前只有 refitInk（量完可见框时）会夹，
        //   而框一旦进了缓存就不会再量 ⇒ refitInk 永远不跑 ⇒ 缓存一热就必现。
self.refitInk();
        pushHitRegion();
        // 窗宽跟着当前动画走（§9.32）：窄动画时把两侧那块透明区收掉，
        //   否则屏幕上留着上一段宽动画的旧画面（见 stageSize 里的说明）。
        reportWindowSize();
        // 这段还没量过可见框？插队量一下（量完 onInkBoxReady 会重夹位置 + 重报形状）
        queueInkMeasure(next);
        self.playedAt = Date.now();
        target.style.transform = isDirAnim(next) && moveDir() === 1 ? "scaleX(-1)" : "";
        if (!self.asleep && target.paused) target.play().catch(function () {});
        if (self.pendingMove && !self.asleep) self.startMoveDrive(target);
      };
/**
       * loadeddata 只说明解码器交出了首帧，合成器还没把它贴上去；那时候换手就是闪一帧空白。
       * ⚠️⚠️ 但**别在整段缓冲完之前上屏**（readyState >= 4 / canplaythrough 之前）：
       * webm 的透明背景是另带的 alpha 块（BlockAdditional），半截数据就出帧时 Chromium
       * 会把它丢了 —— 症状是「部分动画整体变成黑色背景」（素材本身没问题），
       * 换台机器/换个 Electron 版本就好，更难查。宁可多等几毫秒。
       */
      var onReady = function () {
        target.removeEventListener("loadeddata", buffered);
        target.removeEventListener("canplaythrough", buffered);
        clearTimeout(bufferWait);
        if (self.pending && self.pending.gen !== gen) return;
        if (!self.asleep) target.play().catch(function () {});
        if (typeof target.requestVideoFrameCallback === "function") {
          target.requestVideoFrameCallback(function () { commit(); });
          // 兜底：这个回调在极端情况下可能不来（解码被系统抢停），到点还是换，
          // 宁可淡一下也不能让宠物卡在旧动作上。
          fallback = setTimeout(commit, FRAME_WAIT_MS);
        } else {
          fallback = setTimeout(commit, 0);
        }
      };
var buffered = function () {
        if (target.readyState >= 4) onReady();
      };
      // 卡住了（磁盘/network 抽风）也得换手，不能让宠物冻在旧动作上。
      var bufferWait = setTimeout(function () {
        target.removeEventListener("loadeddata", buffered);
        target.removeEventListener("canplaythrough", buffered);
        onReady();
      }, BUFFER_WAIT_MS);
      target.addEventListener("loadeddata", buffered);
      target.addEventListener("canplaythrough", buffered);
      buffered();
    };

    /**
     * 把「马上要演的那一段」先塞进**后台那个缓冲区**（不换手、不改播放状态）。
     * 用途：鼠标按下去的那一刻就把拖拽姿势预热好 —— 真正拖起来（过了 DRAG_THRESHOLD）
     * 时那一段的首帧早就解好了，换手是零延迟的硬切，而不是「先拿旧姿势顶着 40ms」。
     * 反过来，不预热的话抓起宠物会有一下可察觉的停顿。
     */
    /**
     * 抓起时该演哪一段：**一次会话只挑一段**（memo），顺手预热。
     *
     * ⚠️ 以前 pointerdown 预热的是 pick 出来的 A、真拖起来时又 pick 一次得到 B ——
     *   十有八九不是同一段，于是抓起那一瞬间要现加载现解码首帧，屏幕上就是「抓了以后
     *   空着不动一秒」才换上拖拽姿势（用户口径「有一秒左右的空闲时间无法拖拽动画」）。
     *   现在鼠标移入就把这段解好，抓起零延迟。
     */
    this.grabAnim = function () {
      if (self.grabbed) return self.grabbed;
      self.grabbed = config.animations.drag.length ? pick(config.animations.drag) : "";
      if (self.grabbed && this.warmAnim) this.warmAnim(self.grabbed);
      return self.grabbed;
    };

    this.warmAnim = function (name) {
      if (!name || self.asleep || self.destroyed) return;
      var target = self.frontIdx === 0 ? videoB : videoA;
      var url = "/thumb/" + encodeURIComponent(name) + ".webm";
      if (target.getAttribute("src") === url && target.readyState >= 2) return;
      try {
        target.src = url; // 只加载；不加 is-front、不碰 frontIdx，屏幕上还是旧的
      } catch (e) {
        /* 预热失败就当没预热：真要演的时候 switchTo 会自己再加载一次 */
      }
    };

    /** 现在允许把屏幕上这一段切走吗？ */
    this.canInterrupt = function () {
      if (!self.playing || !self.playedAt) return true; // 还没开始播 / 什么都没播
      if (self.currentOverrideAnim) return true; // 状态帧驱动的 override 必须立刻响应
      if (dragState.active || self.dragging) return true; // 拖拽要跟手
      if (self.dwellTimer) return true; // 待机停留中：这一轮本来就播完了
      var front = self.frontIdx === 0 ? videoA : videoB;
      if (front.ended) return true; // 已经放完，正等着切下一个
      return Date.now() - self.playedAt >= minPlayMs();
    };

    /** 切不动就先记着：等当前这段放完（或播够 minPlayMs）再切，不打断它。 */
    this.queueSwitch = function (anim, once) {
      if (self.destroyed) return;
      if (self.queued && self.queued.anim === anim && self.queued.once === once) {
        if (self.queuedTimer) return;
      } else {
        self.queued = { anim: anim, once: once };
      }
      if (self.queuedTimer) clearTimeout(self.queuedTimer);
      var left = Math.max(16, minPlayMs() - (Date.now() - self.playedAt));
      self.queuedTimer = setTimeout(function () {
        self.queuedTimer = null;
        var q = self.queued;
        self.queued = null;
        if (!q || self.destroyed) return;
        if (dragState.active || self.dragging || self.currentOverrideAnim) return; // 期间被别的事接管了，丢弃
        self.switchTo(q.anim, q.once);
      }, left);
    };

    this.clearQueue = function () {
      self.queued = null;
      if (self.queuedTimer) {
        clearTimeout(self.queuedTimer);
        self.queuedTimer = null;
      }
    };

    // ---- 待机停留：待机段放完之后别急着抽下一个 ----
    // 链子的权重是 idle 10 / turn 5 / move 5 / action 80（见 assets/config.jsonc），
    // 也就是「一段待机呼吸刚结束就有 90% 概率跳去演随机动作」—— 屏幕上的宠物几乎
    // 没有真正停下来的时候，观感就是「待机时间太短」。这里让待机那一段原地续播
    // idleDwellMs 再往下走；期间用户一动（点/拖/状态帧）立刻收摊。
    this.canDwell = function (name) {
      if (self.currentOverrideAnim || dragState.active || self.dragging) return false;
      if (idleDwellMs() <= 0) return false;
      return config.animations.idle.indexOf(name) >= 0;
    };

    this.startDwell = function (name) {
      if (self.destroyed) return;
      if (self.dwellTimer) clearTimeout(self.dwellTimer);
      self.anim = name;
      self.once = false; // 停留期间循环放
      // 直接让**当前这一条**视频继续循环，不换 src —— 换 src 会从第一帧重来，
      // 那又是一次「跳回去」。待机呼吸这类素材本来就是循环片，续播看不出接缝。
      var front = self.frontIdx === 0 ? videoA : videoB;
      try {
        front.loop = true;
        front.onended = null;
        // 冻住时别偷跑：不然待机停留会把暂停的视频重新放起来（等于没睡）
        if (!self.asleep) {
          var p = front.play();
          if (p && p.catch) p.catch(function () {});
        }
      } catch (e) {
        /* 续播失败也别把链子卡住：下面的计时器照样接上 */
      }
      self.playedAt = Date.now();
      self.dwellTimer = setTimeout(function () {
        self.dwellTimer = null;
        if (self.destroyed || self.currentOverrideAnim || dragState.active || self.dragging) return;
        self.once = true;
        self.seq++;
        self.pickNext();
      }, idleDwellMs());
    };

    this.stopDwell = function () {
      if (!self.dwellTimer) return;
      clearTimeout(self.dwellTimer);
      self.dwellTimer = null;
    };

    /**
     * 兜底看门狗（init 里 1s 跳一次，全局一个定时器）：**屏幕上没有在动的东西就把待机接回来。**
     * 链子断一次就再也接不上 —— 前一段放完但没人接手、switchTo 被门禁排队后队列被
     * drag/override 丢弃、pending 加载失败没换成 —— 症状是宠物**彻底消失**
     *（front 停在最后一帧或干脆空白，之后再也不动）。
     * 这里 front.ended 且没人接手 ⇒ 强制播一段待机。once 仍是 true：放完照走
     * handleEnded → 待机停留 → 链子，**不是**永久冻在待机（冻住的话 pet 就再也不演动作了）。
     * 休眠 / override / 拖拽 / 正在换手 / 正在停留都不算「没人接手」。
     */
    this.watchdog = function () {
      if (self.destroyed || self.asleep || self.currentOverrideAnim) return;
      if (dragState.active || self.dragging) return;
      if (self.pending || self.queued || self.dwellTimer) return;
      var front = self.frontIdx === 0 ? videoA : videoB;
      if (!front.ended && front.readyState !== 0) return;
      if (!config.animations.idle.length) return;
      self.anim = config.animations.idle[0];
      self.once = true;
      self.seq++;
      self.switchTo(self.anim, true, { force: true });
    };

    // ---- Animation chain: pick next ----
    this.pickNext = function () {
      var anims = config.animations;
      var weights = config.animationWeights;
      var roll = Math.random();
      var k = rollKind(roll, weights);
      var kind, next;
      if (k === "idle") {
        kind = "IDLE";
        next = pick(anims.idle, self.anim);
        self.anim = next;
      } else if (k === "turn") {
        kind = "TURN";
        next = pick(anims.turn, self.anim);
        self.anim = next;
      } else if (k === "move") {
        if (!self.tryMove()) {
          var act = pickCategoryAction(anims.categories, anims.idle, self.facingRef, self.anim);
          kind = act.id;
          next = act.name;
          self.anim = next;
        } else {
          kind = "MOVE";
          next = "(move)";
        }
      } else {
        var act2 = pickCategoryAction(anims.categories, anims.idle, self.facingRef, self.anim);
        kind = act2.id;
        next = act2.name;
        self.anim = next;
      }
      self.once = true;
      self.seq++;
      self.switchTo(next, true);
    };

    var handleEnded = function () {
      var anims = config.animations;
      if (dragState.active) return;
      // 屏幕上真正放完的那一段（self.anim 可能已经被门禁挡下的请求改掉了）
      var endedAnim = self.playing || self.anim;
      // Turn anims flip facing on end
      if (anims.turn.indexOf(endedAnim) >= 0) {
        var nextF = self.facing === "left" ? "right" : "left";
        self.facing = nextF;
        self.facingRef = nextF;
      }
      // Drag/click anims → return to idle (or re-enter override if click was during override)
      if (anims.drag.indexOf(endedAnim) >= 0 || anims.clicks.indexOf(endedAnim) >= 0) {
        if (self.clickFromOverride && self.currentOverrideAnim) {
          self.clickFromOverride = false;
          self.playOverride(self.currentOverrideAnim, OVERRIDE_DURATION_MS);
          return;
        }
        if (anims.idle.length) self.anim = pick(anims.idle, endedAnim);
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true);
        return;
      }
      // 待机段放完 → 原地续播一小会儿（默认 6s），别一口气接着演
      if (self.canDwell(endedAnim)) {
        self.startDwell(endedAnim);
        return;
      }
      self.pickNext();
    };

    // ---- Movement system ----
    this.currentCenterX = function () {
      if (self.customPos) return self.customPos.rx * window.innerWidth;
      var r = container.getBoundingClientRect();
      return r.left + halfW;
    };
    this.currentCenterY = function () {
      if (self.customPos) return self.customPos.ry * window.innerHeight;
      var r = container.getBoundingClientRect();
      return r.top + halfH;
    };

    this.startMoveDrive = function (el) {
      var pm = self.pendingMove;
      if (!pm || self.moveRef !== null) return;
      self.pendingMove = null;
      var startRatio = pm.startRatio, startYRatio = pm.startYRatio, targetRatio = pm.targetRatio;
      var dir = pm.dir, totalRatio = pm.totalRatio, leadSec = pm.leadSec, tailSec = pm.tailSec;
      var duration = (isFinite(el.duration) && el.duration > 0) ? el.duration : 10.09;
      var travelWindow = Math.max(0.1, duration - leadSec - tailSec);
      var token = ++self.moveToken;
      // 漫游的位移写样式 + 上报命中区是这一段最贵的两步（见 4.7）：
      // 全屏透明窗每改一次样式就要重合成一次，所以这里把帧率封在 30fps ——
      // 观感上看不出（漫游本来就慢），合成压力直接砍半。
      var lastWrite = 0;

      var step = function () {
        if (self.moveToken !== token) return;
        var t = el.currentTime || 0;
        var W = window.innerWidth;
        var H = window.innerHeight;
        var ratioX;
        if (t <= leadSec) ratioX = startRatio;
        else if (t >= duration - tailSec) ratioX = targetRatio;
        else ratioX = startRatio + dir * totalRatio * ((t - leadSec) / travelWindow);
        var px = ratioX * W;
        var py = startYRatio * H;
        var last = t >= duration - tailSec;
        var now = Date.now();
        // 最后一帧必须写进去（否则会停在倒数第二帧的位置上）
        if (last || now - lastWrite >= MOVE_FRAME_MS) {
          lastWrite = now;
var mp = clampPos(px - inkHalf, py - halfH);
          container.style.left = mp.left + "px";
          container.style.top = mp.top + "px";
          container.style.right = "auto";
          container.style.bottom = "auto";
          // 漫游中每一帧位置都在变：命中区必须跟着走，否则形状留在出发点，
          // 宠物移到哪儿就点不到了（旧位置还会留一块点不动的「鬼影」区）
          pushHitRegion();
        }
        if (!last) self.moveRef = requestAnimationFrame(step);
        else {
          self.moveRef = null;
          // 存**实际落点**而不是计划点：贴边时 clampPos 会把宠物夹回屏内，
          // 存计划点的话下次 resize 一下宠物就又飞到屏外去了
          var done = container.getBoundingClientRect();
self.customPos = { rx: (done.left + halfW) / W, ry: (done.top + halfH) / H, w: W, h: H };
        }
      };
      self.moveRef = requestAnimationFrame(step);
    };

    /** 走位方向：+1 = 往右，-1 = 往左。
        turn 动画放完会翻 facing，所以此刻它是在朝**反方向**走（与 tryMove 同一口径，别写两份）。 */
    function moveDir() {
      var turnAnim = config.animations.turn.indexOf(self.playing || self.anim) >= 0;
      return (self.facingRef === "right") !== turnAnim ? 1 : -1;
    }

    this.tryMove = function () {
      if (self.moveRef !== null || self.pendingMove) return true;
      var moves = config.animations.moves;
      var actions = moves.actions;
      if (!actions.length) return false;
      var chosen = actions[Math.floor(Math.random() * actions.length)];
      var mp = Object.assign({}, moves.default, chosen.params || {});
      var dir = moveDir();
      var W = window.innerWidth;
      var plan = planMove({
        cx: self.currentCenterX(),
        cy: self.currentCenterY(),
        W: W,
        H: window.innerHeight,
        dir: dir,
        minDist: mp.minDist,
        maxDist: mp.maxDist,
        margin: mp.margin,
halfW: inkHalf, // 漫游道按**可见框**两端夹（§9.27），不是按舞台两端
      });
      if (!plan) return false;
      self.pendingMove = Object.assign({}, plan, { dir: dir, leadSec: mp.leadSec, tailSec: mp.tailSec });
      self.once = true;
      self.anim = chosen.name;
      // force：漫游的落点/相位是按这一段动画的计划算的，晚切一步就会在原地先愣一下
      self.switchTo(chosen.name, true, { force: true });
      return true;
    };

    this.stopMove = function () {
      self.pendingMove = null;
      self.moveToken++;
      if (self.moveRef !== null) {
        cancelAnimationFrame(self.moveRef);
        self.moveRef = null;
      }
    };

    // ---- 拖拽搬窗：一帧最多搬一次 ----
    //
    // 为什么必须合帧：`pointermove` 的频率是**鼠标轮询率**（125Hz 常见，500/1000Hz 的
    // 鼠标更常见），不是显示器刷新率。每来一次就 ipc → 主进程 `setPosition` → Windows
    // 一次 SetWindowPos → DWM 为这扇透明置顶窗重合成一次。1000Hz 时就是每秒 1000 次搬窗：
    //   ① 窗追不上光标 = 用户说的「**有明显阻力**」（宠物像被拽着走）；
    //   ② 补上来的帧参差不齐 = 「**抖**」。
    // 修法：只留**最新**的那一个位置，用 rAF 一帧发一次（显示器刷新率 = 最高上限，
    // 60Hz 屏就是 60 次/s，而且每次都跟 VSync 对齐，天然不抖）。
    // ⚠️ 位移仍然是「从按下那下算起」的（不是每帧增量），所以合帧不会累积误差。
    var moveRaf = 0;
    var movePending = null;
    function flushWinMove() {
      moveRaf = 0;
      var m = movePending;
      movePending = null;
      if (m && moveWin) moveWin(m.dx, m.dy, m.inset);
    }
    function queueWinMove(dx, dy, inset) {
      movePending = { dx: dx, dy: dy, inset: inset };
      if (!moveRaf) moveRaf = requestAnimationFrame(flushWinMove);
    }
    /** 松手/取消时：把最后一帧必须落地（否则窗会停在上一位置，看着像「拽不动」）。 */
    function settleWinMove() {
      if (moveRaf) {
        cancelAnimationFrame(moveRaf);
        moveRaf = 0;
      }
      flushWinMove();
      movePending = null;
    }

    /** 事件的**屏幕**坐标（搬窗的位移必须用它算，见 pointermove 里的说明）。
     *  Chromium 的 screenX/Y 与主进程 setPosition 是同一套单位（设备无关像素）。
     *  个别环境压根不给 screenX/Y（非 Chromium 的合成事件）→ 退回 client。 */
    function screenPoint(e) {
      var sx = Number(e.screenX);
      var sy = Number(e.screenY);
      if (Number.isFinite(sx) && Number.isFinite(sy)) return { x: sx, y: sy };
      return { x: Number(e.clientX) || 0, y: Number(e.clientY) || 0 };
    }

    // ---- Pointer events (click vs drag) ----
hit.addEventListener("pointerdown", function (e) {
      e.currentTarget.classList.add("dragging");
      // 输入框开着的时候点宠物 = 「不说了」：先收掉，别把焦点一直扣在透明窗上
      if (self.closeInput) self.closeInput();
      self.stopDwell(); // 用户上手了，待机停留立刻收摊
      self.stopMove();
      // 先把拖拽姿势解到后台缓冲区去（见 warmAnim）：手指刚按下到真拖起来还有几帧，
      // 这几帧足够把首帧解出来，拖起来那一瞬间就是硬切，不用拿旧姿势顶着。
      self.grabAnim(); // 预热这一段（见 grabAnim：移入鼠标时已经解好了）
      setPassthrough(false); // capture during drag
      e.currentTarget.setPointerCapture(e.pointerId);
      var r = container.getBoundingClientRect();
      var ps = screenPoint(e);
      dragState = {
        active: true,
        dragging: false,
        sx: e.clientX,
        sy: e.clientY,
        // 按下点的**屏幕**坐标：搬窗的位移拿它算（原因见 pointermove）
        psx: ps.x,
        psy: ps.y,
        offX: e.clientX - (r.left + r.width / 2),
        offY: e.clientY - (r.top + r.height / 2),
        // 宠物在窗里的位置：搬窗时主进程拿它把宠物夹在屏幕工作区里（不让它拖出屏幕）
        inset: { left: r.left, top: r.top, width: r.width, height: r.height },
        // 窗左上角的**屏幕**坐标：slideTo 靠它推「窗被屏幕边夹住了多少」（§9.25）。
        // 口径就是「光标屏幕坐标 − 光标在窗里的坐标」—— 无边框无滚动时 clientX/Y
        // 就是窗内坐标，所以两者一减就是窗原点。⚠️ 别拿容器的偏移去推（量过的坑）：
        //   写成 `ps.x - (clientX - r.left)` 等于假设「光标按在容器正中」，用户按住的是
        //   宠身的哪一块就偏多少（命中框左右各留 10px，按中间就偏 10）。实测偏 10px 时
        //   贴左边的宠物停在离边 302 而不是 0（而且偏多少取决于按哪儿，看起来像“随机”）。
        win0: { x: Math.round(ps.x - e.clientX), y: Math.round(ps.y - e.clientY) },
        // 这次拖拽的窗内基准落点（slideTo 在它之上加差额，pointerup 也不再看 clientX）
        base: { x: r.left, y: r.top },
        // 上一帧写进去的窗内偏移：没变就不重排（slideTo 每帧都调）
        slideAt: null,
      };
    });

    /**
     * 拖拽时把宠物在**窗里**的位置挪一挪，让它照旧贴着光标，哪怕窗已经被屏幕边夹住（§9.25）。
     *
     * 「贴边」是两个自由度：屏幕位置 = 窗的位置 + 宠物在窗里的位置。以前第二个自由度
     * 全程不动，于是窗一夹住，宠物就差「它在窗里贴着的那条边」那么多 —— 头顶 150、
     * 底下 60、左右 32（实测），也就是用户说的「拖到边上还差一大块、贴不上」。
     * 现在：窗照旧整扇夹在屏内（气泡按**窗**夹取，窗在屏内它就必然可见，§9.23），
     * 窗夹不住的那份**差额**原样加到宠物在窗里的偏移上：
     *   屏幕上 → 宠物照常 1:1 跟手，贴到边时正好贴住（窗不出屏、宠物不出屏）；
     *   窗内   → 偏移永远夹在 [0, 窗宽−动画宽] / [0, 窗高−动画高−脚底下移] 里，
     *            所以动画**不会被窗边切掉**（这是「动画左右被裁剪」那条的另一半）。
     * 纯计算：偏移是「光标位移」的函数而不是累加的，来回拖不会漂；窗没被夹时差额恒为 0，
     * 于是一行 DOM 都不写（老行为逐帧不变）。
     */
    function slideTo(dx, dy) {
      var d = dragState;
      if (!d.active || !d.win0) return;
      var winW = window.innerWidth;
      var winH = window.innerHeight;
      var want = { x: d.win0.x + dx, y: d.win0.y + dy };
      // 显示器按**宠物**落点选（与主进程 pet:window-move 同一口径：窗落点 + 宠物在窗里的偏移）
      var wa = workAreaNear(want.x + d.inset.left + 20, want.y + d.inset.top + 20);
      var at = clampWinToScreen(want, winW, winH, wa);
// 横向夹的是**可见框**（§9.27）：d.base.x 是容器左边，art 框左边 = 容器左边 + safe.off。
      // 夹完减回 safe.off —— 写进样式的仍然是容器左边。窄动画时 safe.off/w 就是角色那一份，
      // 窗边裁掉的仍是透明边，看不见（§9.28：宽动画时要连它画出来的像素一起保证在窗内）。
      var safe = inkSafe();
      var safeLeft = Math.min(Math.max(d.base.x + safe.off + (want.x - at.x), 0), Math.max(0, winW - safe.w));
      var left = safeLeft - safe.off;
      // 纵向：0 起夹（§9.28）—— 上下都能贴到屏边。容器底就是脚底（stage 的
      // translateY(bottomPad) 把脚下那段透明留白顶下去了），所以下界直接是「容器底贴窗底」。
      var hiTop = Math.max(0, winH - halfH * 2);
      var top = Math.min(Math.max(d.base.y + (want.y - at.y), 0), hiTop);
      if (d.slideAt && Math.abs(d.slideAt.x - left) < 0.5 && Math.abs(d.slideAt.y - top) < 0.5) return;
      d.slideAt = { x: left, y: top };
      container.style.left = Math.round(left) + "px";
      container.style.top = Math.round(top) + "px";
      container.style.right = "auto";
      container.style.bottom = "auto";
      clampBubbles(); // 气泡夹的是**窗**：宠物在窗里挪了就得跟着重夹一次
      pushHitRegion(); // 形状是窗坐标：宠物在窗里动了，形状不跟着动就点不到它了
    }

    hit.addEventListener("pointermove", function (e) {
if (!dragState.active) return;
      // 窗只包住宠物（见 pet-electron.cjs 文件头）
      // 实际是**搬整扇窗**：宠物在窗里的相对位置不动，看起来就是跟着手走。
      //
      // ⚠️⚠️ 位移必须用**屏幕**坐标算（e.screenX - 按下时的 screenX），不能用 clientX：
      //    clientX/Y 是**窗内**坐标 = 光标屏幕位置 - 窗原点，而窗正跟着拖拽一起动 ——
      //    也就是说每读到的 clientX 已经把「上一帧窗走过的距离」扣掉了。再拿它算
      //    「从按下那下算起的位移」，得到的就是 `光标位移 - 窗已走的位移`，于是每次
      //    只补一半：匀速拖 300px，窗只走 150px（跟手比 0.50，窗还会一格一格哆嗦）。
      //    这不是滞后，是**每帧只跟上一半**（实测跟手比 0.500，见 DESIGN.md §9.20）。
      //    屏幕坐标不随窗动，所以才是真正「光标走了多远」。
      var p = screenPoint(e);
      var dx = p.x - dragState.psx;
      var dy = p.y - dragState.psy;
      if (!dragState.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragState.dragging = true;
        gestureSay("drag", 2600, self);
        self.dragging = true;
        self.once = true;
if (config.animations.drag.length) {
          self.anim = self.grabAnim();
          self.anim = pick(config.animations.drag);
          self.switchTo(self.anim, true, { force: true }); // 拖起来了就得立刻换姿势（已预热 → 零延迟硬切）
        }
      }
      if (moveWin) {
        // 位移仍然是「从按下那下算起」而不是每帧增量（屏边夹住时增量会让宠物越拖越落后），
        // 但它现在真的是屏幕上的绝对位移，所以既 1:1 又不累积误差。
        // 窗被屏幕边夹住的那部分差额，渲染进程自己补到宠物在窗里的位置上（§9.25）——
        // 不补的话宠物会停在离屏边「它在窗里贴着的那条边」那么远，贴不上边。
        slideTo(dx, dy);
        queueWinMove(dx, dy, dragState.inset);
        return;
      }
      // 拖拽也要夹在屏幕内（窗内的纵向 0 起夹，见 clampPos §9.28）
var dp = clampPos(e.clientX - dragState.offX - inkHalf, e.clientY - dragState.offY - halfH);
      container.style.left = dp.left + "px";
      container.style.top = dp.top + "px";
      container.style.right = "auto";
      container.style.bottom = "auto";
      stage.style.transform = "none";
      pushHitRegion(); // 拖到哪儿，命中区就到哪儿（不然半路就「松手」了）
    });

    hit.addEventListener("pointerup", function (e) {
      var wasDragging = dragState.dragging;
      dragState.active = false;
      dragState.dragging = false;
      settleWinMove(); // 最后一帧落地，再让主进程记落点
      if (endWinDrag) endWinDrag(); // 搬完窗：让主进程记住这扇窗落在哪儿
      e.currentTarget.classList.remove("dragging");
      // Restore passthrough if mouse has already left the hitbox
      if (passthrough === false) {
        var r = hit.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
          setPassthrough(true);
        }
      }
      if (wasDragging) {
        gestureSay("drop", 2600, self);
        self.grabbed = "";
        self.justDragged = true;
        setTimeout(function () { self.justDragged = false; }, 100);
        self.dragging = false;
        // 落点按**容器实际位置**算，不再拿 e.clientX 反推（§9.25）：
        //   窗被屏幕边夹住时宠物在窗里的位置是被 slideTo 挪过的，
        //   `clientX − offX` 得到的是「光标该在的地方」，不是宠物真正的落点 ——
        //   差出来的正好是贴边那一段，存下去下次启动就又「贴不上边」了。
        var W1 = window.innerWidth;
        var H1 = window.innerHeight;
        var rc = container.getBoundingClientRect();
self.customPos = { rx: (rc.left + halfW) / W1, ry: (rc.top + halfH) / H1, w: W1, h: H1 };
        self.movedLocally = true;
        savePosition(self); // 记住落点：下次启动还在这儿（宿主落盘，比例坐标）
        stage.style.transform = "translateY(" + bottomPad + "px)";
        pushHitRegion(); // 落点定死，再报一次（节流可能刚好把最后一下挡掉了）
        if (config.animations.idle.length) self.anim = pick(config.animations.idle, self.anim);
        self.once = false;
        self.switchTo(self.anim, false, { force: true }); // 落回待机是拖拽的一部分，跟着手
      }
    });

    hit.addEventListener("pointercancel", function (e) {
      hit.dispatchEvent(new PointerEvent("pointerup", e));
    });

    hit.addEventListener("click", function () {
      if (dragState.active || dragState.dragging || self.justDragged) return;
      if (self.once && config.animations.idle.indexOf(self.playing) < 0) return;
      self.stopDwell();
      self.stopMove();

      gestureSay("click", 2600, self);

      // Click during WS override (thinking/coding): cancel timer,
      // play 傲娇生气, then re-enter override on end
      if (self.currentOverrideAnim) {
        if (self.overrideTimer) clearTimeout(self.overrideTimer);
        self.overrideTimer = null;
        self.clickFromOverride = true;
        self.anim = "点击回应-傲娇生气";
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true, { force: true });
        return;
      }

      self.once = true;
      if (config.animations.clicks.length) {
        self.anim = pick(config.animations.clicks);
        self.switchTo(self.anim, true, { force: true });
      }
    });

// 双击 = 想跟它说话（单击仍然是点回应动画，不抢）
    hit.addEventListener("dblclick", function () {
      if (dragState.active || dragState.dragging || self.justDragged) return;
      bubbleTarget = self; // 回话的气泡要出现在同一只头顶
      self.askSay();
    });

    // ---- Override: WebSocket forces a specific animation ----
    this.playOverride = function (animName, durationMs) {
      self.stopDwell(); // 状态帧来了：待机停留让位
      self.stopMove();
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      self.currentOverrideAnim = animName; // always update so re-entry picks latest state
      // Don't interrupt a click-response that's playing during override
      if (self.clickFromOverride) return;
      // Same animation already looping → **don't replay it**. Producers keep saying
      // "still thinking" (every 2s); restarting the video each time looks like a stutter.
      // The override animation loops by itself, so all we do here is extend the timer.
      if (self.overrideActive === animName) {
        if (durationMs && durationMs > 0 && isFinite(durationMs)) {
          self.overrideTimer = setTimeout(function () { resetToChain(); }, durationMs);
        }
        return;
      }
      self.overrideActive = animName;
      self.anim = animName;
      self.once = false; // loop while override active
      self.seq++;
      self.switchTo(animName, false, { force: true }); // 状态必须立刻反映到屏幕上
      if (durationMs && durationMs > 0 && isFinite(durationMs)) {
        self.overrideTimer = setTimeout(function () {
          resetToChain();
        }, durationMs);
      }
    };

    function resetToChain() {
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      self.overrideTimer = null;
      self.currentOverrideAnim = null;
      self.overrideActive = null;
      self.clickFromOverride = false;
      self.stopMove();
      // Return to idle, then pickNext will fire on ended
      if (config.animations.idle.length) {
        self.anim = pick(config.animations.idle);
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true, { force: true });
      }
    }

this.destroy = function () {
      self.destroyed = true;
      self.stopDwell();
      self.clearQueue();
      self.stopMove();
      // 气泡的淡出计时器也得收，不然宠物没了计时器还在往一个没人看的 DOM 上跑
      for (var bi = 0; bi < bubbles.length; bi++) {
        if (bubbles[bi]._timer) clearTimeout(bubbles[bi]._timer);
      }
      bubbles.length = 0;
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      container.remove();
      // force：睡着了也要报（不然形状留在已经删掉的宠物老地方，那儿会点不动也点不出东西）
      pushHitRegion(true);
    };

    // ---- 睡 / 醒（见 4.7） ----
    //
    // 睡 = 「一帧都不再产生」：视频暂停（不 pause 的话播放引擎还在出帧，
    // 全屏透明窗每一帧都要 DWM 重合成，于是变成跟别的窗口抢渲染预算）。
    // 定时器/状态机都不动 —— 醒来时宠物还站在原地、还接着放，逻辑没丢。
    this.sleep = function () {
      if (self.asleep || self.destroyed) return;
      self.asleep = true;
      // 漫游的 rAF 是 60fps 写样式 —— 睡前必须停，否则「静止」还在烧 CPU
      if (self.moveRef !== null) {
        cancelAnimationFrame(self.moveRef);
        self.moveRef = null;
      }
      self.pendingMove = null;
      try {
        videoA.pause();
        videoB.pause();
      } catch (e) {
        /* pause 失败也别把逻辑卡住 */
      }
    };

    this.wake = function () {
      if (!self.asleep || self.destroyed) return;
      self.asleep = false;
      // 睡着时排队的「该演哪一段」现在补上；没有就接着当前这一帧往下放
      // （pause/play 不改 currentTime，不会跳回第一帧）。
      var q = self.asleepNext;
      self.asleepNext = null;
      if (q) {
        self.switchTo(q.anim, q.once, { force: true });
        return;
      }
      var front = self.frontIdx === 0 ? videoA : videoB;
      try {
        var p = front.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {
        /* 续播失败就当没醒：下个事件还会再试 */
      }
    };

    // ---- Start playing ----
    // Don't start until config is loaded (handled by init below)
    this.init = function () {
      if (config.animations.idle.length) {
        self.anim = pick(config.animations.idle);
        self.once = true;
        self.switchTo(self.anim, true);
      }
    };
  }

  // ========================================================================
  // 6. WebSocket event mapping
  // ========================================================================

  /** Maps WebSocket events to pet override animations */
  var EVENT_ANIM_MAP = {
    "agent_start": "深度思考碎碎念",
    "thinking": "深度思考碎碎念",
  };

  /** Tool name → animation mapping */
  var TOOL_ANIM_MAP = {
    "bash": "写代码",
    "code": "写代码",
    "grep": "搜寻中",    // fallback
    "read": "写代码",
    "edit": "写代码",
    "write": "写代码",
    "find": "搜寻中",
  };

  /** How long overrides stay before returning to normal chain */
  var OVERRIDE_DURATION_MS = 5000;

  /** Menu labels: animation name → what the user sees in the right-click menu */
  var STATE_LABEL = {
    "深度思考碎碎念": "思考中",
    "写代码": "写代码中",
    "搜寻中": "搜索中",
  };

  /** Human-readable current state (for the right-click menu) */
  function describeState(pet) {
    var anim = pet && pet.currentOverrideAnim;
    if (!anim) return "待机（随机动画）";
    return STATE_LABEL[anim] || anim;
  }

  var pets = []; // PetCard instances
  var addPetSeq = 0; // counter for auto-generated pet ids
  var bubbleTarget = null; // 最近一次被右键的宠物：手动输入与气泡优先出现在它头上

  /**
   * 报「这扇窗要多大」给主进程（Electron 才有意义，浏览器里静默跳过）。
   *
   * 窗 = 宠物 + 四边留白（padding），不是「把宠物放大」（§9.21）：
   *   宽：宠物宽 + 左右各 STAGE_PAD_X（气泡定宽 = 窗宽 - 16，见 applyBubbleWidth）
   *   高：头顶留白 + 宠物高 + 底下留白
   *     贴上边：头顶 = max(marginY, STAGE_PAD_TOP)，底下 STAGE_PAD_BOTTOM
   *     贴下边：头顶 STAGE_PAD_TOP，底下 = max(marginY, STAGE_PAD_BOTTOM)
   * ⚠️ 留白就是「窗里没有宠物的部分」：它必须点得穿（主进程按宠物+气泡的包围盒裁形状），
   *   否则窗一大就把下面软件的点击全吃了。
   *
   * ⚠️ 只报**尺寸**，不动位置（这是量过的）：
   *   宠物在窗里的偏移是「离窗边多少像素」这种常量（贴边角就是这么摆的），
   *   所以主进程改尺寸时**左上角不动**就够了 —— 宠物在屏幕上跟着窗一起不动，
   *   一点都不会跳。（早先还想过「贴上边的宠物让窗往上长」，实测那是反的：
   *   高度差里只有一部分来自头顶偏移，按高度差去挪窗会把宠物挪走 40px，
   *   窗还挂到屏幕外头去了。见 §9.21。）
   */
function reportWindowSize() {
    var s = stageSize();
    applyBubbleWidth(s.w);
    var api = window.__petElectron__;
    if (!api || !api.setWindowSize || !config) return;
    // 宽度跟着**当前动画**变（§9.32）：变化小于滞回阈值就不报 ——
    //   漫游/夹取会反复微调，不滞回就是每秒十几次 SetWindowPos + 全窗重绘。
    if (lastWinW && Math.abs(s.w - lastWinW) < WIN_W_HYSTERESIS) return;
    lastWinW = s.w;
    try {
      // 宽度按内容自适应（§9.24）：stageSize 算的宽是 max(动画宽, 气泡基准宽) + 余量，
      // 这里不再自己加 padding —— 加两遍就是白留（§9.22 就是这么白留的）。
      api.setWindowSize(s.w, s.h);
    } catch (e) {
      /* 主进程还没 ready：那就用它的默认尺寸，窗也不会因此坏掉 */
    }
  }

/** 窗宽滞回阈值（px）：小于它的变化不报给主进程。 */
  var WIN_W_HYSTERESIS = 24;
  var lastWinW = 0;

  /**
   * 舞台窗该多大（纯计算，不碰 DOM）：报尺寸、摆位置、气泡封顶三处共用一份。
   * ⚠️ 别把它散回两个函数里各算一遍：上一轮就是「窗按一个公式、气泡按另一个常量」，
   *   两边对不上，留白就成了白留（见 §9.22）。
   */
function stageSize() {
    var maxStage = 0; // 舞台宽（size 口径）
    var topOff = 0;
    var botPad = 0;
    var sidePad = 0;
    (config && config.pets ? config.pets : []).forEach(function (cfg) {
var s = petSizeOf(cfg);
      if (!(s > maxStage)) return;
      maxStage = s;
      var pos = (cfg && cfg.position) || {};
      var corner = String(pos.corner || "bottom-right");
      var mX = Number(pos.marginX);
      if (!isFinite(mX)) mX = 0;
      var mY = Number(pos.marginY);
      if (!isFinite(mY)) mY = 0;
      if (corner.indexOf("top") === 0) topOff = Math.max(topOff, topOffsetOf(cfg));
      else topOff = Math.max(topOff, STAGE_PAD_TOP);
      botPad = Math.max(botPad, bottomPadOf(cfg));
      sidePad = Math.max(sidePad, Math.max(mX, STAGE_PAD_X));
    });
if (!maxStage) maxStage = 400;
    if (maxStage < MIN_PET_SIZE) maxStage = MIN_PET_SIZE;
    var petH = Math.round((maxStage * 9) / 16);
    // 宽度**自适应内容**（§9.24）：窗跟着动画走（动画多大就留多宽），两侧只留余量。
    //   没有「强制窗宽」了 —— 以前是 max(380+80, 动画宽+400)：小动画白背一截空窗，
    //   大动画又被 padding 顶到窗边（实测 size=900：窗 1300 宽，动画右边只剩 24px）。
    // ⚠️ 窗宽**不许**再为气泡撑（曾试过 max(动画宽, 气泡基准 560)+余量）：
    //   窗一比「动画 + 余量」宽，气泡（封顶 = 窗宽-16）就比动画宽很多，居中时必被
    //   clampBubble 推到贴一边 —— 实测 592 宽的气泡居中于 462 的动画，左探 196px、右探 16px。
    //   宁可气泡窄一点（字多几行），也不要歪。
    // ⚠️⚠️ 但横向必须再留**漫游行程**（§9.25，roamRoom）：只有留白没有行程的话，
    //   窗里能走的道 = 2×留白 − 2×margin = 24px，而走路动画一程 60~320px ——
    //   planMove 直接返回 null（走路动画放不出来），放得出来的那几步也立刻被夹住，
    //   用户看着就是「动画左右被裁剪、被限制在原地」。
// §9.27：窗宽按**可见框**算，不是按舞台算。
    //   动画画布里角色只占中间 37.5%，舞台宽里左右各 ~144px 全是透明区（size 462 时）——
    //   按舞台算出来的窗，左右就各空着一大块，角色永远离屏边那么远（实测把窗拖到屏边
    //   x=0，容器也贴到 0，可见 ink 还在 x=153）。按可见框算完，窗里就没有白留的透明区。
    //   舞台仍然 size 宽（视频铺满它），超出窗的那截是透明的，裁掉看不见。
    // ⚠️⚠️ §9.28：窗宽按**整个舞台**算，不再用「所有可能播的动画的可见框并集」——
    //   并集是运行时才量出来的，拿它算窗宽会先小后大（窗口中途跳一下）。
    //   舞台本来就是「这段动画可能画到的全部」：窗装得下舞台 + inkSafe() 又保证宽动画
    //   往窗里挪，任何动画的像素都不会被窗边裁掉。以前按角色框算窗，宠物靠边时宽动画
    //   （思考 93..551、蝴蝶蜜蜂 4..629）的右侧必被切 —— 用户口径「右侧还是展示不全」。
var maxW = maxStage;
    var w = maxW + sidePad * 2 + roamRoom(sidePad);
    // ⚠️⚠️ 这里曾经按「当前动画的可见框」缩窗宽（§9.32），已经**撤销**，别再写回来。
    //   它换来的好处只有一个：窄动画时把两侧空着的透明区收掉（那片区会留上一段宽动画的
    //   旧画面 —— 而这个早就另有便宜解法：改形状/改尺寸后排一次全窗重画 + 400ms 兼底重画）。
    //   代价却大得多：**窗宽一动，宠物就在屏幕上横向跳**。窗只改尺寸、左上不动
    //   （pet-electron 的 applyBounds），而容器是**居中**摆的（§9.26），于是每换一段动画、
    //   每量完一段的可见框，窗宽就按那段动画的宽窄变一次（滞回 24px 拦不住几百像素的差），
    //   宠物跟着左右晃 —— 用户口径「动画会自己晃动偏移」。实测最狠的是新素材
    //   「夜晚躺在床上睡觉」：整幅不透明（ink 0..640），宽 = 整个舞台，于是它和普通窄动画
    //   （ink ≈ 212..428）每 7.6s 互切一次，窗宽就跟着 462↔380 来回跳。
    //   结论：窗的几何**只能**由配置（舞台）决定；当前动画的宽窄只准影响**形状/命中区**
    //   （pushHitRegion），那是不动东西的。
    return {
      petW: inkWidth(maxStage),
      w: w,
      h: Math.max(Math.round((MIN_PET_H * 16) / 9), topOff + petH + botPad),
    };
  }

/**
   * 气泡**固定宽**（写进 CSS 变量 --bubble-w，pet.css 那侧只读它，§9.34）。
   *
   * ⚠️⚠️ 以前是 `width: max-content` + 一个 max-width 上限：宽度跟着**文案长度**变 →
   *   折行数变 → 气泡几何变 → clampBubble 算出的 dx/dy 变 → **每来一句话气泡就横向跳一下**，
   *   而一棳气泡还会一起抖（用户口径：「气泡框有点丑，位置乱动」）。
   *   定死宽度之后，气泡的几何只跟宠物位置有关 —— 它就钉在头顶不动了，顺带一棳对齐也齐。
   *
   *   = min(窗宽 − 16, BUBBLE_W_MAX)：窗宽 − 16 是 clampBubble 夹得住的上限（左右各留 8），
   *   再封一个 BUBBLE_W_MAX，免得横跨半个屏（看着不像「宠物说话」）。
   * ⚠️ 这个数是**外框**宽（.pet-bubble 是 border-box）：按内容盒算的话会差
   *   padding + border，气泡就比窗宽，夹取永远夹不住（§9.22）。
   */
  function applyBubbleWidth(winW) {
    try {
      var w = Math.min(Math.max(BUBBLE_W_MIN, Math.round(winW) - 16), BUBBLE_W_MAX);
      document.documentElement.style.setProperty("--bubble-w", w + "px");
    } catch (e) {
      /* 老浏览器不支持自定义属性：CSS 里那个兜底值还在 */
    }
  }

/** Maps size arg to px width.
      ⚠️ 最小档别再往小了：气泡是 16:9 舞台头顶一块定宽的框（§9.34），舞台太窄时
      气泡和动画一起被挤到屏幕边上，看着像「被裁了一半」。380 起。 */
var SIZE_MAP = { small: 380, normal: 400, large: 540 };

  /** Create a new pet at a random corner (called on /pet when window already running) */
  function addPet(sizeArg) {
    if (!config) return;
    sizeArg = sizeArg || "normal";
    addPetSeq++;
    var corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    var corner = corners[Math.floor(Math.random() * corners.length)];
    var size = Math.max(MIN_PET_SIZE, SIZE_MAP[sizeArg] || SIZE_MAP.normal);
    var cfg = {
      id: "auto-" + addPetSeq,
      size: size,
      position: { corner: corner, marginX: 30 + Math.floor(Math.random() * 60), marginY: 30 + Math.floor(Math.random() * 120) }
    };
var root = document.getElementById("pet-root");
    var pet = new PetCard(cfg, root, pets.length);
    pets.push(pet);
    pet.init();
// 新宠物进屋：窗正冻着（省电 / 看不见）的话，它也得跟上冻住
    //（省电模式下 init() 会 play()，不补这一下新来的就在满速放）
if (asleep) pet.sleep();
    applySavedPositions(); // 新加的这只也认得「上次的位置」（id 认不出就单只借位，见 4.6）
    pushHitRegion(); // 进了 pets 才量得到它（构造时它还没进数组）
  }

// ========================================================================
  // 7.5 聊天 & 碎碎念（§9.33）
  //
  // 刻意做在**窗侧本地**，不走宿主：窗才知道「现在闲不闲」—— currentOverrideAnim 有值
  // 就是 agent 正在忙，这时候宠物就该闭嘴；输入框开着（有人在打字）也别插嘴。
  // ========================================================================

  /** 现在该不该闭嘴：agent 忙 / 有人正在输入 / 窗看不见 → 一律不出声。 */
  function chatBusy() {
    if (document.hidden) return true;
    if (document.querySelector(".pet-bubble-input.on")) return true;
    for (var i = 0; i < pets.length; i++) if (pets[i].currentOverrideAnim) return true;
    return false;
  }

  /** 冒一句话（默认最近被右键 / 双击的那只宠物；手势气泡走 own —— 多开时得冒在被碰的那只头顶）。 */
  function chatSay(text, ms, own) {
    var t = String(text == null ? "" : text).trim();
    if (!t) return;
    var target = (own && own.showBubble) ? own : (bubbleTarget && bubbleTarget.showBubble ? bubbleTarget : pets[0]);
    if (target) target.showBubble(t, { ms: ms || 6000 });
  }

  /**
   * 手势 → 冒一句话（鼠标移入 / 点一下 / 拖起来 / 放下，§9.37）。
   * 同一个池子里随机抽，池子空 = 不出声（老配置照旧）。
   * 两道门：① chatBusy（agent 忙 / 有人在打字 / 窗不可见）—— 不插状态气泡的队；
   * ② cooldownMs 冷却 —— 鼠标在宠物身上来回扫时不至于刷屏。
   * own = 被碰的那只（多开时气泡得长在它自己头顶，别总往第一只头上堆）。
   */
  var gestureLast = {};
  function gestureSay(kind, ms, own) {
    var c = (config && config.gestures) || {};
    var pool = c[kind];
    if (!pool || !pool.length) return;
    if (chatBusy()) return;
    var now = Date.now();
    if (gestureLast[kind] && now - gestureLast[kind] < (c.cooldownMs || 6000)) return;
    gestureLast[kind] = now;
    chatSay(pick(pool), ms || 2600, own);
  }

  /**
   * 关键词 → 回话。取**最长**命中（先按长度降序），否则「你好吗」会被短词 "?/？" 先截胡。
   * 一个都没命中就 fallback（也可能没配 → 闭嘴）。
   */
  function chatReply(text) {
    var c = (config && config.chatter) || { replies: {}, fallback: [] };
    var t = String(text == null ? "" : text).toLowerCase();
    var keys = Object.keys(c.replies || {});
    keys.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] && t.indexOf(keys[i].toLowerCase()) >= 0) {
        var hit = c.replies[keys[i]];
        return hit[Math.floor(Math.random() * hit.length)];
      }
    }
    var fb = c.fallback || [];
    return fb.length ? fb[Math.floor(Math.random() * fb.length)] : "";
  }

  var chatTimer = null;

/**
   * 排下一次碎碎念（随机时刻，避免每只宠物 / 每次重连都齐步走）。
   * 自己排自己：到点了先看闲不闲，闲就冒一句，然后重新排。config 里没 chatter = 不排。
   *
   * ⚠️ 头一句给 12s 封顶（FIRST_CHATTER_SEC）：idleSec 配的是 1~3 分钟，那是“常态节奏”。
   *   冷启动后干等一分半钟，用户看到的就是「气泡没了」——功能其实在，只是没证据（实测坑）。
   */
var FIRST_CHATTER_SEC = 12;
  var chatterWarmed = false; // 只快一次：后面都按 idleSec 的常态节奏
  function startChatter() {
    if (chatTimer) { clearTimeout(chatTimer); chatTimer = null; }
    var c = config && config.chatter;
    if (!c || c.enabled === false || !c.idle.length) return;
    var sec = c.idleSec[0] + Math.random() * Math.max(1, c.idleSec[1] - c.idleSec[0]);
    if (!chatterWarmed) { chatterWarmed = true; sec = Math.min(sec, FIRST_CHATTER_SEC); }
    chatTimer = setTimeout(function () {
      chatTimer = null;
      if (!chatBusy()) chatSay(pick(c.idle));
      startChatter();
    }, sec * 1000);
  }

  /** Apply an event override to all pets */
  function applyEventOverride(anim) {
    pets.forEach(function (pet) {
      pet.playOverride(anim, OVERRIDE_DURATION_MS);
    });
  }

  /** Show a bubble (state text or a typed message) on the pet the user is talking to. */
  function applyBubble(obj) {
    if (!pets.length) return;
    var target = bubbleTarget && bubbleTarget.showBubble ? bubbleTarget : pets[0];
    if (obj.sticky !== true && !(Number(obj.ms) > 0)) obj.ms = 5000;
    target.showBubble(obj.text, { ms: obj.ms, sticky: obj.sticky === true });
  }

/**
   * 省电帧（v1.3，见 4.7）：on = 冻住动画（气泡文字照常更新）。
   * 用户手动开的省电模式**不会自己醒** —— 只有关掉省电才醒（不然一动鼠标
   * 就又满速解码了，那还不如不开）。
   */
  function applyPowerFrame(on) {
    powerSave = on === true;
if (powerSave) goSleep();
    else goWake();
  }

  /** Apply a tool override */
  function applyToolOverride(toolName) {
    var anim = TOOL_ANIM_MAP[toolName];
    if (anim) {
      pets.forEach(function (pet) {
        pet.playOverride(anim, OVERRIDE_DURATION_MS);
      });
    } else {
      // Unknown tool: pick a random action
      if (config && config.animations.categories.length) {
        var act = pickCategoryAction(config.animations.categories, config.animations.idle, "left", "");
        pets.forEach(function (pet) {
          pet.playOverride(act.name, OVERRIDE_DURATION_MS);
        });
      }
    }
  }

  // ========================================================================
  // 7. WebSocket connection
  // ========================================================================

  var ws = null;
  var reconnectTimer = null;
  var reconnectAttempts = 0;
  var MAX_RECONNECT_ATTEMPTS = 5;
  var DISCONNECT_BANNER_ID = "disconnected-banner";

  function connectWs() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/ws";
    ws = new WebSocket(url);

    ws.onopen = function () {
      console.log("[pi-dsh-pet] WebSocket connected");
reconnectAttempts = 0;
      var banner = document.getElementById(DISCONNECT_BANNER_ID);
      if (banner) banner.classList.remove("show");
      pushHitRegion(); // 提示条没了，命中区跟着收回来
    };

    ws.onmessage = function (event) {
      var msg = event.data;
      // Try JSON first
      try {
        var obj = JSON.parse(msg);
        if (obj.type === "power") {
          // v1.3: 省电开关（老窗不认识这帧，无害）
          applyPowerFrame(obj.sleep === true);
          return;
        }
        if (obj.type === "tool_call") {
          applyToolOverride(obj.tool);
          return;
        }
        if (obj.type === "bubble") {
          // v1.1: state text and anything a human typed. Old windows ignore this frame.
          applyBubble(obj);
          return;
        }
        if (obj.type === "positions") {
// v1.2: 上次拖到哪儿（老窗不认识这帧，当普通字符串事件也无害）
          savedPositions = obj.map && typeof obj.map === "object" ? obj.map : {};
          applySavedPositions();
          return;
        }
      } catch (_) { /* plain string */ }

// Plain string events
      var anim = EVENT_ANIM_MAP[msg];
      if (anim) {
        applyEventOverride(anim);
} else if (msg === "agent_idle") {
        // pets return to chain naturally via override timeout
        startChatter(); // 刚忙完，重新开始计「无聊」（不然可能马上就冒一句）
      } else if (msg === "add_pet") {
        addPet();
      } else if (msg.startsWith("add_pet:")) {
        addPet(msg.slice("add_pet:".length));
      } else if (msg === "shutdown") {
        if (window.__petElectron__ && window.__petElectron__.closeWindow) {
          window.__petElectron__.closeWindow();
        }
        return;
      }
    };

    ws.onclose = function () {
console.log("[pi-dsh-pet] WebSocket disconnected");
      var banner = document.getElementById(DISCONNECT_BANNER_ID);
      if (banner) banner.classList.add("show");
      pushHitRegion(); // 提示条在屏幕右上角，得留在命中区里（它要能被点到/看到）
      reconnectAttempts++;
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log("[pi-dsh-pet] Max reconnect attempts reached, closing window");
        if (window.__petElectron__ && window.__petElectron__.closeWindow) {
          window.__petElectron__.closeWindow();
        }
        return;
      }
      reconnectTimer = setTimeout(connectWs, 3000);
    };

    ws.onerror = function () {
      // ws.onclose will fire after this
    };
  }

  // ========================================================================
  // 8. Init: load config → create pets → connect WS → start
  // ========================================================================

  async function init() {
    // Fetch config
    var resp = await fetch("/config.jsonc");
    if (!resp.ok) throw new Error("Failed to load config.jsonc: " + resp.status);
    var text = await resp.text();
    var raw = JSON.parse(stripJsonc(text));
    config = assertClientConfig(raw);
    // 扫描一遍各段动画的可见框（§9.28）：形状（SetWindowRgn）按它报，宽动画的像素才不被切。
    // 背景里一段一段来（decode 一次约 1~2s），起动不等它。
    prewarmInkBoxes();

    // 窗要开多大：只包住最大的那只宠物 + 头顶气泡 + 横向漫游行程（§9.25）。
    // 拿到配置就报，晚了窗会先按主进程那个 620x560 的默认大小摆一下再跳一下。
    reportWindowSize();

    // 主进程推来的显示器工作区（拖到屏幕边时靠它算出窗被夹住的那份差额，§9.25）。
    // 主进程在 did-finish-load 和显示器变化时才发，平常零开销。
    if (window.__petElectron__ && window.__petElectron__.onDisplays) {
      window.__petElectron__.onDisplays(function (list) { setDisplays(list); });
    }

    // Create pet instances
    var root = document.getElementById("pet-root");
config.pets.forEach(function (cfg, i) {
      var pet = new PetCard(cfg, root, i);
      pets.push(pet);
    });

    // 首次上报命中区。必须在这里发：构造期那只宠物还没进 pets，量不出矩形，
    // 而主进程起步只给 1×1 的命中点 —— 不发的话宠物出生后长时间点不到
    //（要等它漫游或冒气泡才会补上）。
    pushHitRegion();

    // Start all pets
    pets.forEach(function (pet) { pet.init(); });

    // 兜底：链子断一次宠物就消失（见 PetCard.watchdog）。1s 一跳，闲时零成本（只读 ended）。
    setInterval(function () {
      for (var i = 0; i < pets.length; i++) pets[i].watchdog();
    }, 1000);

    // ---- 睡 / 醒 的另外两个开关（见 4.7） ----
    //
    // ① 主进程：窗看不见的时候（最小化 / 屏保锁屏 / 挂起）喊我们冻住。
    //    这时候没人看，可满速解码 WebM 纯粹是把别人的合成预算抢走。
if (window.__petElectron__ && window.__petElectron__.onPower) {
      window.__petElectron__.onPower(function (sleep) {
        if (sleep) goSleep();
        else goWake();
      });
    }
    // ② 页签本身被切走（浏览器里打开的宠物页同理）：一样别产生帧
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) goSleep();
      else goWake();
    });

// Connect WebSocket
    connectWs();

    // 碎碎念：先排上第一句（§9.33）。没配 chatter 段就是 no-op。
    startChatter();
  }

  // ---- Start when DOM ready ----
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();