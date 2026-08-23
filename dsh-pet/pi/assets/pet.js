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
      if (!isFinite(size) || size <= 0) throw new Error("pet " + id + " size invalid");
      var corner = (p.position && p.position.corner) || "";
      if (!CORNER_SET[corner]) throw new Error("pet " + id + " corner invalid");
      var marginX = Number(p.position && p.position.marginX);
      var marginY = Number(p.position && p.position.marginY);
      if (!isFinite(marginX) || !isFinite(marginY)) throw new Error("pet " + id + " margin invalid");
      seen[id] = true;
      pets.push({ id: id, size: size, position: { corner: corner, marginX: marginX, marginY: marginY } });
    }

    // animations
    var a = raw.animations;
    if (!a || typeof a !== "object") throw new Error("missing animations");
    ["idle", "turn", "drag", "clicks"].forEach(function (k) {
      if (!Array.isArray(a[k])) throw new Error("animations." + k + " missing");
    });
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

    return { pets: pets, animations: a, animationWeights: w };
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
  // 5. PetCard class (port of pet.ts PetCard component)
  // ========================================================================

  /** Shared config (loaded from /config.jsonc + WebSocket update) */
  var config = null;

  function PetCard(cfg, rootEl) {
    var self = this;
    this.cfg = cfg;
    this.size = cfg.size;
    this.facing = "left";
    this.facingRef = "left";

    // ---- Derived ----
    var halfW = this.size / 2;
    var halfH = (this.size * 9) / 16 / 2;

    // ---- State ----
    this.anim = "";
    this.once = true;
    this.seq = 0;
    this.customPos = null; // {rx, ry}
    this.dragging = false;
    this.overrideAnim = null;  // WS-driven temporary override
    this.overrideTimer = null;

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

    // ---- Position (corner-based initial) ----
    applyPosition();
    window.addEventListener("resize", function () {
      if (self.customPos) applyPosition();
    });

    function applyPosition() {
      if (self.customPos) {
        var cp = self.customPos;
        var left = Math.min(Math.max(cp.rx * window.innerWidth - halfW, 0), window.innerWidth - self.size);
        var top = Math.min(Math.max(cp.ry * window.innerHeight - halfH, 0), window.innerHeight - (self.size * 9) / 16);
        container.style.left = left + "px";
        container.style.top = top + "px";
        container.style.right = "auto";
        container.style.bottom = "auto";
        return;
      }
      container.style.removeProperty("top");
      container.style.removeProperty("bottom");
      container.style.removeProperty("left");
      container.style.removeProperty("right");
      var corner = cfg.position.corner;
      if (corner === "bottom-right") { container.style.right = cfg.position.marginX + "px"; container.style.bottom = cfg.position.marginY + "px"; }
      else if (corner === "bottom-left") { container.style.left = cfg.position.marginX + "px"; container.style.bottom = cfg.position.marginY + "px"; }
      else if (corner === "top-right") { container.style.right = cfg.position.marginX + "px"; container.style.top = cfg.position.marginY + "px"; }
      else if (corner === "top-left") { container.style.left = cfg.position.marginX + "px"; container.style.top = cfg.position.marginY + "px"; }
    }

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
    // When mouse enters the hitbox → capture events (for drag/click).
    // When mouse leaves → passthrough to windows below.
    var passthrough = true;
    function setPassthrough(on) {
      if (passthrough === on) return;
      passthrough = on;
      if (window.__petElectron__) {
        window.__petElectron__.setPassthrough(on);
      }
    }
    hit.addEventListener("mouseenter", function () { setPassthrough(false); });
    hit.addEventListener("mouseleave", function () { setPassthrough(true); });

    // ---- Switch to animation (dual buffer crossfade) ----
    this.switchTo = function (next, nextOnce) {
      if (!next) return;
      var pending = self.pending;
      if (pending && pending.anim === next && pending.once === nextOnce) return;
      var gen = ++self.gen;
      self.pending = { anim: next, once: nextOnce, gen: gen };
      var target = self.frontIdx === 0 ? videoB : videoA;
      target.src = "/thumb/" + encodeURIComponent(next) + ".webm";
      target.loop = !nextOnce;
      target.onended = nextOnce ? handleEnded : null;

      var onReady = function () {
        target.removeEventListener("loadeddata", onReady);
        if (self.pending && self.pending.gen !== gen) return;
        var old = self.frontIdx === 0 ? videoA : videoB;
        target.classList.add("is-front");
        old.classList.remove("is-front");
        self.frontIdx = self.frontIdx === 0 ? 1 : 0;
        self.pending = null;
        target.style.transform = self.facingRef === "right" ? "scaleX(-1)" : "";
        target.play().catch(function () {});
        if (self.pendingMove) self.startMoveDrive(target);
      };
      target.addEventListener("loadeddata", onReady);
      if (target.readyState >= 2) onReady();
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
      // Turn anims flip facing on end
      if (anims.turn.indexOf(self.anim) >= 0) {
        var nextF = self.facing === "left" ? "right" : "left";
        self.facing = nextF;
        self.facingRef = nextF;
      }
      // Drag/click anims → return to idle
      if (anims.drag.indexOf(self.anim) >= 0 || anims.clicks.indexOf(self.anim) >= 0) {
        if (anims.idle.length) self.anim = pick(anims.idle, self.anim);
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true);
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
        container.style.left = px - halfW + "px";
        container.style.top = py - halfH + "px";
        container.style.right = "auto";
        container.style.bottom = "auto";
        if (t < duration - tailSec) self.moveRef = requestAnimationFrame(step);
        else {
          self.moveRef = null;
          self.customPos = { rx: targetRatio, ry: startYRatio };
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
      var dir = (self.facingRef === "right") !== (config.animations.turn.indexOf(self.anim) >= 0) ? 1 : -1;
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
      self.switchTo(chosen.name, true);
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

    // ---- Pointer events (click vs drag) ----
    hit.addEventListener("pointerdown", function (e) {
      e.currentTarget.classList.add("dragging");
      self.stopMove();
      setPassthrough(false); // capture during drag
      e.currentTarget.setPointerCapture(e.pointerId);
      var r = container.getBoundingClientRect();
      dragState = {
        active: true,
        dragging: false,
        sx: e.clientX,
        sy: e.clientY,
        offX: e.clientX - (r.left + r.width / 2),
        offY: e.clientY - (r.top + r.height / 2),
      };
    });

    hit.addEventListener("pointermove", function (e) {
      if (!dragState.active) return;
      var dx = e.clientX - dragState.sx;
      var dy = e.clientY - dragState.sy;
      if (!dragState.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        dragState.dragging = true;
        self.dragging = true;
        self.once = true;
        if (config.animations.drag.length) {
          self.anim = pick(config.animations.drag);
          self.switchTo(self.anim, true);
        }
      }
      container.style.left = e.clientX - dragState.offX - halfW + "px";
      container.style.top = e.clientY - dragState.offY - halfH + "px";
      container.style.right = "auto";
      container.style.bottom = "auto";
      stage.style.transform = "none";
    });

    hit.addEventListener("pointerup", function (e) {
      var wasDragging = dragState.dragging;
      dragState.active = false;
      dragState.dragging = false;
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
        self.customPos = { rx: (e.clientX - dragState.offX) / window.innerWidth, ry: (e.clientY - dragState.offY) / window.innerHeight };
        stage.style.transform = "translateY(" + bottomPad + "px)";
        if (config.animations.idle.length) self.anim = pick(config.animations.idle, self.anim);
        self.once = false;
        self.switchTo(self.anim, false);
      }
    });

    hit.addEventListener("pointercancel", function (e) {
      hit.dispatchEvent(new PointerEvent("pointerup", e));
    });

    hit.addEventListener("click", function () {
      if (dragState.active || dragState.dragging || self.justDragged) return;
      if (self.once && config.animations.idle.indexOf(self.anim) < 0) return;
      self.stopMove();
      self.once = true;
      if (config.animations.clicks.length) {
        self.anim = pick(config.animations.clicks);
        self.switchTo(self.anim, true);
      }
    });

    hit.addEventListener("mouseenter", function (e) {
      if (!dragState.active) e.currentTarget.style.cursor = "grab";
    });
    hit.addEventListener("mouseleave", function (e) {
      if (!dragState.active) e.currentTarget.style.cursor = "grab"; // default
    });

    // ---- Override: WebSocket forces a specific animation ----
    this.playOverride = function (animName, durationMs) {
      self.stopMove();
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      self.anim = animName;
      self.once = false; // loop while override active
      self.seq++;
      self.switchTo(animName, false);
      if (durationMs && durationMs > 0 && isFinite(durationMs)) {
        self.overrideTimer = setTimeout(function () {
          resetToChain();
        }, durationMs);
      }
    };

    function resetToChain() {
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      self.overrideTimer = null;
      self.stopMove();
      // Return to idle, then pickNext will fire on ended
      if (config.animations.idle.length) {
        self.anim = pick(config.animations.idle);
        self.once = true;
        self.seq++;
        self.switchTo(self.anim, true);
      }
    }

    this.destroy = function () {
      self.stopMove();
      if (self.overrideTimer) clearTimeout(self.overrideTimer);
      container.remove();
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

  var pets = []; // PetCard instances
  var addPetSeq = 0; // counter for auto-generated pet ids

  /** Maps size arg to px width */
  var SIZE_MAP = { small: 260, normal: 400, large: 540 };

  /** Create a new pet at a random corner (called on /pet when window already running) */
  function addPet(sizeArg) {
    if (!config) return;
    sizeArg = sizeArg || "normal";
    addPetSeq++;
    var corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    var corner = corners[Math.floor(Math.random() * corners.length)];
    var size = SIZE_MAP[sizeArg] || SIZE_MAP.normal;
    var cfg = {
      id: "auto-" + addPetSeq,
      size: size,
      position: { corner: corner, marginX: 30 + Math.floor(Math.random() * 60), marginY: 30 + Math.floor(Math.random() * 120) }
    };
    var root = document.getElementById("pet-root");
    var pet = new PetCard(cfg, root);
    pets.push(pet);
    pet.init();
  }

  /** Apply an event override to all pets */
  function applyEventOverride(anim) {
    pets.forEach(function (pet) {
      pet.playOverride(anim, OVERRIDE_DURATION_MS);
    });
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
    };

    ws.onmessage = function (event) {
      var msg = event.data;
      // Try JSON first
      try {
        var obj = JSON.parse(msg);
        if (obj.type === "tool_call") {
          applyToolOverride(obj.tool);
          return;
        }
      } catch (_) { /* plain string */ }

      // Plain string events
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
      var banner = document.getElementById(DISCONNECT_BANNER_ID);
      if (banner) banner.classList.add("show");
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

    // Create pet instances
    var root = document.getElementById("pet-root");
    config.pets.forEach(function (cfg) {
      var pet = new PetCard(cfg, root);
      pets.push(pet);
    });

    // Start all pets
    pets.forEach(function (pet) { pet.init(); });

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