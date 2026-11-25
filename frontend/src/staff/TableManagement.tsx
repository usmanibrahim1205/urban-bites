import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { money, post, preparationLabel, request, RequestError } from '../customer/order-state'
import { useLiveUpdate } from '../live'
import { StaffLogin } from './StaffLogin'
import './tables.css'

interface QrBase { baseUrl: string; loopback: boolean }
interface DiningTable {
  number: string
  tableCode: string
  state: 'available' | 'awaiting-verification' | 'occupied' | 'bill-requested'
  pendingCount: number
  pendingTotalMinor: number
  sitting: {
    openedAt: string
    confirmedTotalMinor: number
    authorizedBrowserCount: number
    orders: { reference: string; status: string }[]
  } | null
}
interface Overview { restaurant: string; currency: string; defaultBase: QrBase; tables: DiningTable[] }

const endpoint = '/api/staff/tables'
const preference = 'urban-bites:qr-base'
const labels: Record<DiningTable['state'], string> = {
  available: 'Available',
  'awaiting-verification': 'First order awaiting verification',
  occupied: 'Occupied',
  'bill-requested': 'Bill requested',
}
const qrImage = (number: string, baseUrl: string, format = 'svg') =>
  `${endpoint}/${encodeURIComponent(number)}/qr/${format}?${new URLSearchParams({ baseUrl })}`

function readBase() {
  try { return localStorage.getItem(preference) } catch { return null }
}
function saveBase(base: string) {
  try { localStorage.setItem(preference, base) } catch { /* Selection still works for this visit. */ }
}
const date = (stamp: string) => new Date(stamp.replace(' ', 'T') + 'Z')
function elapsed(stamp: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - date(stamp).getTime()) / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function SignPreview({ numbers, restaurant, base, onBack }: {
  numbers: string[]; restaurant: string; base: QrBase; onBack: () => void
}) {
  const [loaded, setLoaded] = useState(new Set<string>())
  const [failed, setFailed] = useState(false)
  const pages = Array.from({ length: Math.ceil(numbers.length / 4) }, (_, index) => numbers.slice(index * 4, index * 4 + 4))
  return (
    <main className="table-print">
      <header className="print-controls">
        <div><button type="button" className="cash-button" onClick={onBack}>Back to tables</button>
          <h1>{numbers.length > 1 ? 'All table signs' : `Table ${numbers[0]} sign`}</h1>
          <p>Print preview · {numbers.length} {numbers.length === 1 ? 'sign' : 'signs'} · A4</p>
          <p className="table-url">{base.baseUrl}</p>
          {base.loopback && <p className="table-warning">A loopback QR address only reaches this computer.</p>}
        </div>
        <button type="button" className="cash-button primary" disabled={failed || loaded.size !== numbers.length}
          onClick={() => window.print()}>Print or save as PDF</button>
        {failed && <p role="alert">A QR image could not be loaded. Return to tables and reopen the preview.</p>}
      </header>
      <div className="print-pages">
        {pages.map((page, index) => <div key={index} className={`print-page ${numbers.length === 1 ? 'single-sign' : ''}`}>
          {page.map(number => <article className="table-sign" key={number} aria-label={`Table ${number} sign`}>
            <p className="sign-brand">{restaurant}</p>
            <h2>Table {number}</h2>
            <img src={qrImage(number, base.baseUrl)} alt={`Customer menu QR for Table ${number}`}
              onLoad={() => setLoaded(previous => new Set(previous).add(number))} onError={() => setFailed(true)} />
            <p className="sign-copy">Scan. Order. Enjoy.</p>
            <p>No app required.</p>
          </article>)}
        </div>)}
      </div>
    </main>
  )
}

function TableDetails({ table, currency, base, onPrint }: {
  table: DiningTable; currency: string; base: QrBase; onPrint: () => void
}) {
  const menuLink = new URL('/menu/' + encodeURIComponent(table.tableCode), base.baseUrl).href
  const field = useRef<HTMLInputElement>(null)
  const [feedback, setFeedback] = useState('')
  const [imageFailed, setImageFailed] = useState(false)

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(menuLink)
      setFeedback('Customer link copied.')
    } catch {
      field.current?.select()
      try {
        if (document.execCommand('copy')) {
          setFeedback('Customer link copied.')
          return
        }
      } catch { /* The selected link remains available to copy manually. */ }
      setFeedback('Link selected. Copy it with Ctrl+C or your device’s copy command.')
    }
  }

  async function download(format: 'svg' | 'png') {
    try {
      const response = await fetch(qrImage(table.number, base.baseUrl, format) + '&download=1')
      if (!response.ok) throw new Error('Download failed')
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `urban-bites-table-${table.number}.${format}`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setFeedback(`${format.toUpperCase()} download started.`)
    } catch {
      setFeedback('Could not download the QR code. Check your staff session and try again.')
    }
  }

  return (
    <section className="cash-panel table-details" aria-labelledby="table-detail-heading">
      <h2 id="table-detail-heading">Table {table.number} details</h2>
      <div className="table-detail-layout">
        <div>
          <span className={`table-state ${table.state}`}>{labels[table.state]}</span>
          {table.sitting
            ? <p className="table-note">Sitting started {date(table.sitting.openedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
            : <p className="table-note">No active sitting.</p>}
          <dl className="table-facts">
            <div><dt>Confirmed bill</dt><dd>{money(table.sitting?.confirmedTotalMinor ?? 0, currency)}</dd></div>
            <div><dt>Pending amount</dt><dd>{money(table.pendingTotalMinor, currency)}</dd></div>
            <div><dt>Pending requests</dt><dd>{table.pendingCount}</dd></div>
            <div><dt>Authorized browsers</dt><dd>{table.sitting?.authorizedBrowserCount ?? 0}</dd></div>
          </dl>
          {table.sitting?.orders.length ? <>
            <h3>Approved orders</h3>
            <ul className="table-orders">{table.sitting.orders.map(order => <li key={order.reference}>
              <span>{order.reference}</span><strong>{preparationLabel(order.status)}</strong>
            </li>)}</ul>
          </> : null}
          <Link to={`/cashier?table=${encodeURIComponent(table.number)}`}>Open Table {table.number} in cashier</Link>
        </div>
        <div className="table-qr">
          <h3>Permanent table QR</h3>
          {imageFailed ? <p role="alert">The QR image could not be loaded.</p>
            : <img src={qrImage(table.number, base.baseUrl)} alt={`Customer menu QR for Table ${table.number}`} onError={() => setImageFailed(true)} />}
          <label htmlFor="customer-link">Customer menu link</label>
          <input id="customer-link" ref={field} value={menuLink} readOnly />
          <div className="table-tools">
            <button type="button" className="cash-button" onClick={() => { void copy() }}>Copy customer menu link</button>
            <a className="cash-button" href={menuLink} target="_blank" rel="noreferrer">Open customer menu</a>
            <button type="button" className="cash-button" onClick={() => { void download('svg') }}>Download SVG</button>
            <button type="button" className="cash-button" onClick={() => { void download('png') }}>Download PNG</button>
            <button type="button" className="cash-button primary" onClick={onPrint}>Print table sign</button>
          </div>
          <p role="status">{feedback}</p>
        </div>
      </div>
    </section>
  )
}

export function TableManagement() {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [base, setBase] = useState<QrBase | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState('')
  const [print, setPrint] = useState<string[]>()
  const [initial, setInitial] = useState(true)
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [baseError, setBaseError] = useState('')
  const [now, setNow] = useState(Date.now)
  const version = useRef(0)
  const initializedBase = useRef(false)
  const detail = useRef<HTMLDivElement>(null)
  const connectionError = 'Could not load table management. Check your connection.'

  async function refresh() {
    const current = ++version.current
    try {
      const snapshot = await request<Overview>(endpoint)
      if (current !== version.current) return
      if (!initializedBase.current) {
        const saved = readBase()
        const choice = saved
          ? await post<QrBase>(endpoint + '/qr-base', { baseUrl: saved }).catch(() => snapshot.defaultBase)
          : snapshot.defaultBase
        if (current !== version.current) return
        initializedBase.current = true
        setBase(choice)
        setDraft(choice.baseUrl)
      }
      setOverview(snapshot)
      setError(message => message === connectionError ? '' : message)
    } catch (cause) {
      if (current !== version.current) return
      if (cause instanceof RequestError && cause.status === 401) {
        setOverview(null)
        setPrint(undefined)
      } else setError(connectionError)
    } finally {
      if (current === version.current) setInitial(false)
    }
  }

  useEffect(() => {
    void refresh()
    const clock = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => { version.current++; window.clearInterval(clock) }
  }, [])
  const live = useLiveUpdate('/', 'cashier:changed', Boolean(overview), () => { void refresh() })

  async function auth(action: 'login' | 'logout', credential?: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await post('/api/staff/' + action, { credential })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff access could not be updated.')
    } finally {
      setBusy(false)
    }
  }

  async function applyBase() {
    setApplying(true)
    setBaseError('')
    try {
      const choice = await post<QrBase>(endpoint + '/qr-base', { baseUrl: draft })
      setBase(choice)
      setDraft(choice.baseUrl)
      saveBase(choice.baseUrl)
    } catch (cause) {
      setBaseError(cause instanceof Error ? cause.message : 'Could not apply the QR address.')
    } finally {
      setApplying(false)
    }
  }

  if (!overview || !base) return <StaffLogin title="Table management" checking={initial} busy={busy} error={error}
    login={credential => { void auth('login', credential) }} />

  const { tables, restaurant, currency } = overview
  const table = tables.find(entry => entry.number === selected)
  const occupied = tables.filter(entry => entry.sitting).length
  const bills = tables.filter(entry => entry.state === 'bill-requested').length
  const awaiting = tables.filter(entry => entry.state === 'awaiting-verification').length
  if (print) return <SignPreview numbers={print} restaurant={restaurant} base={base} onBack={() => setPrint(undefined)} />

  return (
    <div className="cashier table-screen">
      <header className="cash-header">
        <div className="cash-wrap cash-header-inner">
          <div><Link className="cash-brand" to="/">{restaurant}</Link><h1>Table management</h1></div>
          <div className="cash-header-actions">
            <nav className="table-tools" aria-label="Staff navigation"><Link to="/cashier">Cashier</Link><Link to="/kitchen">Kitchen</Link></nav>
            <span role="status" className={`cash-live ${live ? 'positive' : 'attention'}`}><i aria-hidden="true" />{live ? 'Live updates' : 'Reconnecting'}</span>
            <button type="button" className="cash-button" disabled={busy} onClick={() => { void auth('logout') }}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="cash-wrap">
        <dl className="cash-metrics table-metrics">
          <div><dt>Total tables</dt><dd>{tables.length}</dd></div>
          <div><dt>Available tables</dt><dd>{tables.length - occupied}</dd></div>
          <div><dt>Occupied tables</dt><dd>{occupied}</dd></div>
          <div><dt>Bill requests</dt><dd>{bills}</dd></div>
          <div><dt>Tables awaiting verification</dt><dd>{awaiting}</dd></div>
        </dl>
        <p className="table-note">Bill requests count toward occupied tables. Tables awaiting first-order verification count as available until approved.</p>
        {error && <p className="table-warning" role="alert">{error}</p>}
        <section className="table-settings" aria-labelledby="qr-settings-heading">
          <h2 id="qr-settings-heading">QR address</h2>
          <form onSubmit={event => { event.preventDefault(); void applyBase() }}>
            <label htmlFor="qr-base">QR base URL</label>
            <div className="table-tools">
              <input id="qr-base" value={draft} onChange={event => setDraft(event.target.value)} required maxLength={256} spellCheck={false} />
              <button className="cash-button" type="submit" disabled={applying}>Apply address</button>
              <button className="cash-button primary" type="button" onClick={() => setPrint(tables.map(entry => entry.number))}
                disabled={!tables.length}>Print all QR codes</button>
            </div>
          </form>
          <p className="table-note">Current address <strong className="table-url">{base.baseUrl}</strong></p>
          {base.loopback && <p className="table-warning">This loopback address only reaches this computer. Use the host’s LAN address for other devices.</p>}
          {baseError && <p className="table-warning" role="alert">{baseError}</p>}
        </section>
        <section aria-labelledby="table-grid-heading">
          <h2 className="table-grid-heading" id="table-grid-heading">Restaurant tables</h2>
          <ul className="table-grid">
            {tables.map(entry => <li key={entry.number}>
              <button type="button" aria-pressed={selected === entry.number} onClick={() => {
                setSelected(entry.number)
                requestAnimationFrame(() => detail.current?.focus())
              }}>
                <strong>Table {entry.number}</strong>
                <span className={`table-state ${entry.state}`}>{labels[entry.state]}</span>
                {entry.sitting && <span>{money(entry.sitting.confirmedTotalMinor, currency)} · {elapsed(entry.sitting.openedAt, now)}</span>}
                {entry.pendingCount > 0 && <span>{entry.pendingCount} pending {entry.pendingCount === 1 ? 'request' : 'requests'}</span>}
                <span className="table-link-text">Details and QR</span>
              </button>
            </li>)}
          </ul>
        </section>
        {table && <div ref={detail} tabIndex={-1}><TableDetails key={table.number + base.baseUrl} table={table} currency={currency}
          base={base} onPrint={() => setPrint([table.number])} /></div>}
      </main>
    </div>
  )
}
