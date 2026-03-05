import { mkdir, readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises'
import path from 'node:path'

function isoNow() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

async function copyDir(srcDir, dstDir) {
  await mkdir(dstDir, { recursive: true })
  const items = await readdir(srcDir)
  for (const name of items) {
    const src = path.join(srcDir, name)
    const dst = path.join(dstDir, name)
    const st = await stat(src)
    if (st.isDirectory()) await copyDir(src, dst)
    else await copyFile(src, dst)
  }
}

function renderIndexHtml({ title }) {
  // P0：最小运行时（ESM + Pixi CDN）+ Timeline/Event/State/EndingCard
  // 运行时约定：同目录 story.json + project.json + assets/*
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title || 'Story')}</title>
    <style>
      html,body{margin:0;height:100%;background:#0b1220}
      #app{position:fixed;inset:0}
      #overlay{position:fixed;inset:0;pointer-events:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#e5e7eb}
      #stageUI{position:absolute;left:0;top:0;pointer-events:none;transform-origin:0 0}

      #dialogWrap{position:absolute;inset:0;padding:18px;box-sizing:border-box;display:flex;justify-content:center;align-items:flex-end}
      .card{pointer-events:auto;width:min(920px,calc(100% - 36px));border-radius:18px;border:1px solid rgba(148,163,184,.18);background:rgba(2,6,23,.74);backdrop-filter:blur(10px);box-shadow:0 16px 50px rgba(0,0,0,.35);padding:14px}
      .metaRow{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px}
      .nodeName{font-weight:900;font-size:16px}
      .waitHint{font-size:12px;opacity:.82}
      .textBox{font-size:18px;line-height:1.65;white-space:pre-wrap;word-break:break-word;border-radius:14px;padding:12px;border:1px solid rgba(148,163,184,.14);background:rgba(2,6,23,.35);max-height:min(42vh,360px);overflow:auto}
      .choices{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;justify-content:flex-end}
      .choiceBtn{pointer-events:auto;padding:10px 12px;border-radius:12px;border:1px solid rgba(148,163,184,.22);background:rgba(59,130,246,.9);color:#fff;cursor:pointer}
      .choiceBtn:disabled{opacity:.55;cursor:not-allowed}
      .actions{display:flex;justify-content:flex-end;margin-top:12px}

      #endingWrap{position:absolute;inset:0;display:none;align-items:center;justify-content:center;padding:18px;box-sizing:border-box}
      #endingCard{width:min(760px,calc(100% - 36px));border-radius:18px;border:1px solid rgba(148,163,184,.22);background:rgba(2,6,23,.84);backdrop-filter:blur(10px);box-shadow:0 18px 70px rgba(0,0,0,.5);padding:18px;pointer-events:auto}
      #endingTitle{font-size:22px;font-weight:900;margin-bottom:10px}
      #endingMoral{font-size:18px;line-height:1.65;white-space:pre-wrap;word-break:break-word;border-radius:14px;padding:12px;border:1px solid rgba(148,163,184,.14);background:rgba(2,6,23,.35)}
      #endingBullets{margin:0 0 10px;padding-left:20px;opacity:.95}
      #endingActions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:14px}

      #toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);display:none;pointer-events:none;background:rgba(2,6,23,.92);border:1px solid rgba(148,163,184,.22);color:#e5e7eb;padding:8px 12px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
    </style>
  </head>
  <body>
    <div id="app"></div>
    <div id="overlay">
      <div id="topbar" style="display:none"></div>
      <div id="stageUI">
        <div id="endingWrap">
          <div id="endingCard">
            <div id="endingTitle">结局</div>
            <ul id="endingBullets"></ul>
            <div id="endingMoral"></div>
            <div id="endingActions"></div>
          </div>
        </div>
        <div id="dialogWrap">
          <div id="dialog" class="card">
            <div class="metaRow">
              <div class="nodeName" id="dialogNodeName"></div>
              <div class="waitHint" id="waitHint"></div>
            </div>
            <div class="textBox" id="dialogText"></div>
            <div class="choices" id="choices"></div>
            <div class="actions" id="actions">
              <button id="continue" class="choiceBtn">继续</button>
            </div>
          </div>
        </div>
        <div id="toast"></div>
      </div>
    </div>
    <script type="module">
      import { Application, Container, Sprite, Texture } from 'https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs'

      const rootEl = document.getElementById('app')
      const metaEl = document.getElementById('nodeMeta')
      const btnRestart = document.getElementById('restart')
      const btnBack = document.getElementById('backToHub')
      const dialogNodeNameEl = document.getElementById('dialogNodeName')
      const waitHintEl = document.getElementById('waitHint')
      const dialogTextEl = document.getElementById('dialogText')
      const dialogWrapEl = document.getElementById('dialogWrap')
      const dialogEl = document.getElementById('dialog')
      const choicesEl = document.getElementById('choices')
      const actionsEl = document.getElementById('actions')
      const btnContinue = document.getElementById('continue')
      const endingWrapEl = document.getElementById('endingWrap')
      const endingTitleEl = document.getElementById('endingTitle')
      const endingBulletsEl = document.getElementById('endingBullets')
      const endingMoralEl = document.getElementById('endingMoral')
      const endingActionsEl = document.getElementById('endingActions')
      const toastEl = document.getElementById('toast')
      const stageUiEl = document.getElementById('stageUI')

      const app = new Application()
      await app.init({ resizeTo: rootEl, backgroundAlpha: 0 })
      rootEl.appendChild(app.canvas)
      const textureCache = new Map()
      let renderSeq = 0

      async function loadJson(p) {
        const r = await fetch(p, { cache: 'no-store' })
        return await r.json()
      }

      async function loadTexture(url) {
        const key = String(url || '').trim()
        if (!key) return null
        const cached = textureCache.get(key)
        if (cached) {
          try { return cached instanceof Promise ? await cached : cached } catch (_) { textureCache.delete(key) }
        }
        const p = new Promise((resolve, reject) => {
          try {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              try { resolve(Texture.from(img)) } catch (e) { reject(e) }
            }
            img.onerror = () => reject(new Error('image_load_failed: ' + key))
            img.src = key
          } catch (e) {
            reject(e)
          }
        })
        textureCache.set(key, p)
        try {
          const tex = await p
          textureCache.set(key, tex)
          return tex
        } catch (_) {
          textureCache.delete(key)
          return null
        }
      }

      const project = await loadJson('./project.json')
      const story = await loadJson('./story.json')
      const storyNodes = Array.isArray(story && story.nodes) ? story.nodes : []
      const nodeByIdMap = new Map(storyNodes.filter(Boolean).map(n => [String(n.id), n]))
      const projectId = String(project && project.id || '')

      function resolveAssetUri(uri) {
        const raw = String(uri || '').trim()
        if (!raw) return ''
        if (raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('data:')) return raw
        const marker = projectId ? ('/project-assets/' + encodeURIComponent(projectId) + '/') : ''
        if (marker) {
          const i = raw.indexOf(marker)
          if (i >= 0) {
            const tail = raw.slice(i + marker.length).replace(/^\\/+/, '')
            return tail ? ('./' + tail) : raw
          }
        }
        if (raw.startsWith('/project-assets/')) {
          const parts = raw.split('/').filter(Boolean)
          if (parts.length >= 4) {
            const tail = parts.slice(3).join('/')
            return tail ? ('./' + tail) : raw
          }
        }
        return raw
      }

      function normalizeStage(project) {
        try {
          const s = project && typeof project === 'object' && project.stage && typeof project.stage === 'object' ? project.stage : {}
          let width = Math.max(1, Math.floor(Number(s.width || 0) || 720))
          let height = Math.max(1, Math.floor(Number(s.height || 0) || 1280))
          const orientation = String(s.orientation || '').trim()
          if (orientation === 'portrait' && width > height) { const t = width; width = height; height = t }
          if (orientation === 'landscape' && height > width) { const t = width; width = height; height = t }
          width = Math.max(320, Math.min(4096, width))
          height = Math.max(320, Math.min(4096, height))
          const scaleMode = String(s.scaleMode || 'contain') === 'cover' ? 'cover' : 'contain'
          return { width, height, scaleMode }
        } catch (_) {
          return { width: 720, height: 1280, scaleMode: 'contain' }
        }
      }

      const stageCfg = normalizeStage(project)

      function clamp01(n) {
        const x = Number(n)
        if (!Number.isFinite(x)) return 0
        return Math.max(0, Math.min(1, x))
      }

      function applyStageUiTransform() {
        try {
          if (!stageUiEl) return
          const viewW = rootEl && rootEl.clientWidth ? rootEl.clientWidth : window.innerWidth
          const viewH = rootEl && rootEl.clientHeight ? rootEl.clientHeight : window.innerHeight
          const stageW = Math.max(1, Math.floor(Number(stageCfg.width || 720)))
          const stageH = Math.max(1, Math.floor(Number(stageCfg.height || 1280)))
          const sx = viewW / stageW
          const sy = viewH / stageH
          const scale = stageCfg.scaleMode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
          const offsetX = (viewW - stageW * scale) / 2
          const offsetY = (viewH - stageH * scale) / 2
          stageUiEl.style.width = stageW + 'px'
          stageUiEl.style.height = stageH + 'px'
          stageUiEl.style.transform = 'translate(' + offsetX + 'px,' + offsetY + 'px) scale(' + scale + ')'
        } catch (_) {}
      }

      function normalizeDialogPreset(v) {
        const s = String(v || '').trim()
        const allowed = { bottom: 1, top: 1, left: 1, right: 1, center: 1, custom: 1 }
        return allowed[s] ? s : 'bottom'
      }

      function applyDialogLayout(node) {
        try {
          if (!dialogWrapEl || !dialogNodeNameEl) return
          const d = node && node.visuals && node.visuals.ui && node.visuals.ui.dialog ? node.visuals.ui.dialog : {}
          const preset = normalizeDialogPreset(d && d.preset)

          // reset
          dialogWrapEl.style.display = 'flex'
          dialogWrapEl.style.padding = '18px'
          dialogWrapEl.style.justifyContent = 'center'
          dialogWrapEl.style.alignItems = 'flex-end'
          try {
            if (dialogEl) {
              dialogEl.style.position = ''
              dialogEl.style.left = ''
              dialogEl.style.top = ''
              dialogEl.style.transform = ''
            }
          } catch (_) {}

          if (preset === 'top') { dialogWrapEl.style.alignItems = 'flex-start'; return }
          if (preset === 'center') { dialogWrapEl.style.alignItems = 'center'; return }
          if (preset === 'left') { dialogWrapEl.style.justifyContent = 'flex-start'; dialogWrapEl.style.alignItems = 'center'; return }
          if (preset === 'right') { dialogWrapEl.style.justifyContent = 'flex-end'; dialogWrapEl.style.alignItems = 'center'; return }
          if (preset !== 'custom') return

          // custom: absolute in stage coords
          const x = clamp01(d && d.x != null ? d.x : 0.5)
          const y = clamp01(d && d.y != null ? d.y : 0.88)
          dialogWrapEl.style.display = 'block'
          dialogWrapEl.style.padding = '0'
          if (!dialogEl) return
          dialogEl.style.position = 'absolute'
          dialogEl.style.left = (Number(stageCfg.width || 720) * x) + 'px'
          dialogEl.style.top = (Number(stageCfg.height || 1280) * y) + 'px'
          dialogEl.style.transform = 'translate(-50%,-50%)'
        } catch (_) {}
      }

      function normalizeChoicesLayout(node) {
        try {
          const ui = node && node.visuals && node.visuals.ui ? node.visuals.ui : {}
          const ch = ui && ui.choices ? ui.choices : {}
          const direction = String(ch && ch.direction || 'row') === 'column' ? 'column' : 'row'
          const alignIn = String(ch && ch.align || 'end').trim()
          const allowed = { start: 1, center: 1, end: 1, stretch: 1 }
          const align = allowed[alignIn] ? alignIn : 'end'
          return { direction, align }
        } catch (_) {
          return { direction: 'row', align: 'end' }
        }
      }

      function applyChoicesLayout(node) {
        try {
          if (!choicesEl) return
          const { direction, align } = normalizeChoicesLayout(node)
          if (direction !== 'column') {
            choicesEl.style.display = 'flex'
            choicesEl.style.flexDirection = 'row'
            choicesEl.style.flexWrap = 'wrap'
            choicesEl.style.justifyContent = 'flex-end'
            choicesEl.style.alignItems = ''
            return
          }
          choicesEl.style.display = 'flex'
          choicesEl.style.flexDirection = 'column'
          choicesEl.style.flexWrap = 'nowrap'
          choicesEl.style.justifyContent = 'flex-end'
          choicesEl.style.alignItems =
            align === 'start' ? 'flex-start' :
            align === 'center' ? 'center' :
            align === 'stretch' ? 'stretch' :
            'flex-end'
        } catch (_) {}
      }

      try {
        applyStageUiTransform()
        window.addEventListener('resize', () => requestAnimationFrame(applyStageUiTransform))
      } catch (_) {}

      function ensureTimelineForNode(n) {
        const kind = String(n && n.kind || 'scene') === 'ending' ? 'ending' : 'scene'
        const bodyText = String(n && n.body && n.body.text || '')
        const choices = kind === 'scene' && Array.isArray(n && n.choices) ? n.choices : []
        const stepsIn = Array.isArray(n && n.timeline && n.timeline.steps) ? n.timeline.steps : []
        if (stepsIn.length) return { ...n, kind, timeline: { steps: stepsIn } }
        if (kind === 'ending') {
          return {
            ...n,
            kind: 'ending',
            timeline: {
              steps: [
                {
                  id: 'st_' + String(n.id || 'end') + '_1',
                  actions: [{ type: 'ui.showEndingCard', card: { title: '', bullets: [], moral: bodyText || '故事结束。', buttons: [{ type: 'restart', label: '重新开始' }] } }],
                  advance: { type: 'end' }
                }
              ]
            }
          }
        }
        return {
          ...n,
          kind: 'scene',
          timeline: {
            steps: [
              { id: 'st_' + String(n.id || 'scene') + '_1', actions: [{ type: 'ui.setText', mode: 'replace', text: bodyText }], advance: { type: choices.length ? 'choice' : 'click' } }
            ]
          }
        }
      }

      function buildDefaultVars(defs) {
        const out = {}
        const list = Array.isArray(defs) ? defs : []
        for (const v of list) {
          const name = String(v && v.name || '').trim()
          if (!name) continue
          const type = String(v && v.type || 'string')
          let d = v && v.default
          if (type === 'tags') {
            if (!Array.isArray(d)) d = []
            d = d.map(x => String(x)).filter(Boolean)
          } else if (type === 'number') {
            const n = Number(d)
            d = Number.isFinite(n) ? n : 0
          } else if (type === 'boolean') {
            d = Boolean(d)
          } else if (type === 'string') {
            d = String(d ?? '')
          }
          out[name] = d
        }
        return out
      }

      function evalValue(val, vars) {
        try { if (val && typeof val === 'object' && typeof val.var === 'string') return vars[String(val.var)] } catch (_) {}
        return val
      }
      function cmp(a, b) {
        const na = Number(a), nb = Number(b)
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
        const sa = String(a), sb = String(b)
        if (sa === sb) return 0
        return sa < sb ? -1 : 1
      }
      function evalExpr(expr, vars) {
        if (expr == null) return true
        if (typeof expr !== 'object') return Boolean(expr)
        const op = String(expr.op || '')
        if (!op) return Boolean(expr)
        if (op === 'and' || op === 'or') {
          const args = Array.isArray(expr.args) ? expr.args : []
          if (!args.length) return true
          return op === 'and' ? args.every(x => evalExpr(x, vars)) : args.some(x => evalExpr(x, vars))
        }
        if (op === 'not') return !evalExpr(expr.arg, vars)
        if (op === 'tags.has') {
          const v = String(expr.var || '').trim()
          const value = String(expr.value || '').trim()
          const list = Array.isArray(vars[v]) ? vars[v] : []
          return list.map(String).includes(value)
        }
        if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
          const left = evalValue(expr.left, vars)
          const right = evalValue(expr.right, vars)
          const c = cmp(left, right)
          if (op === '==') return c === 0
          if (op === '!=') return c !== 0
          if (op === '<') return c < 0
          if (op === '<=') return c <= 0
          if (op === '>') return c > 0
          if (op === '>=') return c >= 0
        }
        return Boolean(expr)
      }

      function defaultEndingCard(node) {
        return {
          title: '',
          bullets: [],
          moral: String(node && node.body && node.body.text || '故事结束。'),
          buttons: [{ type: 'restart', label: '重新开始' }]
        }
      }

      const eventsList = Array.isArray(project && project.events) ? project.events : []

      let nodeId = String(story.startNodeId || story.startId || '')
      let stepIndex = 0
      let text = ''
      let endingCard = null
      let wait = { kind: 'auto' }
      let vars = buildDefaultVars(project && project.state && project.state.vars)
      let eventMemory = {}
      let stageOverride = {}
      let nav = null
      let timerId = null
      let pollId = null

      function clearTimers() {
        if (timerId != null) { clearTimeout(timerId); timerId = null }
        if (pollId != null) { clearInterval(pollId); pollId = null }
      }

      function toast(msg) {
        try {
          if (!toastEl) return
          toastEl.textContent = String(msg || '')
          toastEl.style.display = msg ? 'block' : 'none'
          if (!msg) return
          setTimeout(() => { try { toastEl.style.display = 'none' } catch (_) {} }, 2200)
        } catch (_) {}
      }

      function applyAction(action, depth) {
        const t = String(action && action.type || '').trim()
        if (!t || nav) return
        if (t === 'ui.setText') {
          const mode = String(action.mode || 'replace')
          const s = String(action.text ?? '')
          text = mode === 'append' ? (text + s) : s
          return
        }
        if (t === 'ui.appendText') { text = text + String(action.text ?? ''); return }
        if (t === 'ui.clearText') { text = ''; return }
        if (t === 'ui.toast') { toast(String(action.text ?? '')); return }
        if (t === 'ui.showEndingCard') { endingCard = action.card || null; wait = { kind: 'end' }; return }
        if (t === 'flow.gotoNode') { const id = String(action.nodeId || '').trim(); if (id) nav = { type:'gotoNode', nodeId:id, delayMs:0 }; return }
        if (t === 'flow.restart') { nav = { type:'restart' }; return }
        if (t === 'flow.backToHub') { nav = { type:'backToHub', url: action.url }; return }
        if (t === 'flow.stopTimeline') { wait = { kind:'end' }; return }
        if (t === 'event.call') {
          if (depth >= 8) { toast('事件嵌套过深，已中止'); return }
          const eventId = String(action.eventId || '').trim()
          const ev = eventsList.find(e => String(e && e.id) === eventId) || null
          if (!ev) { toast('事件不存在：' + eventId); return }
          const acts = Array.isArray(ev.actions) ? ev.actions : []
          for (const a of acts) { applyAction(a, depth + 1); if (nav) break }
          return
        }
        if (t === 'events.emit') {
          const name = String(action.name || '').trim()
          if (!name) return
          eventMemory = { ...eventMemory, [name]: action.payload ?? true }
          return
        }
        if (t === 'state.set') {
          const k = String(action.var || '').trim(); if (!k) return
          vars = { ...vars, [k]: action.value }
          return
        }
        if (t === 'state.add' || t === 'state.inc') {
          const k = String(action.var || '').trim(); if (!k) return
          const delta = t === 'state.inc' ? Number(action.value ?? 1) : Number(action.value ?? 0)
          const prev = Number(vars[k] ?? 0)
          const next = (Number.isFinite(prev) ? prev : 0) + (Number.isFinite(delta) ? delta : 0)
          vars = { ...vars, [k]: next }
          return
        }
        if (t === 'state.toggle') {
          const k = String(action.var || '').trim(); if (!k) return
          vars = { ...vars, [k]: !Boolean(vars[k]) }
          return
        }
        if (t === 'state.tags.add' || t === 'state.tags.remove') {
          const k = String(action.var || '').trim()
          const v = String(action.value || '').trim()
          if (!k || !v) return
          const list = Array.isArray(vars[k]) ? vars[k].map(String) : []
          const set = new Set(list)
          if (t === 'state.tags.add') set.add(v); else set.delete(v)
          vars = { ...vars, [k]: Array.from(set) }
          return
        }
        if (t === 'stage.setBackground') {
          stageOverride = { ...stageOverride, backgroundAssetId: action.assetId ? String(action.assetId) : undefined }
          return
        }
        if (t === 'stage.setPlacements') {
          stageOverride = { ...stageOverride, placements: Array.isArray(action.placements) ? action.placements : [] }
          return
        }
      }

      function nodeById(id) {
        const n = nodeByIdMap.get(String(id)) || null
        return n ? ensureTimelineForNode(n) : null
      }

      async function renderStage(node) {
        const seq = ++renderSeq
        app.stage.removeChildren()
        const viewW = app.renderer.width
        const viewH = app.renderer.height
        const stageW = Math.max(1, Math.floor(Number(stageCfg.width || 720)))
        const stageH = Math.max(1, Math.floor(Number(stageCfg.height || 1280)))
        const sx = viewW / stageW
        const sy = viewH / stageH
        const scale = stageCfg.scaleMode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
        const offsetX = (viewW - stageW * scale) / 2
        const offsetY = (viewH - stageH * scale) / 2

        const root = new Container()
        root.x = offsetX
        root.y = offsetY
        root.scale.set(scale)
        app.stage.addChild(root)

        // background
        try {
          const bgId = stageOverride && stageOverride.backgroundAssetId ? stageOverride.backgroundAssetId : node?.visuals?.backgroundAssetId
          let bgUri = ''
          if (bgId && project && Array.isArray(project.assets)) {
            const a = project.assets.find(x => x && x.id === bgId)
            bgUri = a && a.uri ? resolveAssetUri(String(a.uri)) : ''
          }
          const bg = bgUri || ''
          if (bg && bg.trim()) {
            const tex = await loadTexture(bg.trim())
            if (seq !== renderSeq) return
            if (tex) {
              const s = new Sprite(tex)
              s.x = 0; s.y = 0; s.width = stageW; s.height = stageH
              root.addChild(s)
            }
          }
        } catch (_) {}

        // placements
        try {
          const placements = Array.isArray(stageOverride && stageOverride.placements) ? stageOverride.placements : (Array.isArray(node?.visuals?.placements) ? node.visuals.placements : [])
          const ordered = placements.slice().sort((a,b) => Number(a && a.zIndex || 0) - Number(b && b.zIndex || 0))
          for (const p of ordered) {
            if (!p || p.visible === false) continue
            const ch = Array.isArray(project.characters) ? project.characters.find(c => c && c.id === p.characterId) : null
            const imageAssetId = (p && p.imageAssetId) ? String(p.imageAssetId) : (ch && ch.imageAssetId) ? String(ch.imageAssetId) : ''
            if (!imageAssetId) continue
            const a = Array.isArray(project.assets) ? project.assets.find(x => x && x.id === imageAssetId) : null
            const img = a && a.uri ? resolveAssetUri(String(a.uri)) : ''
            if (!img) continue
            const tex = await loadTexture(img)
            if (seq !== renderSeq) return
            if (!tex) continue
            const sp = new Sprite(tex)
            sp.anchor.set(0.5, 1)
            const x = Number.isFinite(Number(p.transform?.x)) ? Number(p.transform.x) : 0.5
            const y = Number.isFinite(Number(p.transform?.y)) ? Number(p.transform.y) : 1
            const scale = Number.isFinite(Number(p.transform?.scale)) ? Number(p.transform.scale) : 1
            const rot = Number.isFinite(Number(p.transform?.rotationDeg)) ? Number(p.transform.rotationDeg) : 0
            sp.x = stageW * Math.max(0, Math.min(1, x))
            sp.y = stageH * Math.max(0, Math.min(1, y))
            sp.scale.set(scale)
            sp.rotation = (rot * Math.PI) / 180
            root.addChild(sp)
          }
        } catch (_) {}
      }

      function renderOverlay(node) {
        try { if (metaEl) metaEl.textContent = nodeId ? ('节点：' + nodeId) : '' } catch (_) {}
        const showEnding = Boolean(endingCard) || wait.kind === 'end'
        if (endingWrapEl) endingWrapEl.style.display = 'none'
        try { if (dialogWrapEl) dialogWrapEl.style.display = 'flex' } catch (_) {}
        try { applyDialogLayout(node) } catch (_) {}
        try {
          if (dialogNodeNameEl) {
            if (showEnding) {
              dialogNodeNameEl.textContent = ''
              dialogNodeNameEl.style.display = 'none'
            } else {
              const t = String(node && node.body && node.body.title || '').trim()
              dialogNodeNameEl.textContent = t
              dialogNodeNameEl.style.display = t ? 'inline' : 'none'
            }
          }
        } catch (_) {}

        try {
          const fallback = node && node.body && node.body.text ? String(node.body.text) : ''
          const card = showEnding ? (endingCard || defaultEndingCard(node)) : null
          const endingText = card && card.moral ? String(card.moral) : ''
          const displayText = showEnding
            ? (String(endingText || '').trim() ? String(endingText) : fallback)
            : (String(text || '').trim() ? String(text) : fallback)
          const filtered = String(displayText)
            .split(/\\r?\\n/)
            .filter((original) => !/^\\s*(?:选项|option)\\s*(?:\\d{1,2}|[A-Z]|[一二三四五六七八九十])\\s*[:：]/i.test(original))
            .map((ln) => ln.trim())
            .filter(Boolean)
            .join('\\n')
          const finalText = filtered || displayText
          const hasText = String(finalText || '').trim().length > 0
          if (dialogTextEl) dialogTextEl.textContent = hasText ? String(finalText) : ''
          if (dialogTextEl) dialogTextEl.style.display = hasText ? 'block' : 'none'
        } catch (_) {}
        if (waitHintEl) {
          waitHintEl.textContent =
            wait.kind === 'timer' ? '自动推进…' :
            wait.kind === 'event' ? ('等待事件：' + (wait.name || '（未命名）')) :
            wait.kind === 'condition' ? '等待条件成立…' : ''
        }

        try { applyChoicesLayout(node) } catch (_) {}

        if (choicesEl) choicesEl.innerHTML = ''
        if (showEnding && choicesEl) {
          const { direction, align } = normalizeChoicesLayout(node)
          const card = endingCard || defaultEndingCard(node)
          const btns = Array.isArray(card && card.buttons) ? card.buttons : []
          for (const b of btns) {
            const bt = String(b && b.type || '')
            if (bt === 'backToHub') continue
            const label = String(b && b.label || '')
            const el = document.createElement('button')
            el.className = 'choiceBtn'
            el.textContent = label || (bt === 'restart' ? '重新开始' : bt || '按钮')
            if (direction === 'column' && align === 'stretch') {
              try { el.style.width = '100%' } catch (_) {}
            }
            el.addEventListener('click', () => {
              if (bt === 'restart') restart()
              else toast(label || '未实现按钮')
            })
            choicesEl.appendChild(el)
          }
        } else if (wait.kind === 'choice' && choicesEl) {
          const { direction, align } = normalizeChoicesLayout(node)
          const cs = Array.isArray(node && node.choices) ? node.choices : []
          for (const c of cs) {
            const visible = c && c.visibleWhen ? evalExpr(c.visibleWhen, vars) : true
            if (!visible) continue
            const enabled = c && c.enabledWhen ? evalExpr(c.enabledWhen, vars) : true
            const el = document.createElement('button')
            el.className = 'choiceBtn'
            el.disabled = !enabled
            el.textContent = String(c && c.text || '选择')
            if (direction === 'column' && align === 'stretch') {
              try { el.style.width = '100%' } catch (_) {}
            }
            el.addEventListener('click', () => choose(c))
            choicesEl.appendChild(el)
          }
        }

        if (actionsEl) actionsEl.style.display = (!showEnding && wait.kind === 'click') ? 'flex' : 'none'
      }

      function normalizeAdvance(a) {
        if (!a) return { type: 'auto' }
        if (typeof a === 'string') return { type: a }
        if (typeof a === 'object' && a.type) return a
        return { type: 'auto' }
      }

      function enterNode() {
        stepIndex = 0
        text = ''
        endingCard = null
        wait = { kind: 'auto' }
        stageOverride = {}
        nav = null
      }

      function runStable(node) {
        const steps = Array.isArray(node && node.timeline && node.timeline.steps) ? node.timeline.steps : []
        const maxAuto = 60
        let guard = 0
        while (guard++ < maxAuto) {
          if (nav) return
          if (endingCard) { wait = { kind: 'end' }; return }
          const step = steps[stepIndex] || null
          if (!step) {
            if (Array.isArray(node && node.choices) && node.choices.length) { wait = { kind:'choice' }; return }
            if (String(node && node.kind) === 'ending') { wait = { kind:'end' }; if (!endingCard) endingCard = defaultEndingCard(node); return }
            wait = { kind:'end' }; return
          }
          const acts = Array.isArray(step.actions) ? step.actions : []
          for (const a of acts) { applyAction(a, 0); if (nav) return; if (endingCard) { wait = {kind:'end'}; return } }
          const adv = normalizeAdvance(step.advance)
          const type = String(adv.type || 'auto')
          if (type === 'auto') { stepIndex++; continue }
          if (type === 'click') {
            const cs = Array.isArray(node && node.choices) ? node.choices : []
            if (cs.length) { wait = { kind:'choice' }; return }
            wait = { kind:'click' }
            return
          }
          if (type === 'choice') {
            const cs = Array.isArray(node && node.choices) ? node.choices : []
            if (!cs.length) { wait = { kind:'click' }; toast('未配置选项，已降级为「点击继续」'); return }
            wait = { kind:'choice' }; return
          }
          if (type === 'timer') { wait = { kind:'timer', ms: Math.max(0, Math.floor(Number(adv.ms ?? 0))) }; return }
          if (type === 'event') {
            const name = String(adv.name || '').trim()
            if (!name) { wait = { kind:'click' }; toast('event 缺少 name，已降级为「点击继续」'); return }
            if (name && Object.prototype.hasOwnProperty.call(eventMemory, name)) {
              const nm = { ...eventMemory }; try { delete nm[name] } catch (_) {}
              eventMemory = nm; stepIndex++; continue
            }
            wait = { kind:'event', name }
            return
          }
          if (type === 'condition') {
            if (!adv.expr) { wait = { kind:'click' }; toast('condition 缺少 expr，已降级为「点击继续」'); return }
            const pollMs = Number.isFinite(Number(adv.pollMs)) && Number(adv.pollMs) > 0 ? Math.floor(Number(adv.pollMs)) : 200
            if (evalExpr(adv.expr, vars)) { stepIndex++; continue }
            wait = { kind:'condition', expr: adv.expr, pollMs }
            return
          }
          if (type === 'end') { wait = { kind:'end' }; if (String(node && node.kind) === 'ending' && !endingCard) endingCard = defaultEndingCard(node); return }
          wait = { kind:'click' }; return
        }
        wait = { kind:'end' }
        toast('运行时：auto 步骤过多，已中止')
      }

      function tick() {
        clearTimers()
        const node = nodeById(nodeId)
        if (!node) return
        runStable(node)
        if (nav) {
          const n = nav; nav = null
          if (n.type === 'gotoNode') { gotoNode(n.nodeId, Number(n.delayMs) || 0); return }
          if (n.type === 'restart') { restart(); return }
          if (n.type === 'backToHub') { backToHub(n.url); return }
        }
        renderStage(node).catch(() => {})
        renderOverlay(node)
        if (wait.kind === 'timer') {
          timerId = setTimeout(() => { stepIndex++; wait = { kind:'auto' }; tick() }, Math.max(0, wait.ms || 0))
        } else if (wait.kind === 'condition') {
          const poll = Math.max(50, Math.floor(Number(wait.pollMs || 200)))
          pollId = setInterval(() => {
            if (evalExpr(wait.expr, vars)) {
              clearTimers()
              stepIndex++; wait = { kind:'auto' }; tick()
            }
          }, poll)
        }
      }

      function gotoNode(id, delayMs) {
        const to = String(id || '').trim()
        if (!to) return
        clearTimers()
        if (delayMs && delayMs > 0) {
          timerId = setTimeout(() => { nodeId = to; enterNode(); tick() }, delayMs)
          return
        }
        nodeId = to
        enterNode()
        tick()
      }

      function restart() {
        vars = buildDefaultVars(project && project.state && project.state.vars)
        eventMemory = {}
        gotoNode(story.startNodeId || story.startId, 0)
      }

      function backToHub(url) {
        const u = url ? String(url) : ''
        if (u) { window.location.href = u; return }
        try { if (window.history.length > 1) { window.history.back(); return } } catch (_) {}
        window.location.href = '/'
      }

      function choose(choice) {
        if (!choice || wait.kind !== 'choice') return
        const enabled = choice.enabledWhen ? evalExpr(choice.enabledWhen, vars) : true
        if (!enabled) return
        const effects = Array.isArray(choice.effects) ? choice.effects : []
        nav = null
        for (const a of effects) { applyAction(a, 0); if (nav) break }
        if (nav) { tick(); return }
        const to = String(choice.toNodeId || '').trim()
        if (!to) return
        setTimeout(() => gotoNode(to, 0), 200)
      }

      btnRestart?.addEventListener('click', () => restart())
      btnBack?.addEventListener('click', () => backToHub(''))
      btnContinue?.addEventListener('click', () => { if (wait.kind !== 'click') return; stepIndex++; wait = { kind:'auto' }; tick() })

      restart()
      window.addEventListener('resize', () => tick())
    </script>
  </body>
</html>`
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function rewriteAssetUriForDist(projectId, uri) {
  const raw = String(uri || '').trim()
  if (!raw) return raw
  const marker = `/project-assets/${encodeURIComponent(String(projectId || ''))}/`
  const idx = raw.indexOf(marker)
  if (idx >= 0) {
    const tail = raw.slice(idx + marker.length)
    return tail ? `./${tail.replace(/^\/+/, '')}` : raw
  }
  if (raw.startsWith('/project-assets/')) {
    const parts = raw.split('/').filter(Boolean)
    if (parts.length >= 3) {
      const tail = parts.slice(3).join('/')
      if (tail) return `./${tail}`
    }
  }
  return raw
}

function rewriteProjectAssetUrisForDist(project, projectId) {
  const p = project && typeof project === 'object' ? JSON.parse(JSON.stringify(project)) : {}
  const assets = Array.isArray(p.assets) ? p.assets : []
  p.assets = assets.map((a) => {
    if (!a || typeof a !== 'object') return a
    const next = { ...a }
    if (typeof next.uri === 'string') next.uri = rewriteAssetUriForDist(projectId, next.uri)
    return next
  })
  return p
}

export default {
  id: 'story-pixi',
  version: '0.1.0',
  displayName: '点击交互小故事（Pixi）',
  gameType: 'story',
  engine: 'pixi',

  async build(ctx) {
    const { projectId, projectDir, outDir, toolVersion, logger } = ctx
    await mkdir(outDir, { recursive: true })

    // 读取 project.json / story.json
    const projectJsonPath = path.join(projectDir, 'project.json')
    const storyPath = path.join(projectDir, 'story.json')
    const project = JSON.parse(await readFile(projectJsonPath, 'utf-8'))
    const story = JSON.parse(await readFile(storyPath, 'utf-8'))

    // 输出 story.json
    await writeFile(path.join(outDir, 'story.json'), JSON.stringify(story, null, 2), 'utf-8')

    // 输出 project.json（包含 assets/characters 等对象信息）
    // 导出包内统一改写为相对路径，避免依赖 /project-assets 动态路由。
    const projectForDist = rewriteProjectAssetUrisForDist(project, projectId)
    await writeFile(path.join(outDir, 'project.json'), JSON.stringify(projectForDist, null, 2), 'utf-8')

    // 输出 assets（若存在）
    const assetsSrc = path.join(projectDir, 'assets')
    const assetsDst = path.join(outDir, 'assets')
    try {
      const st = await stat(assetsSrc)
      if (st.isDirectory()) await copyDir(assetsSrc, assetsDst)
    } catch (_) {}

    const title = project?.title || `Story ${projectId}`
    await writeFile(path.join(outDir, 'index.html'), renderIndexHtml({ title }), 'utf-8')

    const manifest = {
      schemaVersion: '1.0',
      gameType: 'story',
      engine: 'pixi',
      entry: 'index.html',
      title,
      projectId,
      build: {
        time: isoNow(),
        toolVersion,
        pluginId: 'story-pixi',
        pluginVersion: '0.1.0'
      },
      files: {
        story: 'story.json',
        assetsDir: 'assets'
      }
    }
    await writeFile(path.join(outDir, 'game.manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    logger?.info?.('build ok', { outDir })
    return { manifest }
  }
}
