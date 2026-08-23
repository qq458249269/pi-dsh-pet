# pi-dsh-pet 🐾

[中文](./README.md)

<p align="center">
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm version" src="https://img.shields.io/npm/v/pi-dsh-pet?label=npm&color=blue"></a>
  <a href="https://www.npmjs.com/package/pi-dsh-pet"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/pi-dsh-pet?label=downloads&color=brightgreen"></a>
  <a href="https://github.com/SOMWHY/pi-dsh-pet"><img alt="stars" src="https://img.shields.io/github/stars/SOMWHY/pi-dsh-pet?style=social"></a>
  <a href="https://github.com/SOMWHY/pi-dsh-pet/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/github/license/SOMWHY/pi-dsh-pet?color=orange"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-pi%20coding%20agent-8A2BE2">
  <img alt="assets" src="https://img.shields.io/badge/assets-91%20animations-ff69b4">
</p>

A floating deepseek chan living in the **pi coding agent**: idle breathing, random actions, screen roaming, click reactions, and agent-state reactivity — thinking, coding, and idle each trigger matching animations.

> Forked from [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) ([npm](https://www.npmjs.com/package/dsh-pet)). This repo adapts it for the pi platform with Electron transparent overlay windows and pi event integration. Original dsh-pet users should use the npm package.

---

## Quick Start

```sh
npm install -g pi-dsh-pet
```

In pi:

```
/pet             →  normal size (400px)
/pet small       →  small size (260px)
/pet large       →  large size (540px)
/pet-stop        →  close all pet windows
```

> 💡 First launch downloads Electron ~100MB; subsequent launches are instant.

The pet reacts to pi's agent state:

| pi agent state | Pet animation |
|----------------|---------------|
| Thinking | Deep thought |
| Tool calls (bash/edit/write) | Writing code |
| Idle | Random animation chain |

---

## Project Structure

```
pi-dsh-pet/
├── pi/extensions/       # pi extension entry (HTTP + WebSocket + Electron launcher)
├── pi/assets/           # Electron window UI (pet.html + pet.js + pet.css + preload)
├── assets/preview/      # 91 preview GIFs
├── assets/thumb/        # 91 transparent WebM animations
├── assets/config.jsonc  # animation → event / tag mapping
├── package.json         # npm package manifest
├── DESIGN.md            # design & architecture doc
├── LICENSE              # MIT
└── README.md
```

## Animations Preview

All 91 animations — see the [main README](./README.md) for the full gallery.

---

## Customizing Size

The size map is in `pi/assets/pet.js` line 589:

```js
var SIZE_MAP = { small: 260, normal: 400, large: 540 };
```

- **Change values** — edit the px widths (height = width × 9/16)
- **Add tiers** — add `tiny`, `xlarge`, etc., e.g. `{ tiny: 180, ..., xlarge: 720 }`

Save and re-run `/pet` — new commands like `/pet tiny`, `/pet xlarge` work automatically.

## License

- Code: MIT
- Assets (animations/prompts/source videos): allowed for open-source use, **no commercial use**