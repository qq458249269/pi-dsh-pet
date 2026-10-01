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
   *   idleSleepMs  多久没动静就把动画**整个冻住**（毫秒，0 = 不冻，见 4.7）
   *
   * 这三个数是同一件事的三头：minPlayMs 治「动画没演完就被切一半」，
   * idleDwellMs 治「待机太短，一口气连着演、看着一直忙个不停」，
   * idleSleepMs 治「一直在动，把别的窗口的渲染预算都抢走了」（见 4.7）。
   *
   * ⚠️ 用户要求：**每段动画的播放时间统一延长 5 秒**，免得看着总在「切来切去」不停歇。
   *   于是三个默认数都在原基础上 +5000ms（2.6s→7.6s / 6s→11s / 45s→50s）。
   *   写进 config.jsonc 的 timing 优先（配置里没写才用这几个默认值）。
   */
  var TIMING_DEFAULT = { minPlayMs: 7600, idleDwellMs: 11000, idleSleepMs: 50000 };

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
      idleSleepMs: num("idleSleepMs", TIMING_DEFAULT.idleSleepMs),
    };
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

    return { pets: pets, animations: a, animationWeights: w, timing: readTiming(raw.timing) };
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
  /** 气泡行高（13px × 1.45 ≈ 18.85），算「头顶能塞几行」用（见 clampBubble） */
  var BUBBLE_LINE_H = 18.85;
  /** 「说点什么…」输入框自己占的高度（input 30 + 下边距 6 + 余量） */
  var BUBBLE_INPUT_H = 44;
  /** 气泡头顶要让出来的：外边距 10 + 贴边 8。
      （尾巴那 6px 是画在气泡框**下面**的，正好落在 10px 的外边距里，不占头顶空间；
        早先按 36 算，白白少给一行 —— 见 §9.21 的实测） */
var BUBBLE_CHROME_H = 18;
  /** 气泡与容器之间的外边距（pet.css 的 margin-bottom / .below 的 margin-top）。
      算「无偏移时气泡在哪」时必须算上它，忘了就恒差 10px（实测偏移差 10）。 */
  var BUBBLE_GAP = 10;
  /**
   * 舞台窗的留白（§9.24）：窗 = 宠物 + 四边 padding。
   *
   * 配置里的 marginX/marginY 当**下限**用：比 padding 小的抬到 padding。理由：
   *   ① 头顶那截不是装饰，是气泡的舞台（150 = 6 行字 113 + 贴边 18，实测）；
   *   ② 左右那截只当「动画离窗边的余量」（24px）—— 宽气泡**不再**靠它，
   *      窗宽改成**跟着动画走**（下面 stageSize），气泡封顶 = min(窗宽-16, BUBBLE_W_MAX)。
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
  /** 气泡封顶：再宽也不超过这个数（超宽气泡会横跨半个屏，看着不像「宠物说话」） */
  var BUBBLE_W_MAX = 820;
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
   * 站位记忆（customPos）套回来时，宠物在**窗里**能站的范围。
   *
   * ⚠️ 为什么只管站位，不管漫游/拖动（clampPos 仍是 0 起夹）：
   *   留白是**气泡的舞台**。站位是「上次停哪儿」，会被 resize 反复重新套用；
   *   实测那条把宠物钉在窗顶的记录（ry 算出来正好 0）套上后头顶 0 留白，
   *   气泡被压成 846x24 的一条、字全裁没了（§9.23）。
   *   漫游只改 left 不改 top（纵向由站位打底），横向窗里还有整条漫游道可夹。
   *
   * ⚠️⚠️ 横向的下界从 STAGE_PAD_X 改成 **0**（§9.25）：贴边是**屏幕**上的概念，
   *   而窗和宠物的偏移是两个自由度。夹在 32 就等于「永远不许宠物贴到窗边」——
   *   拖到屏幕边（窗也被夹到屏幕边）时宠物还差 32，而且下次启动这 32 还会把它拽回来。
   *   横向留白的气泡问题 clampBubble 已经管了（它按**窗**夹），不需要在这儿再留一道。
   *   纵向仍留 topOffsetOf：站位是要重复套用的，头顶必须一直有气泡的舞台。
   *
   * ⚠️ 窗比「宠物 + 两侧留白」还窄时（多开时窗按最大的那只算，小的那只就在区间外）
   *   区间会翻过来，这时取中间值而不是硬贴左边 —— 否则照样贴到窗边、同样没头顶。
   */
function stageKeepIn(left, top, size, cfg) {
    var petH = (size * 9) / 16;
    var W = window.innerWidth;
    var H = window.innerHeight;
    var loX = 0;
    var hiX = W - size;
    if (hiX < loX) loX = hiX = Math.max(0, (W - size) / 2);
    var loY = topOffsetOf(cfg);
    var hiY = H - petH - bottomPadOf(cfg);
    if (hiY < loY) loY = hiY = Math.max(0, (H - petH) / 2);
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
  // 4.7 空闲休眠（别抢别的窗口的渲染预算）
  //
  // 症状：这扇窗是**全屏透明 + 置顶**的。它每产生一帧，DWM 就得把整块桌面重新合成一遍
  // （连带下面所有窗口一起）。而待机链本来就在不停地抽动画 —— 于是宠物永远有新帧，
  // 别的程序（浏览器、IDE、播放器）的后台窗口就抢不到合成预算了：
  // 「桌宠一开，别人的窗口就不刷新 / 卡成幻灯片」。
  //
  // 修法只有一个原则：**没事的时候别产生帧**。
  //   · 空闲超过 timing.idleSleepMs（默认 45s）→ 冻在当前那一帧：
  //     视频 pause()、漫游的 rAF 停、命中区不再上报。逻辑（定时器）还留着，
  //     所以醒来时状态机还在原地，不会有「要重新选一段动画」的突变。
  //   · 任何活动立刻醒：WS 事件（思考中/写代码/气泡）、鼠标碰到宠物、右键菜单、
  //     「说点什么」输入框、窗尺寸变了。
  //   · 主进程也会喊：窗被最小化 / 屏保锁屏 / 系统挂起 → 睡（pet:power，见 pet-electron.cjs）。
  //   · 用户手动开的省电模式（右键菜单）是无条件的，睡到他自己关掉为止。
  //
  // 睡 ≠ 暂停响应（那个是「不理 agent 状态」）：省电时气泡文字照常更新，
  // 只是没有新帧而已。
  // ========================================================================

  var sleepTimer = null;
  var asleep = false;    // 冻住了吗（= 全屏一帧都不再产生）
  var powerSave = false; // 用户手动开的省电模式：没它就别自动醒
  var lastMoveActivity = 0;

  function idleSleepMs() {
    var ms = config && config.timing ? Number(config.timing.idleSleepMs) : TIMING_DEFAULT.idleSleepMs;
    return isFinite(ms) && ms >= 0 ? ms : TIMING_DEFAULT.idleSleepMs;
  }

  /** 睡：所有宠物冻在当前帧。
   *  ⚠️ 不因为「已经 asleep」就早退：省电模式下新加一只宠物时，它照样得冻住
   *  （PetCard.sleep/wake 自己幂等，这里只是多走一遍）。
   */
  function goSleep() {
    asleep = true;
    for (var i = 0; i < pets.length; i++) {
      if (pets[i] && typeof pets[i].sleep === "function") pets[i].sleep();
    }
  }

  /** 醒：接着当前这一帧往下放（pause/play 不改 currentTime，不会跳回第一帧）。 */
  function goWake() {
    asleep = false;
    for (var i = 0; i < pets.length; i++) {
      if (pets[i] && typeof pets[i].wake === "function") pets[i].wake();
    }
  }

/** 有活动了：先醒，再把空闲计时器推后。窗里所有的用户输入/事件入口都走这里。 */
  function noteActivity() {
    if (asleep && !powerSave) goWake();
    armIdle();
  }

  /** 指针是不是真落在宠物（含它的气泡/输入框）上。
   *  ⚠️ 这扇窗是 setIgnoreMouseEvents(true, { forward: true })：整个窗的 mousemove
   *  都会被转发到渲染进程（包括宠物以外的整块屏幕）。照单全收的话，用户随便动一下
   *  鼠标就永远睡不着了（等于没做）。所以必须问一句「指针真在宠物身上吗」。
   */
  function pointerOnPet(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return false;
    return !!el.closest(".pet-hit, .pet-bubble");
  }

  /** 重排「多久没动静就睡」。省电模式 = 立刻睡，且只有用户自己能让它醒。 */
  function armIdle() {
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (powerSave) {
      goSleep();
      return;
    }
    var ms = idleSleepMs();
    if (!(ms > 0) || !pets.length) return;
    sleepTimer = setTimeout(function () {
      sleepTimer = null;
      if (powerSave || !pets.length) return;
      goSleep();
    }, ms);
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

    /**
     * 把容器位置夹回屏幕内。不夹的话宠物能被拖到只剩半个身子在屏幕里（头顶的气泡
     * 跟着出屏，再被主进程的 SetWindowRgn 裁一刀，看着就像「气泡被切了一半」）。
     * extraBottom = 舞台额外的下移量（站位对齐脚底用的），算下边界时算进去。
     */
    function clampPos(left, top, extraBottom) {
      var maxLeft = Math.max(0, window.innerWidth - halfW * 2);
      var maxTop = Math.max(0, window.innerHeight - halfH * 2 - (extraBottom || 0));
      return {
        left: Math.min(Math.max(left, 0), maxLeft),
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
      noteActivity(); // resize = 用户动了窗
      // ⚠️ 每次 resize 都要重新摆位（§9.26）：居中位置是按**窗宽**算的，
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
        // 站位也要给气泡留舞台（§9.23）
        var keep = stageKeepIn(cp.rx * window.innerWidth - halfW, cp.ry * window.innerHeight - halfH, self.size, cfg);
        container.style.left = keep.left + "px";
        container.style.top = keep.top + "px";
        container.style.right = "auto";
        container.style.bottom = "auto";
        // 夹完把内存里的落点也改回实际值：不改的话漫游起点（currentCenterX/Y 读的是
        // customPos）会从「夹之前」那个点算，宠物在窗里先跳一下再走。
        self.customPos.rx = (keep.left + halfW) / window.innerWidth;
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
container.style.left = centeredLeft(self.size, self.slot, Math.max(pets.length, self.slot + 1)) + "px";
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
      noteActivity(); // 鼠标碰到宠物 = 有活动（冻着的宠物靠这个醒，见 4.7）
      setPassthrough(false);
      hit.style.cursor = "grab";
      self.setHover(true);
    });
    hit.addEventListener("mouseleave", function () {
      noteActivity();
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
      noteActivity(); // 右键菜单也总是「有人在看」
      if (!window.__petElectron__ || !window.__petElectron__.openMenu) return;
      bubbleTarget = self;
      window.__petElectron__.openMenu({
        state: describeState(self),
        size: self.size,
        facing: self.facing,
        pets: pets.length,
      });
    });

    // ---- Speech bubble + manual input ----
    // The bubble hangs above the pet and is reused for every message (state text and
    // anything a human types). It is NOT part of the v1 wire format: the host sends
    // {"type":"bubble",...} and we only render it, so an old window ignores the frame.
    var bubble = document.createElement("div");
    bubble.className = "pet-bubble";
    bubble.style.display = "none";
    // 文案单独占一个节点：直接 bubble.textContent = 文案 会把同级的输入框节点一起删掉
    // （之后 askSay 拿到的就是个脱离 DOM 的 input，「说点什么…」框永远出不来）。
    var bubbleText = document.createElement("span");
    bubbleText.className = "pet-bubble-text";
    bubble.appendChild(bubbleText);
    container.appendChild(bubble);
    self.bubbleEl = bubble; // 命中区要把头顶的气泡算进去

    var bubbleTimer = null;

  /** 气泡贴到屏幕边（宠物拖到边角）时把它挪回来，不然半边在屏幕外 = 看着被切了一半。
        偏移走 left/bottom（不在 transition 里，改完立刻到位，不会一边补一边抖）。 */
self.clampBubble = function () {
      if (!bubble.classList.contains("show")) return;
      var r = bubble.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) return;
      var W = window.innerWidth;
      var H = window.innerHeight;

      // ---- 高度：按头顶**真实**空间收（§9.21）----
      // 以前高度交给 CSS 的「最多三行」：宠物贴上边时（corner: top-*,top = marginY）
      // 头顶只有 marginY 那么点，一行都塞不下，气泡要么顶出窗外被切，要么被挤到宠物身上。
      // 现在按容器顶到窗顶的距离算能塞几行，写 max-height + 行数，两个方向都封死。
      var cr = container.getBoundingClientRect();
      // ---- 头顶没地方就挂身下（§9.25）----
      // 贴边是**允许**的了（拖到屏幕上边时头顶就是 0），这时气泡必须换边，不然
      // 「贴边贴上了、话却说不出来」。下面更宽就挂下面（宠物脚底下有 bottomPad 那截）。
var roomAbove = Math.max(0, Math.round(cr.top - BUBBLE_CHROME_H));
      var roomBelow = Math.max(0, Math.round(H - cr.bottom - BUBBLE_CHROME_H));
      var below = roomBelow > roomAbove;
      var room = Math.max(24, below ? roomBelow : roomAbove);
      cr = container.getBoundingClientRect(); // 上面被写样式弄脏了？重拿一份干净的（下方 baseL/baseT 用它）
      var withInput = bubble.classList.contains("with-input");
      if (withInput) {
        // 输入框在气泡**底部**（bubbleText 之后 append），封整个气泡会把框裁掉
        // → 只封文字，把框那 44px 留出来。
        bubble.style.removeProperty("max-height");
        bubble.style.removeProperty("-webkit-line-clamp");
        bubbleText.style.display = "block";
        bubbleText.style.maxHeight = Math.max(20, room - BUBBLE_INPUT_H) + "px";
        bubbleText.style.overflow = "hidden";
      } else {
        bubbleText.style.removeProperty("max-height");
        bubbleText.style.removeProperty("overflow");
        if (bubbleText.style.display) bubbleText.style.removeProperty("display");
        bubble.style.maxHeight = room + "px";
        var lines = Math.max(1, Math.min(6, Math.floor((room - 14) / BUBBLE_LINE_H)));
        bubble.style.webkitLineClamp = String(lines);
      }

      // 换边（class 管位置与尾巴方向；两个方向都要先清掉另一个方向的内联值，
      // 不然上一轮写下的 bottom/top 会和这一轮的 top/bottom 叠着算，位置飘）。
      // ⚠️ 这里的比较是 **!=**（量过的坑）：写成 == 就是「已经在这一侧时才切」，
      //   等于永远不切 —— 结果 room 算的是「身下」的值、位置也按身下写，class 却是头顶，
      //   top/bottom 同时被指定 → 高度被压成只剩内边距（实测贴上边时气泡 16px 高）。
      if (below !== bubble.classList.contains("below")) {
        bubble.classList.toggle("below", below);
        bubble.style.removeProperty("top");
        bubble.style.removeProperty("bottom");
        if (below) bubble.style.removeProperty("left");
      }
      // ⚠️⚠️ 高度/换边写完之后**必须重新量**：上面那两步会改变几何 ——
      //   ① max-height / 行数一变，文字重新折行，**宽度也跟着变**（实测 63 字在
      //      622px 宽下折 2 行、在 574px 下折 3 行，宽度差 48px）；
      //   ② 换边后 top/bottom 换了一套，位置全变。
      //   拿旧几何算 dx/dy = 把气泡夹在旧位置上（实测贴右边时探出窗边 40px，
      //   而 showBubble 那次「下一帧再夹」也救不回来：文字宽度不再变，夹取也认为
      //   自己是对的）。这里量的是布局，代价可以忽略。
      r = bubble.getBoundingClientRect();
      if (!r || !(r.width > 0) || !(r.height > 0)) return;

var dx = 0;
      // dy 的口径：**正值 = 往下挪**（两个方向各按各的来）
      var dy = 0;
      // ⚠️⚠️ 偏移是**绝对**的，不是增量（实测踩过的坑：算增量、写绝对）。
      //   写下去的是 `left: calc(50% ± X)` —— X 是相对「容器水平居中位」的**总偏移**，
      //   每次写都把上一次的 X 顶掉。而「差多少」的算法（dx = 8 - r.left）算的是增量：
      //   容器一动，气泡跟着容器平移（`50%` 是相对容器的），读到的 r.left 已经是新位置，
      //   于是每次只补回一部分，实测往左拖时气泡在 -42 / -30 之间来回磨（欠 40px），
      //   贴右边同理探出窗边 40px，而且**永远夹不准**（离得越远差得越多）。
      //   正确算法：先把「X=0 时气泡的绝对左边」算出来，再把想要的绝对位置减掉它。
var baseL = cr.left + (cr.width - r.width) / 2;
      // 竖向的「居中位」：头顶那套是 bottom:100% + margin-bottom，身下那套是 top:100% + margin-top
      //（都写在 pet.css 里，10px；忘了算它，偏移就会恒差 10px）。
      var baseT = below ? cr.bottom + BUBBLE_GAP : cr.top - BUBBLE_GAP - r.height;
      var wantL = r.left;
      var wantT = r.top;
      if (wantL < 8) wantL = 8;
      else if (r.right > W - 8) wantL = W - 8 - r.width;
      // 挂头顶时越界 = 顶出窗顶；挂身下时越界 = 掉出窗底。
      // （另一个方向不会越界：高度已经按「那边的真实空间」封死了。）
      if (below) {
        if (r.bottom > H - 8) wantT = H - 8 - r.height;
        else if (r.top < 8) wantT = 8;
      } else {
        if (r.top < 8) wantT = 8;
        else if (r.bottom > H - 8) wantT = H - 8 - r.height;
      }
      dx = Math.round(wantL - baseL);
      dy = Math.round(wantT - baseT);
      // 写一样的值没有代价，但每帧都写新值会让浏览器白排一次版
      if (!dx) bubble.style.removeProperty("left");
      else bubble.style.left = "calc(50% + " + Math.round(dx) + "px)";
      if (below) {
        if (!dy) bubble.style.removeProperty("top");
        else bubble.style.top = "calc(100% " + (dy > 0 ? "+ " : "- ") + Math.round(Math.abs(dy)) + "px)";
        bubble.style.removeProperty("bottom");
      } else {
        if (!dy) bubble.style.removeProperty("bottom");
        else bubble.style.bottom = "calc(100% " + (dy > 0 ? "- " : "+ ") + Math.round(Math.abs(dy)) + "px)";
        bubble.style.removeProperty("top");
      }
    };

    self.showBubble = function (text, opts) {
      opts = opts || {};
      var t = String(text == null ? "" : text);
      if (!t) return;
      noteActivity(); // 有话说 = 有活动（气泡靠这个醒）
      if (bubbleText.textContent !== t) bubbleText.textContent = t;
      bubble.classList.add("show");
      bubble.classList.toggle("sticky", opts.sticky === true);
      bubble.style.display = "";
      self.clampBubble();
      // 再夹一次：刚 show 出来那下量到的可能是**上一段文案**留下的布局（宽度、行数
      // 都还没按新文案排完），于是 dx/dy 算在旧几何上 → 气泡右侧探出窗边被切掉
      // （§9.21 实测：显示后 586 宽的气泡右缘超出窗 38px，下一帧才夹回来）。
      // 下一帧再夹一次就稳了 —— 这是布局，不是动画，代价可以忽略。
      requestAnimationFrame(function () { self.clampBubble(); });
      pushHitRegion(); // 气泡会改变命中区（它在宠物头顶）
      if (bubbleTimer) clearTimeout(bubbleTimer);
      var ms = Number(opts.ms) || 0;
      // sticky = 状态还在：不清计时器，靠宿主每 10s 的续期帧接着
      if (!opts.sticky && ms > 0) {
        bubbleTimer = setTimeout(function () {
          bubble.classList.remove("show");
          bubbleTimer = null;
        }, ms);
      }
    };
    self.hideBubble = function () {
      if (bubbleTimer) clearTimeout(bubbleTimer);
      bubbleTimer = null;
      bubble.classList.remove("show");
      pushHitRegion();
    };

    // 「说点什么…」：输入框就长在气泡里。Enter 提交，Esc 取消。
    // 提交走主进程 → 宿主 /control（只有主进程手里有 token）。
    var input = document.createElement("input");
    input.className = "pet-bubble-input";
    input.type = "text";
    input.maxLength = 80;
    input.placeholder = "说点什么…（Enter 发送）";
    // 亮不亮全看 class：写内联 display:none 的话优先级压过 .on{display:block}，框永远出不来
    input.classList.remove("on");
    bubble.appendChild(input);
    bubble.classList.add("has-input");

    /** 输入框开着？（主进程靠这个决定要不要把窗切成可聚焦） */
    var inputOpen = false;

    /** 收工：清框、藏气泡、告诉主进程把键盘焦点还给下面的窗口。所有关闭路径都走这里。 */
    function closeInput() {
      if (!inputOpen) return;
      inputOpen = false;
      input.value = "";
      input.classList.remove("on");
      bubble.classList.remove("with-input");
      self.hideBubble();
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
    }

    self.askSay = function () {
      inputOpen = true;
      noteActivity(); // 输入框开着期间不许睡（不然打字时宠物是冻着的）
      bubble.classList.add("show");
      bubble.classList.add("with-input");
      input.classList.add("on"); // ⚠️ 不能写 style.display = ""：样式表里的 display:none
      //    优先级更高，空的内联样式等于「按样式表来」，框还是出不来
      bubble.style.display = "";
      self.clampBubble();
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
        self.playedAt = Date.now();
        target.style.transform = self.facingRef === "right" ? "scaleX(-1)" : "";
        if (!self.asleep && target.paused) target.play().catch(function () {});
        if (self.pendingMove && !self.asleep) self.startMoveDrive(target);
      };
      /** loadeddata 只说明解码器交出了首帧，合成器还没把它贴上去；那时候换手就是闪一帧空白。 */
      var onReady = function () {
        target.removeEventListener("loadeddata", onReady);
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
      target.addEventListener("loadeddata", onReady);
      if (target.readyState >= 2) onReady();
    };

    /**
     * 把「马上要演的那一段」先塞进**后台那个缓冲区**（不换手、不改播放状态）。
     * 用途：鼠标按下去的那一刻就把拖拽姿势预热好 —— 真正拖起来（过了 DRAG_THRESHOLD）
     * 时那一段的首帧早就解好了，换手是零延迟的硬切，而不是「先拿旧姿势顶着 40ms」。
     * 反过来，不预热的话抓起宠物会有一下可察觉的停顿。
     */
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
          var mp = clampPos(px - halfW, py - halfH, bottomPad);
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

    this.tryMove = function () {
      if (self.moveRef !== null || self.pendingMove) return true;
      var moves = config.animations.moves;
      var actions = moves.actions;
      if (!actions.length) return false;
      var chosen = actions[Math.floor(Math.random() * actions.length)];
      var mp = Object.assign({}, moves.default, chosen.params || {});
      var dir = (self.facingRef === "right") !== (config.animations.turn.indexOf(self.playing || self.anim) >= 0) ? 1 : -1;
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
        halfW: halfW,
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
      if (self.warmAnim && config.animations.drag.length) self.warmAnim(pick(config.animations.drag));
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
      var left = Math.min(Math.max(d.base.x + (want.x - at.x), 0), Math.max(0, winW - self.size));
      // 纵向算上下移量（脚底对齐 translateY），不然拖到窗底时脚底那截会挂到窗外
      var top = Math.min(Math.max(d.base.y + (want.y - at.y), 0), Math.max(0, winH - halfH * 2 - bottomPad));
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
      noteActivity(); // 拖拽中也得盯着：不然拖到一半睡了就“松手了它不动”
      // 窗只包住宠物（见 pet-electron.cjs 文件头），所以在 Electron 里「拖宠物」
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
        self.dragging = true;
        self.once = true;
if (config.animations.drag.length) {
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
      // 拖拽也要夹在屏幕内（舞台的下移量这时是 none，所以按 halfH 算下边界）
      var dp = clampPos(e.clientX - dragState.offX - halfW, e.clientY - dragState.offY - halfH, 0);
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
   *   宽：宠物宽 + 左右各 STAGE_PAD_X（气泡封顶 = 窗宽 - 32，见 applyBubbleMaxWidth）
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
    applyBubbleMaxWidth(s.w, s.petW);
    var api = window.__petElectron__;
    if (!api || !api.setWindowSize || !config) return;
    try {
      // 宽度按内容自适应（§9.24）：stageSize 算的宽是 max(动画宽, 气泡基准宽) + 余量，
      // 这里不再自己加 padding —— 加两遍就是白留（§9.22 就是这么白留的）。
      api.setWindowSize(s.w, s.h);
    } catch (e) {
      /* 主进程还没 ready：那就用它的默认尺寸，窗也不会因此坏掉 */
    }
  }

  /**
   * 舞台窗该多大（纯计算，不碰 DOM）：报尺寸、摆位置、气泡封顶三处共用一份。
   * ⚠️ 别把它散回两个函数里各算一遍：上一轮就是「窗按一个公式、气泡按另一个常量」，
   *   两边对不上，留白就成了白留（见 §9.22）。
   */
  function stageSize() {
    var maxW = 0;
    var topOff = 0;
    var botPad = 0;
    var sidePad = 0;
    (config && config.pets ? config.pets : []).forEach(function (cfg) {
      var s = petSizeOf(cfg);
      if (!(s > maxW)) return;
      maxW = s;
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
    if (!maxW) maxW = 400;
    if (maxW < MIN_PET_SIZE) maxW = MIN_PET_SIZE;
    var petH = Math.round((maxW * 9) / 16);
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
    var w = maxW + sidePad * 2 + roamRoom(sidePad);
    return {
      petW: maxW,
      w: w,
      h: Math.max(Math.round((MIN_PET_H * 16) / 9), topOff + petH + botPad),
    };
  }

  /**
   * 气泡能有多宽（写进 CSS 变量 --bubble-max-w，pet.css 那侧只读它）。
   *
   * = min(窗宽 − 16, 围着宠物的那圈, BUBBLE_W_MAX)：
   *   窗宽 − 16 是 clampBubble 夹得住的上限（左右各留 8）；
   *   ⚠️ 窗宽不再直接当封顶（§9.25）：横向多出来的那截是**漫游行程**，不是给气泡的 ——
   *     拿窗宽当封顶，气泡就会宽过动画近一倍（窗 740 / 动画 380 → 气泡 724），
   *     宠物一漫游到道的一头，clampBubble 把它推到贴一边，看着就是「歪」。
   *     气泡该围着**宠物**长：宠物宽 + 160，下限 420。
   *   BUBBLE_W_MAX 封顶，免得小屏上横跨半个屏。
   * ⚠️ 这个数是**外框**宽（.pet-bubble 是 border-box）：按内容盒算的话会差
   *   24px padding + 2px border，气泡就比窗宽，夹取永远夹不住（§9.22）。
   */
  function applyBubbleMaxWidth(winW, petW) {
    try {
      var w = Math.min(Math.max(240, Math.round(winW) - 16), BUBBLE_W_MAX);
      var around = Math.max(420, (Number(petW) || 0) + 160);
      w = Math.min(w, Math.round(around), BUBBLE_W_MAX);
      document.documentElement.style.setProperty("--bubble-max-w", w + "px");
    } catch (e) {
      /* 老浏览器不支持自定义属性：CSS 里那个兜底值还在 */
    }
  }

/** Maps size arg to px width.
      ⚠️ 最小档别再往小了：气泡是 16:9 舞台头顶的 max-content 块（最宽 420px），舞台太窄时
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
    // 新宠物进屋：既重新起计空闲计时器，醒来晚了也得马上把它冻住
    //（省电模式下 init() 会 play()，不补这一下新来的就在满速放）
    if (asleep) pet.sleep();
    noteActivity();
    applySavedPositions(); // 新加的这只也认得「上次的位置」（id 认不出就单只借位，见 4.6）
    pushHitRegion(); // 进了 pets 才量得到它（构造时它还没进数组）
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
    else {
      goWake();
      armIdle();
    }
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
      noteActivity();
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
          noteActivity(); // 位置帧会让宠物挪窝，得先醒（不然报告的形状停在老地方）
          savedPositions = obj.map && typeof obj.map === "object" ? obj.map : {};
          applySavedPositions();
          return;
        }
      } catch (_) { /* plain string */ }

      // Plain string events
      noteActivity(); // 宿主来了消息 = 有人在用（agent 干活时宠物该一直醒着）
      var anim = EVENT_ANIM_MAP[msg];
      if (anim) {
        applyEventOverride(anim);
      } else if (msg === "agent_idle") {
        // pets return to chain naturally via override timeout
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
      noteActivity(); // 掉线提示条要能显示出来（睡着的窗不更新形状，提示条会被裁掉）
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

    // ---- 睡 / 醒 的另外两个开关（见 4.7） ----
    //
    // ① 主进程：窗看不见的时候（最小化 / 屏保锁屏 / 挂起）喊我们冻住。
    //    这时候没人看，可满速解码 WebM 纯粹是把别人的合成预算抢走。
    if (window.__petElectron__ && window.__petElectron__.onPower) {
      window.__petElectron__.onPower(function (sleep) {
        if (sleep) goSleep();
        else {
          goWake();
          armIdle();
        }
      });
    }
    // ② 页签本身被切走（浏览器里打开的宠物页同理）：一样别产生帧
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) goSleep();
      else {
        goWake();
        armIdle();
      }
    });
// ③ 全局活动：指针真的落在宠物身上、或者按键/滚轮 → 有活动。
    //    mousemove 在漫游/拖拽时能到每秒 60 次，所以自己限流（1s 一次就够续命了）。
    //    ⚠️ 穿透窗会把**整个窗**的 mousemove 都转发过来（见 pointerOnPet），
    //    不查「指针在不在宠物上」的话，用户动一下鼠标就永远不睡了。
    document.addEventListener(
      "mousemove",
      function (e) {
        var now = Date.now();
        if (now - lastMoveActivity < 1000) return;
        lastMoveActivity = now;
        if (!pointerOnPet(e.clientX, e.clientY)) return;
        noteActivity();
      },
      { passive: true }
    );
    ["keydown", "wheel"].forEach(function (ev) {
      document.addEventListener(ev, noteActivity, { passive: true });
    });

    // 从这儿开始计时：开播前就空转计时器等于白算一次
    armIdle();

    // Connect WebSocket
    connectWs();
  }

  // ---- Start when DOM ready ----
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();