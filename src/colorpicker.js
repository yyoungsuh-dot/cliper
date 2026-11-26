/* Color picker (vanilla JS port of the shadcn-style ColorPicker):
 * saturation/brightness area, hue slider, eyedropper, and HEX / RGB / HSL fields.
 * No alpha slider: GIF and MP4 can't store a semi-transparent background. */
'use strict';

const CP = {
  hsvToRgb(h, s, v) {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)].map((x) => Math.round(x * 255));
  },
  rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, max ? d / max : 0, max];
  },
  rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    }
    return [Math.round((h * 60 + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
  },
  hslToRgb(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
  },
  hex: (rgb) => '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase(),
  parseHex(str) {
    let s = String(str).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  },
};

class ColorPicker {
  constructor(root, { value = '#FFFFFF', onChange } = {}) {
    this.root = root; this.onChange = onChange; this.mode = 'hex';
    root.classList.add('cp');
    root.innerHTML = `
      <div class="cp-area"><div class="cp-thumb"></div></div>
      <div class="cp-row">
        <button type="button" class="cp-eye" aria-label="Pick a color from the screen">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>
        </button>
        <div class="cp-hue"><div class="cp-hthumb"></div></div>
      </div>
      <div class="cp-row">
        <select class="cp-mode" aria-label="Color format"><option value="hex">HEX</option><option value="rgb">RGB</option><option value="hsl">HSL</option></select>
        <div class="cp-fields"></div>
      </div>`;
    this.area = root.querySelector('.cp-area');
    this.thumb = root.querySelector('.cp-thumb');
    this.hue = root.querySelector('.cp-hue');
    this.hthumb = root.querySelector('.cp-hthumb');
    this.fields = root.querySelector('.cp-fields');
    const eye = root.querySelector('.cp-eye');
    if (!('EyeDropper' in window)) eye.hidden = true;
    eye.onclick = async () => {
      try { const r = await new EyeDropper().open(); this.set(r.sRGBHex, true); } catch { /* cancelled */ }
    };
    root.querySelector('.cp-mode').onchange = (e) => { this.mode = e.target.value; this.renderFields(); };
    this.drag(this.area, (x, y) => { this.s = x; this.v = 1 - y; this.update(true); });
    this.drag(this.hue, (x) => { this.h = x * 360; this.update(true); });
    this.set(value, false);
  }
  drag(el, fn) {
    const at = (e) => {
      const r = el.getBoundingClientRect();
      fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); el.setPointerCapture(e.pointerId); at(e);
      const move = (ev) => at(ev);
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
  }
  get rgb() { return CP.hsvToRgb(this.h, this.s, this.v); }
  get value() { return CP.hex(this.rgb); }
  set(color, emit) {
    const rgb = Array.isArray(color) ? color : CP.parseHex(color);
    if (!rgb) return;
    const [h, s, v] = CP.rgbToHsv(...rgb);
    // keep the current hue when the color is grey, so the hue slider doesn't jump
    this.h = s === 0 && this.h != null ? this.h : h; this.s = s; this.v = v;
    this.update(emit);
  }
  update(emit) {
    this.area.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${this.h}, 100%, 50%))`;
    this.thumb.style.left = this.s * 100 + '%';
    this.thumb.style.top = (1 - this.v) * 100 + '%';
    this.thumb.style.background = this.value;
    this.hthumb.style.left = (this.h / 360) * 100 + '%';
    this.hthumb.style.background = `hsl(${this.h}, 100%, 50%)`;
    this.renderFields();
    if (emit) this.onChange?.(this.value);
  }
  renderFields() {
    const active = document.activeElement;
    if (active && this.fields.contains(active)) return; // don't overwrite what the user is typing
    const [r, g, b] = this.rgb;
    const vals = this.mode === 'hex' ? [this.value.slice(1)] : this.mode === 'rgb' ? [r, g, b] : CP.rgbToHsl(r, g, b);
    const labels = this.mode === 'hex' ? ['#'] : this.mode === 'rgb' ? ['R', 'G', 'B'] : ['H', 'S', 'L'];
    if (this.fields.dataset.mode !== this.mode) {
      this.fields.dataset.mode = this.mode;
      this.fields.innerHTML = labels.map((l, i) => `<label class="cp-f${this.mode === 'hex' ? ' wide' : ''}"><span>${l}</span><input data-i="${i}" ${this.mode === 'hex' ? 'maxlength="7"' : 'inputmode="numeric"'} spellcheck="false"></label>`).join('');
      this.fields.querySelectorAll('input').forEach((inp) => {
        inp.addEventListener('change', () => this.fromFields());
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
      });
    }
    this.fields.querySelectorAll('input').forEach((inp, i) => (inp.value = vals[i]));
  }
  fromFields() {
    const v = [...this.fields.querySelectorAll('input')].map((i) => i.value);
    let rgb = null;
    if (this.mode === 'hex') rgb = CP.parseHex(v[0]);
    else {
      const n = v.map((x) => Math.round(+x));
      if (n.every(Number.isFinite)) {
        rgb = this.mode === 'rgb' ? n.map((x) => Math.max(0, Math.min(255, x)))
          : CP.hslToRgb(((n[0] % 360) + 360) % 360, Math.max(0, Math.min(100, n[1])), Math.max(0, Math.min(100, n[2])));
      }
    }
    this.fields.dataset.mode = '';
    if (rgb) this.set(rgb, true); else this.renderFields();
  }
}
