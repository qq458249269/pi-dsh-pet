# dsh-pet 🐾

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/dsh-pet?label=monthly&color=brightgreen"></a>
  <a href="https://www.npmjs.com/package/dsh-pet"><img alt="total downloads" src="https://img.shields.io/npm/dt/dsh-pet?label=total&color=success"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/PC2005-cloud/dsh-pet?style=social"></a>
  <a href="https://github.com/PC2005-cloud/dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/PC2005-cloud/dsh-pet?color=orange"></a>
  <a href="https://awesome-dsh-plugin.com"><img alt="awesome dsh plugin" src="https://awesome-dsh-plugin.com/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="pi" src="https://img.shields.io/badge/platform-pi%20coding%20agent-6C5CE7">
  <img alt="assets" src="https://img.shields.io/badge/assets-dynamic%20animations-ff69b4">
</p>

> 🙏 **Thanks to the original project**
> This project is forked from [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet). Huge thanks to the original author for the beautiful hand-drawn transparent animation assets (91 WebM files) and the polished animation engine. The pi extension builds on this foundation, adding Electron fullscreen transparent overlay, pi event reactivity (thinking/coding/idle states mapped to animations), and cross-session persistence — so the pet can keep you company not just inside DSH Web, but also in your pi terminal coding agent.

> A floating desktop pet for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI **and** the [pi coding agent](https://github.com/pi): idle breathing, random actions, screen wandering, and pi event reactivity.

---

## 📦 Installation

| Platform             | Install                                         |
| -------------------- | ----------------------------------------------- |
| **DeepSeek Harness** | `dsh plugin --profile web add dsh-pet`          |
| **pi coding agent**  | `npm install -g dsh-pet`, then run `/pet` in pi |

> 💡 Want to craft your own pet? Clone [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) and use the bundled asset pipeline to generate one from scratch — fully reproducible.

## 🚀 pi Platform Quick Start

```sh
npm install -g dsh-pet
```

In pi:

```
/pet      →  Open the pet window (Electron fullscreen transparent overlay; first run downloads Electron ≈100MB)
/pet-stop →  Close the pet window
```

The pet reacts to pi's working state:

- 🧠 **Deep thinking** — plays "deep thinking" animation when the agent is reasoning
- 💻 **Coding** — plays "writing code" animation on bash/edit/write tool calls
- 😴 **Idle** — returns to the random animation chain when the agent settles

> The pet persists across sessions within the pi process lifetime.

## ✨ Features

- **A pure pet, nothing else**: just a companion. Zero core changes, zero model cost
- **Dual-platform**: DSH Web UI (React component) + pi terminal agent (Electron fullscreen overlay)
- **pi event reactivity**: senses agent thinking/tool-call/idle states and switches animations
- **Hand-drawn transparent animations** (91 total): idle breathing, dozing, Rubik's cube, humming, coding, seasonal actions — all seamlessly chained
- **Never-ending animation chain**: next animation picked by probability (30% idle / 10% turn / 40% action / 20% move)
- **Screen wandering**: walks toward facing direction, never walks off screen
- **Click / drag**: random reaction animations, draggable anywhere
- **Left/right facing**: all animations CSS-mirrored
- **Ground alignment**: unified foot line
- **Smooth transitions**: double-buffered video cross-fade
- **Accessibility-friendly**: supports `prefers-reduced-motion`

## ⚙️ Configuration

| Key        | Description                                   |
| ---------- | --------------------------------------------- |
| `size`     | Stage width (px); pet height ≈ width×9/16×74% |
| `position` | Default corner position                       |

> Note: the plugin works out of the box; all config above is optional. Settings saved to `$DSH_HOME/dsh-pet/main-config.json`.

### 📄 Advanced Customization

All user data lives under `$DSH_HOME/dsh-pet/`:

| Layer                      | Path                                 | Purpose                                              |
| -------------------------- | ------------------------------------ | ---------------------------------------------------- |
| Default config (read-only) | `assets/config.jsonc` in the package | Complete reference: pets / animation pools / weights |
| User config                | `$DSH_HOME/dsh-pet/main-config.json` | Override fragment                                    |
| User animations (optional) | `$DSH_HOME/dsh-pet/main-animation/`  | Drop `.webm` files here — takes precedence           |

- Format: `.webm` only; **transparent animations require VP9 Alpha encoding**

## 🗑️ Uninstall

```sh
# DSH
dsh plugin --profile web remove dsh-pet

# pi
npm uninstall -g dsh-pet
```

## 🎬 Animation Previews

> Animations have transparent backgrounds; GIF previews show page background color where transparent.

<p>
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/daiji-huxi-xiuxian.gif" width="160" alt="Idle breathing & chill" title="Idle breathing & chill">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dongzhangxiwang.gif" width="160" alt="Looking around" title="Looking around">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-piaofu-tabu.gif" width="160" alt="Floating in place" title="Floating in place">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/yuandi-xiaoqi-chenmian.gif" width="160" alt="Napping" title="Napping">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/dianji-huiying-kaixin-yuedong.gif" width="160" alt="Click response - happy bounce" title="Click response - happy bounce">
  <img src="https://raw.githubusercontent.com/PC2005-cloud/dsh-pet/main/dsh-pet/assets/preview/beishubiao-tuozhuai-xuankong-fankui.gif" width="160" alt="Dragged by the mouse" title="Dragged by the mouse">
</p>

All animations in `dsh-pet/assets/thumb/`.

## 🔗 Links

- **npm**: [npmjs.com/package/dsh-pet](https://www.npmjs.com/package/dsh-pet)
- **GitHub**: [github.com/PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
- **Original project**: [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (thank you!)

## 🔎 Discover More DSH Plugins

- Community plugin catalog: [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)
- DSH official repository: [deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)

## 📄 License

- Code: MIT
- Assets (animations/prompts/source videos): open-source use permitted, **no commercial use**
