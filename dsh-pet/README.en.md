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

> 🙏 Forked from [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) ([npm](https://www.npmjs.com/package/dsh-pet)), with gratitude to the original author for the 91 hand-drawn transparent animations and animation engine. This repo adapts it for the pi coding agent with Electron overlay windows and pi event reactivity.

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

- 🧠 **Thinking** — "deep thought" animation
- 💻 **Coding** — "writing code" animation when tools (bash/edit/write) are called
- 😴 **Idle** — resumes random animation chain

> The pet persists across pi sessions within the same process.

## Features

- **Just a deepseek chan**: no weather, no system monitor, no API calls — just company.
- **pi event reactivity**: auto-detects agent state (thinking/coding/idle) and plays matching animations.
- **91 hand-drawn transparent animations**: idle breathing, napping, cube solving, humming, coding, seasonal…
- **Endless animation chain**: weighted random selection after each clip.
- **Screen roaming**: walks within screen bounds.
- **Click / drag**: random response on click, draggable anywhere.
- **Multi-window**: each `/pet` opens a new independent window; `/pet-stop` closes all.
- **Mirrored facing**: all animations CSS-flippable.
- **Ground-aligned feet**: consistent baseline across animations.
- **Smooth transitions**: dual-buffer video cross-fade.

## Configuration

Default config: `assets/config.jsonc`

```jsonc
"pets": [
  { "id": "main", "size": 462, "position": { "corner": "top-right", "marginX": 24, "marginY": 100 } }
]
```

| Field | Description |
|-------|-------------|
| `size` | Pet width in px (height = width × 9/16) |
| `position.corner` | Screen corner: top-left / top-right / bottom-left / bottom-right |
| `position.marginX/Y` | Distance from corner in px |

Edit `assets/config.jsonc` and re-run `/pet` to apply.

### Customizing Pet Size

The size map is defined in `dsh-pet/pi/assets/pet.js` line 589:

```js
var SIZE_MAP = { small: 260, normal: 400, large: 540 };
```

- **Change values** — edit the px widths (height = width × 9/16)
- **Add tiers** — add `tiny`, `xlarge`, etc., e.g. `{ tiny: 180, ..., xlarge: 720 }`

Save and re-run `/pet` — new commands like `/pet tiny`, `/pet xlarge` work automatically.

## Uninstall

```sh
npm uninstall -g pi-dsh-pet
```

## Links

- **GitHub**: [github.com/SOMWHY/pi-dsh-pet](https://github.com/SOMWHY/pi-dsh-pet)

## License

- Code: MIT
- Assets (animations/prompts/source videos): allowed for open-source use, **no commercial use**