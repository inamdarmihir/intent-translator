import { useState, useEffect, useCallback, useRef } from 'react'

const API = 'http://localhost:8000'

async function parseError(res) {
  const text = await res.text()
  try { return JSON.parse(text).detail || text }
  catch { return text }
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg: '#f5f5f7',
  panel: '#ffffff',
  border: 'rgba(0,0,0,0.08)',
  divider: 'rgba(0,0,0,0.05)',
  ink: '#1d1d1f',
  secondary: '#6e6e73',
  tertiary: '#aeaeb2',
  blue: '#0071e3',
  blueDim: '#0058b0',
  blueAlpha: 'rgba(0,113,227,0.12)',
  blueLight: '#e8f0fb',
  green: '#34c759',
  greenLight: '#edfaef',
  orange: '#ff9f0a',
  orangeLight: '#fff4e0',
  red: '#ff3b30',
  redLight: '#fff2f1',
  shadow: '0 1px 4px rgba(0,0,0,0.06)',
  shadowMd: '0 4px 20px rgba(0,0,0,0.08)',
}

const EXAMPLES = [
  "I was wondering if maybe you could possibly give me a hand with this?",
  "That's not quite what we were looking for — the structure could use some work.",
  "I'm so sorry about this — I really dropped the ball and I feel terrible.",
  "Absolutely! That's a great idea, I totally agree!",
  "Sorry to bother you, but just wanted to gently remind you about the deadline.",
  "Hi there, hope you're doing well! Just checking in.",
]

const REGISTERS = [
  { value: '', label: 'Auto' },
  { value: 'formal', label: 'Formal' },
  { value: 'semi-formal', label: 'Semi' },
  { value: 'informal', label: 'Informal' },
]

const SUGGESTED_URLS = [
  { label: 'Goethe Institut', url: 'https://www.goethe.de/en/spr/mag.html' },
  { label: 'DW Learn German', url: 'https://learngerman.dw.com/en/overview' },
  { label: 'Sprachlog', url: 'https://www.sprachlog.de' },
  { label: 'Deutsch Perfekt', url: 'https://www.deutsch-perfekt.com' },
]


// ── Tiny shared components ────────────────────────────────────────────────────

function Spinner({ size = 16, color = C.blue }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, flexShrink: 0,
      border: `2px solid ${color}30`, borderTopColor: color,
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  )
}

function Dot({ on, pulse }) {
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
      background: on ? C.green : C.tertiary,
      animation: pulse ? 'pulse 1.4s ease-in-out infinite' : 'none',
    }} />
  )
}

function Pill({ children, active, color = C.blue, onClick, style }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 11px', fontSize: 12, fontWeight: 500,
      border: `1px solid ${active ? color : C.border}`,
      borderRadius: 20, cursor: 'pointer', transition: 'all 0.12s ease',
      background: active ? color + '15' : 'transparent',
      color: active ? color : C.secondary,
      ...style,
    }}>{children}</button>
  )
}


// ── Engine badge ─────────────────────────────────────────────────────────────

function EngineBadge({ inference }) {
  if (!inference) return null
  const { active_engine, llama_model_name, ollama_model, llama_cpp_available, ollama_available, ollama_model_pulled } = inference
  const isLlama = active_engine?.startsWith('llama.cpp')
  const isOllama = active_engine?.startsWith('ollama')
  const isNone = active_engine === 'none'

  const label = isLlama ? `⚡ ${llama_model_name || 'llama.cpp'}`
    : isOllama ? `🦙 ${ollama_model}`
      : '⚠ No engine'

  const bg = isLlama ? C.greenLight : isOllama ? C.blueLight : C.redLight
  const color = isLlama ? C.green : isOllama ? C.blue : C.red

  return (
    <span title={
      isNone
        ? 'Set LLAMA_MODEL_PATH in backend/.env, or run: ollama serve && ollama pull llama3.2'
        : `Active: ${active_engine}`
    } style={{
      fontSize: 11, fontWeight: 500, padding: '3px 9px', borderRadius: 20,
      background: bg, color, border: `1px solid ${color}25`, cursor: 'default',
      letterSpacing: '-0.1px',
    }}>
      {label}
    </span>
  )
}


// ── Crawl panel ──────────────────────────────────────────────────────────────

function CrawlPanel({ quota, onQuotaChange, onCrawledCountChange }) {
  const [url, setUrl] = useState('')
  const [maxPages, setMaxPages] = useState(8)
  const [crawling, setCrawling] = useState(false)
  const [log, setLog] = useState([])
  const [stats, setStats] = useState({ pages: 0, chunks: 0 })
  const [phase, setPhase] = useState('idle')
  const esRef = useRef(null)
  const logEndRef = useRef(null)

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log])

  const addLog = (msg, type = 'info') =>
    setLog(prev => [...prev.slice(-80), { msg, type }])

  async function startCrawl() {
    if (!url.trim() || crawling) return
    if (quota?.exhausted) { addLog('✗ Monthly quota exhausted.', 'error'); return }
    setCrawling(true); setPhase('starting'); setLog([]); setStats({ pages: 0, chunks: 0 })

    let crawlId
    try {
      const res = await fetch(`${API}/crawl/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, max_pages: maxPages }),
      })
      if (!res.ok) throw new Error(await parseError(res))
      crawlId = (await res.json()).crawl_id
    } catch (e) {
      addLog(`✗ ${e.message}`, 'error'); setCrawling(false); setPhase('error'); return
    }

    const es = new EventSource(`${API}/crawl/stream/${crawlId}?url=${encodeURIComponent(url)}&max_pages=${maxPages}`)
    esRef.current = es

    const handlers = {
      status: d => { addLog(d.message, 'info'); setPhase(d.phase || 'crawling') },
      page: d => { setStats({ pages: d.pages_crawled, chunks: d.total_chunks }); onCrawledCountChange(d.total_chunks); if (d.quota) onQuotaChange(d.quota); addLog(d.message, 'success') },
      skip: d => addLog(`↷ skipped (${d.reason})`, 'muted'),
      heartbeat: d => addLog(`… ${d.pages_so_far} pages, ${d.chunks_so_far} chunks`, 'muted'),
      warn: d => addLog(`⚠ ${d.message}`, 'warn'),
      quota_stop: d => { addLog(`⛔ ${d.message}`, 'error'); if (d.quota) onQuotaChange(d.quota) },
      done: d => { addLog(`✓ ${d.message}`, 'success'); if (d.quota) onQuotaChange(d.quota); setPhase('done'); setCrawling(false); es.close() },
      error: d => { addLog(`✗ ${d.message}`, 'error'); if (d.quota) onQuotaChange(d.quota); setPhase('error'); setCrawling(false); es.close() },
    }
    Object.entries(handlers).forEach(([evt, fn]) => es.addEventListener(evt, e => fn(JSON.parse(e.data))))
    es.onerror = () => { addLog('Stream closed.', 'muted'); setCrawling(false); es.close() }
  }

  function stopCrawl() {
    esRef.current?.close(); setCrawling(false); setPhase('idle'); addLog('Stopped.', 'warn')
  }

  async function clearDocs() {
    await fetch(`${API}/crawl/documents`, { method: 'DELETE' })
    onCrawledCountChange(0); setStats({ pages: 0, chunks: 0 }); addLog('Cleared.', 'warn')
  }

  const logColor = { info: C.secondary, success: C.green, warn: C.orange, error: C.red, muted: C.tertiary }
  const effective = quota ? Math.min(maxPages, quota.remaining) : maxPages
  const capped = effective < maxPages

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 640 }}>
      <p style={{ fontSize: 13, color: C.secondary, lineHeight: 1.7 }}>
        Crawl any site and index it into Qdrant for richer translations. Pages are chunked, embedded locally, and stored in real-time.
      </p>

      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.border}`, overflow: 'hidden', boxShadow: C.shadow }}>
        {/* Header */}
        <div style={{ padding: '12px 16px', background: '#1d1d1f', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Dot on={phase === 'done'} pulse={crawling} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>Live Crawl → Qdrant</span>
          </div>
          {stats.chunks > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: C.green, fontWeight: 500 }}>{stats.chunks} chunks</span>
              <button onClick={clearDocs} disabled={crawling} style={{ fontSize: 11, padding: '2px 8px', background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 5, cursor: 'pointer' }}>clear</button>
            </div>
          )}
        </div>

        {/* URL input */}
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.divider}` }}>
          {quota?.exhausted && (
            <div style={{ marginBottom: 10, padding: '8px 12px', background: C.redLight, border: `1px solid ${C.red}20`, borderRadius: 8, fontSize: 12, color: C.red }}>
              ⛔ Monthly quota exhausted. Resets on the 1st.
            </div>
          )}
          {capped && !quota?.exhausted && (
            <div style={{ marginBottom: 8, padding: '6px 10px', background: C.orangeLight, border: `1px solid ${C.orange}30`, borderRadius: 6, fontSize: 11, color: C.orange }}>
              ⚠ Capping to {effective} pages ({quota.remaining} remaining this month)
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && startCrawl()}
              placeholder="https://..." disabled={crawling || quota?.exhausted}
              style={{ flex: 1, padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, outline: 'none', color: C.ink, background: crawling ? C.bg : 'white' }}
            />
            <input type="number" value={maxPages} min="1" max="50" onChange={e => setMaxPages(Math.max(1, Math.min(50, +e.target.value)))}
              disabled={crawling} title="Max pages"
              style={{ width: 54, padding: '8px 6px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12, textAlign: 'center', outline: 'none' }}
            />
            {crawling
              ? <button onClick={stopCrawl} style={{ padding: '8px 14px', fontSize: 12, fontWeight: 600, background: C.red, color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer' }}>■ Stop</button>
              : <button onClick={startCrawl} disabled={!url.trim() || quota?.exhausted} style={{ padding: '8px 16px', fontSize: 12, fontWeight: 600, background: url.trim() && !quota?.exhausted ? C.blue : C.border, color: url.trim() && !quota?.exhausted ? 'white' : C.tertiary, border: 'none', borderRadius: 8, cursor: 'pointer' }}>▶ Crawl</button>
            }
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {SUGGESTED_URLS.map(s => (
              <Pill key={s.url} active={url === s.url} onClick={() => setUrl(s.url)} style={{ fontSize: 11 }}>{s.label}</Pill>
            ))}
          </div>
        </div>

        {/* Stats */}
        {(crawling || stats.pages > 0) && (
          <div style={{ padding: '8px 16px', background: C.blueLight, borderBottom: `1px solid rgba(0,113,227,0.1)`, display: 'flex', gap: 16, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: C.secondary }}>
              <strong style={{ color: C.ink }}>{stats.pages}</strong> pages ·{' '}
              <strong style={{ color: C.ink }}>{stats.chunks}</strong> chunks
            </span>
            {crawling && <Spinner size={11} />}
            {phase === 'done' && <span style={{ fontSize: 11, color: C.green, fontWeight: 500 }}>✓ complete</span>}
          </div>
        )}

        {/* Log */}
        {log.length > 0 && (
          <div style={{ height: 150, overflowY: 'auto', padding: '10px 14px', background: '#fafafa', fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: 11, lineHeight: 1.8 }}>
            {log.map((e, i) => <div key={i} style={{ color: logColor[e.type] || C.secondary }}>{e.msg}</div>)}
            <div ref={logEndRef} />
          </div>
        )}
      </div>
    </div>
  )
}


// ── Settings panel ────────────────────────────────────────────────────────────

function SettingsPanel({ inference, quota, onSetCap }) {
  const [editingCap, setEditingCap] = useState(false)
  const [capInput, setCapInput] = useState('')

  const [apiConfig, setApiConfig] = useState({ llama_model_path: '', firecrawl_api_key: '' })
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [savingConfig, setSavingConfig] = useState(false)

  useEffect(() => {
    fetch(`${API}/settings`)
      .then(r => r.json())
      .then(d => { setApiConfig(d); setLoadingConfig(false) })
      .catch(() => setLoadingConfig(false))
  }, [])

  async function saveCap() {
    const val = parseInt(capInput)
    if (!val || val < 1 || val > 500) return
    await onSetCap(val)
    setEditingCap(false)
  }

  async function saveApiConfig() {
    setSavingConfig(true)
    try {
      await fetch(`${API}/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(apiConfig),
      })
    } finally {
      setSavingConfig(false)
    }
  }

  return (
    <div style={{ maxWidth: 540, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2 style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.3px' }}>Settings</h2>

      {/* Inference */}
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.border}`, padding: '16px 18px', boxShadow: C.shadow }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Local Inference</div>
        {inference ? (
          <div style={{ fontSize: 13, color: C.secondary, lineHeight: 2 }}>
            <div>Active engine: <strong style={{ color: C.ink }}>{inference.active_engine}</strong></div>
            {inference.llama_model_path && <div>Model path: <code style={{ fontSize: 11 }}>{inference.llama_model_path}</code></div>}
            <div>Embed: <code style={{ fontSize: 11 }}>{inference.embed_model}</code> (local)</div>
            <div style={{ marginTop: 10, padding: '10px 14px', background: C.blueLight, borderRadius: 10, fontSize: 12, lineHeight: 1.9 }}>
              <strong style={{ color: C.ink }}>llama.cpp (recommended):</strong><br />
              <code style={{ fontSize: 11 }}>LLAMA_MODEL_PATH=/path/to/model.gguf</code> in <code style={{ fontSize: 11 }}>backend/.env</code><br />
              Any GGUF model works — including BitNet b1.58 quantized weights.<br />
              <br />
              <strong style={{ color: C.ink }}>Ollama (secondary):</strong><br />
              <code style={{ fontSize: 11 }}>ollama serve &amp;&amp; ollama pull llama3.2</code>
            </div>
          </div>
        ) : (
          <span style={{ fontSize: 13, color: C.tertiary }}>Loading…</span>
        )}
      </div>

      {/* Firecrawl quota */}
      {quota && (
        <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.border}`, padding: '16px 18px', boxShadow: C.shadow }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Firecrawl Quota · {quota.month}
            </div>
            <button onClick={() => { setEditingCap(e => !e); setCapInput(String(quota.cap)) }}
              style={{ fontSize: 11, color: C.blue, background: 'none', border: 'none', cursor: 'pointer' }}>
              {editingCap ? 'Cancel' : 'Edit cap'}
            </button>
          </div>
          <div style={{ height: 6, background: C.bg, borderRadius: 3, overflow: 'hidden', marginBottom: 8 }}>
            <div style={{ height: '100%', width: `${Math.min(100, quota.percent_used)}%`, background: quota.exhausted ? C.red : quota.percent_used > 70 ? C.orange : C.green, borderRadius: 3, transition: 'width 0.4s ease' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: quota.exhausted ? C.red : C.secondary }}>
            <span>{quota.pages_used} / {quota.cap} pages used</span>
            <span style={{ color: quota.exhausted ? C.red : C.green, fontWeight: 500 }}>
              {quota.exhausted ? '✗ exhausted' : `${quota.remaining} remaining`}
            </span>
          </div>
          {editingCap && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="number" min="1" max="500" value={capInput} onChange={e => setCapInput(e.target.value)}
                style={{ width: 72, padding: '5px 10px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, outline: 'none' }}
              />
              <span style={{ fontSize: 12, color: C.secondary }}>/ 500 free</span>
              <button onClick={saveCap} style={{ padding: '5px 14px', fontSize: 12, fontWeight: 600, background: C.blue, color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer' }}>Save</button>
            </div>
          )}
        </div>
      )}

      {/* API Configuration */}
      <div style={{ background: C.panel, borderRadius: 14, border: `1px solid ${C.border}`, padding: '16px 18px', boxShadow: C.shadow }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>API Keys & Paths</div>
        {loadingConfig ? <span style={{ fontSize: 13, color: C.tertiary }}>Loading configurations…</span> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: C.ink, fontWeight: 500, marginBottom: 6 }}>LLAMA_MODEL_PATH</label>
              <input value={apiConfig.llama_model_path} onChange={e => setApiConfig(c => ({ ...c, llama_model_path: e.target.value }))}
                placeholder="../models/Llama-3.2-1B-Instruct-Q4_K_M.gguf"
                style={{ width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, outline: 'none', color: C.ink }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: C.ink, fontWeight: 500, marginBottom: 6 }}>FIRECRAWL_API_KEY</label>
              <input type="password" value={apiConfig.firecrawl_api_key} onChange={e => setApiConfig(c => ({ ...c, firecrawl_api_key: e.target.value }))}
                placeholder="fc-..."
                style={{ width: '100%', padding: '8px 12px', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 13, outline: 'none', color: C.ink }}
              />
            </div>
            <button onClick={saveApiConfig} disabled={savingConfig} style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600, alignSelf: 'flex-start',
              background: C.blue, color: 'white', border: 'none', borderRadius: 8, cursor: savingConfig ? 'default' : 'pointer'
            }}>
              {savingConfig ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}


// ── Insights drawer (below translate panels) ──────────────────────────────────

function InsightsDrawer({ result }) {
  if (!result) return null
  const hasCrawled = result.crawled_chunks_used?.length > 0
  const hasPatterns = result.retrieved_patterns?.length > 0

  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`,
      borderTop: 'none', borderRadius: '0 0 16px 16px',
      animation: 'slideDown 0.25s ease', overflowY: 'auto',
      maxHeight: '50vh'
    }}>
      <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Left col */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Intent Detected</div>
            <p style={{ fontSize: 13, fontStyle: 'italic', color: C.ink, lineHeight: 1.55 }}>{result.intent_detected}</p>
          </div>
          {result.emotion_detected && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Emotion</div>
              <p style={{ fontSize: 13, fontStyle: 'italic', color: C.orange, lineHeight: 1.55 }}>{result.emotion_detected}</p>
            </div>
          )}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>What Changed</div>
            <p style={{ fontSize: 12, color: C.secondary, lineHeight: 1.65 }}>{result.what_changed}</p>
          </div>
        </div>

        {/* Right col */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {result.cultural_notes?.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Cultural Notes</div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
                {result.cultural_notes.map((n, i) => (
                  <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: C.secondary, lineHeight: 1.6 }}>
                    <span style={{ color: C.blue, flexShrink: 0, marginTop: 2 }}>•</span>{n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasCrawled && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Live Context Used</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {result.crawled_chunks_used.map((c, i) => (
                  <div key={i} style={{ padding: '8px 10px', background: C.greenLight, borderRadius: 8, fontSize: 11, color: C.secondary, border: `1px solid ${C.green}20` }}>
                    <div style={{ fontWeight: 600, color: C.green, marginBottom: 2, fontSize: 10 }}>{c.title?.slice(0, 55) || c.url?.slice(0, 55)}</div>
                    "{c.text?.slice(0, 160)}…"
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasPatterns && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>Intent Patterns Retrieved</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.retrieved_patterns.map((p, i) => (
                  <div key={i} style={{ padding: '6px 10px', background: C.bg, borderRadius: 8, fontSize: 11, border: `1px solid ${C.border}` }}>
                    <span style={{ fontWeight: 600, color: C.ink }}>{p.intent_label}</span>
                    <span style={{ color: C.tertiary }}> · {p.register}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [text, setText] = useState('')
  const [register, setRegister] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState(null)
  const [showInsights, setShowInsights] = useState(false)
  const [activeTab, setActiveTab] = useState('translate')
  const [status, setStatus] = useState({
    indexed: false, intentCount: 0, cultureCount: 0,
    crawledCount: 0, quota: null, inference: null,
  })
  const textareaRef = useRef(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/index/status`)
      const d = await res.json()
      setStatus({
        indexed: d.status === 'indexed',
        intentCount: d.intent_count ?? 0,
        cultureCount: d.culture_count ?? 0,
        crawledCount: d.crawled_count ?? 0,
        quota: d.quota,
        inference: d.inference,
      })
    } catch {
      setStatus(s => ({ ...s, indexed: false }))
    }
  }, [])

  useEffect(() => { fetchStatus() }, [fetchStatus])

  async function handleIndex() {
    setIndexing(true); setError(null)
    try {
      const res = await fetch(`${API}/index`, { method: 'POST' })
      if (!res.ok) throw new Error(await parseError(res))
      await fetchStatus()
    } catch (e) {
      setError(`Indexing failed: ${e.message}`)
    } finally {
      setIndexing(false)
    }
  }

  async function handleTranslate() {
    if (!text.trim() || loading || !status.indexed) return
    setLoading(true); setError(null); setResult(null); setShowInsights(false)
    try {
      const res = await fetch(`${API}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, register: register || undefined, auto_crawl: true }),
      })
      if (!res.ok) throw new Error(await parseError(res))
      const data = await res.json()
      setResult(data)
      setShowInsights(true)
      if (data.quota) setStatus(s => ({ ...s, quota: data.quota }))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleClear() {
    setText(''); setResult(null); setError(null); setShowInsights(false)
    textareaRef.current?.focus()
  }

  async function handleSetCap(cap) {
    await fetch(`${API}/quota/cap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cap }),
    })
    await fetchStatus()
  }

  const { indexed, intentCount, cultureCount, crawledCount, quota, inference } = status
  const canTranslate = indexed && text.trim() && !loading

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: C.bg, color: C.ink, overflow: 'hidden',
    }}>

      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div style={{
        height: 50, flexShrink: 0, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', padding: '0 18px',
        background: 'rgba(255,255,255,0.88)',
        backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
        borderBottom: `1px solid ${C.border}`, gap: 12,
      }}>
        {/* Left: title + tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.4px' }}>Translate</span>
          <div style={{ display: 'flex', gap: 1, background: 'rgba(0,0,0,0.07)', borderRadius: 9, padding: '2px' }}>
            {['translate', 'crawl', 'settings'].map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding: '4px 13px', fontSize: 12, fontWeight: 500,
                border: 'none', borderRadius: 7, cursor: 'pointer',
                background: activeTab === tab ? 'white' : 'transparent',
                color: activeTab === tab ? C.ink : C.secondary,
                boxShadow: activeTab === tab ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.15s ease', textTransform: 'capitalize',
              }}>{tab}{tab === 'crawl' && crawledCount > 0 ? ` (${crawledCount})` : ''}</button>
            ))}
          </div>
        </div>

        {/* Right: engine + index status + button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <EngineBadge inference={inference} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.secondary }}>
            <Dot on={indexed} pulse={indexing} />
            {indexed
              ? `${intentCount} intents · ${cultureCount} culture`
              : 'Not indexed'}
          </div>
          <button onClick={handleIndex} disabled={indexing} style={{
            padding: '5px 13px', fontSize: 12, fontWeight: 600,
            background: indexing ? C.blueAlpha : C.blue,
            color: indexing ? C.blue : 'white',
            border: 'none', borderRadius: 9, cursor: indexing ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'all 0.15s',
          }}>
            {indexing ? <><Spinner size={11} color={C.blue} /> Indexing</> : indexed ? '↺ Re-index' : 'Index KB'}
          </button>
        </div>
      </div>

      {/* ── Translate tab ────────────────────────────────────────────────── */}
      {activeTab === 'translate' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '14px 18px 0' }}>

          {/* Language selector bar */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 8, marginBottom: 10, flexShrink: 0,
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 3,
              background: C.blueLight, border: `1px solid rgba(0,113,227,0.2)`,
              borderRadius: 20, padding: '5px 14px',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.blue }}>English</span>
            </div>

            {/* Swap button */}
            <button
              onClick={handleClear}
              title="Clear"
              style={{
                width: 34, height: 34, borderRadius: '50%',
                background: C.panel, border: `1px solid ${C.border}`,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, color: C.secondary, transition: 'all 0.15s',
                boxShadow: C.shadow,
              }}
            >⇄</button>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 3,
              background: 'rgba(52,199,89,0.1)', border: '1px solid rgba(52,199,89,0.25)',
              borderRadius: 20, padding: '5px 14px',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: C.green }}>German</span>
            </div>
          </div>

          {/* Two panels */}
          <div style={{
            flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0,
            background: C.panel, borderRadius: result && showInsights ? '16px 16px 0 0' : 16,
            border: `1px solid ${C.border}`, borderBottom: result && showInsights ? `1px solid ${C.divider}` : `1px solid ${C.border}`,
            boxShadow: C.shadowMd,
          }}>

            {/* Left — English input */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <textarea
                ref={textareaRef}
                value={text}
                onChange={e => { setText(e.target.value); setResult(null); setShowInsights(false) }}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') handleTranslate() }}
                placeholder="Type or paste text to translate…"
                style={{
                  flex: 1, padding: '18px 20px', border: 'none', outline: 'none',
                  fontSize: 17, lineHeight: 1.55, color: C.ink,
                  background: 'transparent', minHeight: 0,
                }}
              />

              {/* Example pills */}
              {!text && (
                <div style={{ padding: '0 20px 10px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {EXAMPLES.map((ex, i) => (
                    <button key={i} onClick={() => { setText(ex); setResult(null) }} style={{
                      padding: '4px 10px', fontSize: 11, color: C.secondary,
                      border: `1px solid ${C.border}`, borderRadius: 20, background: 'transparent',
                      cursor: 'pointer', whiteSpace: 'nowrap', maxWidth: 200,
                      overflow: 'hidden', textOverflow: 'ellipsis', transition: 'all 0.1s',
                    }}>
                      {ex.length > 36 ? ex.slice(0, 35) + '…' : ex}
                    </button>
                  ))}
                </div>
              )}

              {/* Bottom bar */}
              <div style={{
                padding: '10px 16px', borderTop: `1px solid ${C.divider}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexShrink: 0,
              }}>
                {/* Register pills */}
                <div style={{ display: 'flex', gap: 5 }}>
                  {REGISTERS.map(r => (
                    <Pill key={r.value} active={register === r.value} onClick={() => setRegister(r.value)}>
                      {r.label}
                    </Pill>
                  ))}
                </div>

                {/* Right: char count + clear + translate */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {text && (
                    <>
                      <span style={{ fontSize: 11, color: C.tertiary }}>{text.length}</span>
                      <button onClick={handleClear} style={{
                        width: 22, height: 22, borderRadius: '50%', border: 'none',
                        background: 'rgba(0,0,0,0.07)', color: C.secondary,
                        cursor: 'pointer', fontSize: 13, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>×</button>
                    </>
                  )}
                  <button
                    onClick={handleTranslate}
                    disabled={!canTranslate}
                    style={{
                      padding: '7px 18px', fontSize: 13, fontWeight: 600,
                      background: canTranslate ? C.blue : C.blueAlpha,
                      color: canTranslate ? 'white' : C.blue + '80',
                      border: 'none', borderRadius: 20,
                      cursor: canTranslate ? 'pointer' : 'default',
                      display: 'flex', alignItems: 'center', gap: 6,
                      transition: 'all 0.15s ease',
                      boxShadow: canTranslate ? '0 2px 8px rgba(0,113,227,0.3)' : 'none',
                    }}
                  >
                    {loading
                      ? <><Spinner size={12} color="white" /> Translating</>
                      : !indexed
                        ? 'Index KB first'
                        : 'Translate →'
                    }
                  </button>
                </div>
              </div>
            </div>

            {/* Divider */}
            <div style={{ width: 1, background: C.border, flexShrink: 0 }} />

            {/* Right — German output */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ flex: 1, padding: '18px 20px', overflow: 'auto', minHeight: 0 }}>
                {!result && !loading && (
                  <div style={{
                    height: '100%', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    gap: 8, color: C.tertiary, userSelect: 'none',
                  }}>
                    <span style={{ fontSize: 32 }}>🇩🇪</span>
                    <span style={{ fontSize: 15, fontStyle: 'italic', color: C.tertiary }}>Warte auf deine Eingabe…</span>
                    <span style={{ fontSize: 12 }}>Translation appears here</span>
                    {crawledCount > 0 && <span style={{ fontSize: 11, color: C.green }}>✓ {crawledCount} crawled chunks ready</span>}
                  </div>
                )}

                {loading && (
                  <div style={{
                    height: '100%', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: 12, color: C.secondary,
                  }}>
                    <Spinner size={28} />
                    <span style={{ fontSize: 13 }}>Analyzing intent & translating…</span>
                    <span style={{ fontSize: 11, color: C.tertiary }}>
                      {inference?.active_engine || 'local engine'}
                    </span>
                  </div>
                )}

                {result && (
                  <div style={{ animation: 'fadeUp 0.3s ease' }}>
                    <p style={{ fontSize: 17, lineHeight: 1.55, color: C.ink, fontWeight: 400, letterSpacing: '-0.1px' }}>
                      {result.translation}
                    </p>
                  </div>
                )}
              </div>

              {/* Output bottom bar */}
              {result && (
                <div style={{
                  padding: '10px 16px', borderTop: `1px solid ${C.divider}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 500, padding: '3px 9px', borderRadius: 20,
                      background: 'rgba(52,199,89,0.1)', color: C.green,
                      border: '1px solid rgba(52,199,89,0.2)',
                    }}>
                      {result.register_used}
                    </span>
                    <span style={{ fontSize: 11, color: C.tertiary }}>
                      {result.engine_used?.split(' ')[0]}
                    </span>
                  </div>
                  <button
                    onClick={() => setShowInsights(o => !o)}
                    style={{
                      fontSize: 12, fontWeight: 500, color: C.blue,
                      background: showInsights ? C.blueAlpha : 'none',
                      border: showInsights ? `1px solid rgba(0,113,227,0.2)` : '1px solid transparent',
                      borderRadius: 8, padding: '3px 10px', cursor: 'pointer', transition: 'all 0.15s',
                    }}
                  >
                    {showInsights ? '▾' : '▸'} Intent Insights
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Insights drawer */}
          {result && showInsights && <InsightsDrawer result={result} />}

          {/* Error */}
          {error && (
            <div style={{
              marginTop: 10, padding: '10px 16px', flexShrink: 0,
              background: C.redLight, border: `1px solid ${C.red}25`,
              borderRadius: 10, fontSize: 13, color: C.red,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>{error}</span>
              <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: 16, lineHeight: 1 }}>×</button>
            </div>
          )}

          <div style={{ height: 16, flexShrink: 0 }} />
        </div>
      )}

      {/* ── Crawl tab ────────────────────────────────────────────────────── */}
      {activeTab === 'crawl' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 18px' }}>
          <CrawlPanel
            quota={quota}
            onQuotaChange={q => setStatus(s => ({ ...s, quota: q }))}
            onCrawledCountChange={c => setStatus(s => ({ ...s, crawledCount: c }))}
          />
        </div>
      )}

      {/* ── Settings tab ─────────────────────────────────────────────────── */}
      {activeTab === 'settings' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 18px' }}>
          <SettingsPanel inference={inference} quota={quota} onSetCap={handleSetCap} />
        </div>
      )}
    </div>
  )
}
