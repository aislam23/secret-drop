// The desktop's drawings: SVG markup built from plain data, so the tests can read it.
// Native Input and Buttons sit between these pictures; nothing here takes input.

export const ACCENT = '#D97757' // Claude's clay
const ACCENT_LIGHT = '#EBA488'
const GREEN = '#2E9E57'
const AMBER = '#C27C0E'
const RED = '#D2484F'

const SANS = "'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif"
const MONO = "'Anthropic Mono',ui-monospace,'SF Mono',Menlo,monospace"

// Lucide icons, 24px grid, drawn as strokes
const ICON = {
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
}

const icon = (name: keyof typeof ICON, x: number, y: number, size: number, color: string, width = 2) =>
  `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</g>`

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A rough width in CSS pixels, enough to fit and truncate text. */
export const textWidth = (s: string, size = 12, mono = false, tracking = 0) =>
  [...s].reduce((w, ch) => {
    if (mono) return w + size * 0.62
    const k = /[ilI.,:;'|!·]/.test(ch)
      ? 0.3
      : ch === ' '
        ? 0.28
        : /[mwMWШЩЖМЮшщжмю]/.test(ch)
          ? 0.88
          : /[А-ЯЁ]/.test(ch)
            ? 0.72
            : /[A-Z]/.test(ch)
              ? 0.68
              : /[0-9]/.test(ch)
                ? 0.6
                : /[а-яё]/.test(ch)
                  ? 0.6
                  : 0.55
    return w + size * (k + tracking)
  }, 0)

export const fit = (s: string, room: number, size = 12, mono = false) => {
  if (textWidth(s, size, mono) <= room) return s
  let cut = s
  while (cut.length > 1 && textWidth(`${cut}…`, size, mono) > room) cut = cut.slice(0, -1)

  return room < size ? '' : `${cut.trimEnd()}…`
}

/** Like fit, but keeps the end: what stands right before the key is what tells it apart. */
export const fitStart = (s: string, room: number, size = 12) => {
  if (textWidth(s, size) <= room) return s
  let cut = s.replace(/^…/, '')
  while (cut.length > 1 && textWidth(`…${cut}`, size) > room) cut = cut.slice(1)

  return room < size ? '' : `…${cut.trimStart()}`
}

const hash = (a: number, b: number, c: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return x - Math.floor(x)
}

/** A field of twinkling pixels that fades to the right, as plan-progress draws its tracks. */
function pixels(width: number, height: number, color: string, seed: number) {
  const rows = Math.floor((height - 4) / 3)
  const groups = new Map<number, string>()
  for (let col = 0; col * 3 < width; col++) {
    const u = (col * 3) / width
    const dense = 0.6 * Math.pow(1 - u, 3)
    for (let r = 0; r < rows; r++) {
      if (hash(col + seed, r, 1) > dense) continue
      const t = Math.floor(hash(col, r + seed, 2) * 4)
      groups.set(t, `${groups.get(t) ?? ''}M${col * 3} ${2 + r * 3}h2v2h-2z`)
    }
  }

  return [...groups]
    .map(([t, d]) => `<path class="px t${t}" d="${d}" fill="${color}"/>`)
    .join('')
}

const STYLE = `<style>
svg{color-scheme:light dark}
.ink{fill:#F5F4EE}.mute{fill:#A6A39A}.faint{fill:#8A877F}
.lbl{font:600 10.5px ${SANS};letter-spacing:.07em}
.why{font:400 11.5px ${SANS}}
.name{font:600 14px ${MONO}}
.hint{font:400 12px ${SANS}}
.chip{font:500 11.5px ${SANS}}
.foot{font:400 11.5px ${SANS}}
.row{font:500 12.5px ${SANS}}
.mk{font:600 12px ${MONO};fill:${ACCENT}}
.px{opacity:.4}
.t0,.t1,.t2,.t3{animation:tw 2.4s ease-in-out infinite}
.t1{animation-duration:3s;animation-delay:-.8s}.t2{animation-duration:2s;animation-delay:-1.4s}.t3{animation-duration:3.4s;animation-delay:-.5s}
@keyframes tw{0%,100%{opacity:.4}50%{opacity:.1}}
@media (prefers-color-scheme:light){.ink{fill:#1F1E1D}.mute{fill:#6B6862}.faint{fill:#8A877F}}
@media (prefers-reduced-motion:reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>`

const open = (w: number, h: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${STYLE}`

export type Destination = { kind: 'env' | 'github'; label: string }

/**
 * The third line of the header: why the key is needed, or where in the message it was caught.
 * `mark` is drawn between `before` and `after` in the accent colour; `tail` follows, dimmer.
 */
export type Detail = { label: string; before: string; mark?: string; after?: string; tail?: string }

export type AskLook = {
  title: string
  reason?: string
  name: string
  hint?: string
  detail?: Detail
  step?: { index: number; count: number }
  destinations: Destination[]
}

export const HEADER_H = 44
const DETAIL_H = 20

export const headerHeight = (a: Pick<AskLook, 'detail'>) => (a.detail ? HEADER_H + DETAIL_H : HEADER_H)

/** A detail as one line of plain text, for alt text and the terminal. */
export const detailText = (d: Detail) =>
  `${d.label} ${d.mark !== undefined ? `«${d.before}${d.mark}${d.after ?? ''}»` : d.before}${d.tail ? ` · ${d.tail}` : ''}`

function detailSvg(d: Detail, x: number, y: number, room: number): string {
  const labelW = textWidth(`${d.label} `, 12)
  const tail = d.tail ? ` · ${d.tail}` : ''
  const tailW = textWidth(tail, 12)
  if (d.mark === undefined) {
    const text = fit(d.before, room - labelW - tailW, 12)
    return (
      `<text x="${x}" y="${y}" class="hint" style="white-space:pre">` +
      `<tspan class="faint">${esc(d.label)} </tspan><tspan class="mute">${esc(text)}</tspan>` +
      (tail ? `<tspan class="faint">${esc(tail)}</tspan>` : '') +
      '</text>'
    )
  }
  const markW = textWidth(d.mark, 12, true)
  const free = Math.max(0, room - labelW - markW - tailW - textWidth('«»', 12))
  const after = d.after ?? ''
  const afterRoom = Math.min(textWidth(after, 12), free * 0.35)
  const before = fitStart(d.before, free - afterRoom, 12)
  const shownAfter = fit(after, afterRoom, 12)

  return (
    `<text x="${x}" y="${y}" class="hint" style="white-space:pre">` +
    `<tspan class="faint">${esc(d.label)} </tspan>` +
    `<tspan class="mute">«${esc(before)}</tspan><tspan class="mk">${esc(d.mark)}</tspan><tspan class="mute">${esc(shownAfter)}»</tspan>` +
    (tail ? `<tspan class="faint">${esc(tail)}</tspan>` : '') +
    '</text>'
  )
}

/** A quiet line above the field: a small badge, what is asked and why, where it goes. */
export function headerSvg(a: AskLook, W: number): string {
  const H = HEADER_H
  let right = W - 2
  let chipMarkup = ''
  for (const d of [...a.destinations].reverse()) {
    const full = Math.ceil(textWidth(d.label, 11.5) * 1.1 + 40)
    const room = Math.min(full, Math.max(90, W * 0.36))
    const x = right - room
    chipMarkup +=
      `<rect x="${x}" y="${(H - 24) / 2}" width="${room}" height="24" rx="12" fill="#808080" fill-opacity=".12"/>` +
      icon(d.kind === 'github' ? 'github' : 'file', x + 10, (H - 24) / 2 + 5, 14, '#8A877F', 2) +
      `<text x="${x + 29}" y="${H / 2 + 4}" class="chip mute">${esc(fit(d.label, room - 38, 11.5))}</text>`
    right = x - 8
  }

  let dots = ''
  if (a.step && a.step.count > 1) {
    const n = a.step.count
    const label = `${a.step.index + 1}/${n}`
    const x0 = right - n * 10 - textWidth(label, 11.5) - 8
    for (let i = 0; i < n; i++) {
      const isNow = i === a.step.index
      dots += `<circle cx="${x0 + i * 10 + 3}" cy="${H / 2}" r="3" fill="${isNow ? ACCENT : '#808080'}" fill-opacity="${isNow ? 1 : i < a.step.index ? 0.7 : 0.3}"/>`
    }
    dots += `<text x="${x0 + n * 10 + 4}" y="${H / 2 + 4}" class="chip faint">${label}</text>`
    right = x0 - 12
  }

  const textX = 46
  const room = Math.max(40, right - textX - 8)
  const nameW = textWidth(a.name, 14, true)
  const name = fit(a.name, room, 14, true)
  const hint = a.hint ? fit(a.hint, room - nameW - 14, 12) : ''
  const top = [a.title, a.reason].filter(Boolean).join(' · ')

  return (
    open(W, headerHeight(a)) +
    `<circle cx="17" cy="${H / 2}" r="15" fill="${ACCENT}" fill-opacity=".14"/>` +
    icon('key', 9, H / 2 - 8, 16, ACCENT, 2.2) +
    `<text x="${textX}" y="17" class="why mute">${esc(fit(top, room, 11.5))}</text>` +
    `<text x="${textX}" y="36" class="name ink">${esc(name)}</text>` +
    (hint ? `<text x="${textX + nameW + 10}" y="35.5" class="hint mute">${esc(hint)}</text>` : '') +
    // the detail line runs under the chips, so it gets the whole width
    (a.detail ? detailSvg(a.detail, textX, H + 13, W - textX - 4) : '') +
    dots +
    chipMarkup +
    '</svg>'
  )
}

export const CUE_H = 30

export const cueWidth = (text: string) => Math.ceil(textWidth(text, 13) + 30)

/** The pointer at the field: the one thing in the band that asks for attention. */
export function cueSvg(text: string, width?: number): string {
  const W = Math.max(width ?? 0, cueWidth(text))
  const y = CUE_H / 2
  return (
    open(W, CUE_H) +
    `<style>.cue{font:600 13px ${SANS};fill:${ACCENT}}.nudge{animation:nd 1.6s ease-in-out infinite}@keyframes nd{0%,100%{transform:translateX(0)}50%{transform:translateX(3px)}}@media (prefers-reduced-motion:reduce){.nudge{animation:none}}</style>` +
    `<text x="0" y="${y + 4.5}" class="cue">${esc(text)}</text>` +
    `<g class="nudge"><path d="M${W - 22} ${y}h12m-4.5-4.5L${W - 10} ${y}l-4.5 4.5" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>` +
    '</svg>'
  )
}

export const FOOT_H = 18

/** The promise under the field. */
export function footSvg(text: string, W: number): string {
  return (
    open(W, FOOT_H) +
    icon('shield', 2, 2, 14, GREEN, 2) +
    `<text x="22" y="13" class="foot mute">${esc(fit(text, W - 24, 11.5))}</text></svg>`
  )
}

export type ReportLine = { text: string; tone: 'ok' | 'warn' | 'error' }

export const toneOf = (line: string): ReportLine['tone'] =>
  line.startsWith('✗') ? 'error' : line.startsWith('⚠') ? 'warn' : 'ok'

/** The card after saving: a badge, a title, one line per thing done. */
export function reportSvg(title: string, lines: ReportLine[], W: number, isBusy: boolean): string {
  const rowH = 22
  const H = 52 + Math.max(0, lines.length - 1) * rowH + (lines.length > 0 ? 8 : 0)
  const hasError = lines.some(l => l.tone === 'error')
  const color = isBusy ? ACCENT : hasError ? RED : GREEN
  const rows = lines
    .map((line, i) => {
      const y = 22 + i * rowH
      const c = line.tone === 'error' ? RED : line.tone === 'warn' ? AMBER : GREEN
      const name = line.tone === 'error' ? 'x' : line.tone === 'warn' ? 'alert' : 'check'
      const text = line.text.replace(/^[✓✗⚠]\s*/, '')
      return icon(name, 62, y - 2, 14, c, 2.4) + `<text x="84" y="${y + 9.5}" class="row ink">${esc(fit(text, W - 100, 12.5))}</text>`
    })
    .join('')

  return (
    open(W, H) +
    `<defs><clipPath id="sd-report-card"><rect width="${W}" height="${H}" rx="14"/></clipPath></defs>` +
    `<g clip-path="url(#sd-report-card)"><rect width="${W}" height="${H}" fill="${color}" fill-opacity=".10"/>${pixels(Math.min(W * 0.35, 260), H, color, 3)}</g>` +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="13.5" fill="none" stroke="${color}" stroke-opacity=".4"/>` +
    `<circle cx="32" cy="26" r="17" fill="${color}"/>` +
    (isBusy
      ? `<circle cx="32" cy="26" r="7" fill="none" stroke="#fff" stroke-width="2.4" stroke-dasharray="30 14" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 32 26" to="360 32 26" dur="1s" repeatCount="indefinite"/></circle>`
      : icon(hasError ? 'x' : 'check', 23, 17, 18, '#FFFFFF', 2.6)) +
    (lines.length === 0 ? `<text x="62" y="31" class="row ink">${esc(title)}</text>` : rows) +
    '</svg>'
  )
}
