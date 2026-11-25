import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { money, post, preparationLabel, request, RequestError } from '../customer/order-state'
import type { OrderReceipt } from '../customer/order-state'
import { useLiveUpdate } from '../live'
import { StaffLogin } from './StaffLogin'
import './cashier.css'

type Classification = 'first' | 'additional' | 'unknown' | 'stale'
interface PendingOrder {
  reference: string
  tableNumber: string
  createdAt: string
  totalMinor: number
  itemCount: number
  classification: Classification
  reviewKey: string
  items: OrderReceipt['items']
}
interface Sitting {
  id: number
  tableNumber: string
  openedAt: string
  billRequestedAt: string | null
  billRevision: number
  confirmedTotalMinor: number
  pendingTotalMinor: number
  unresolvedCount: number
  orders: Pick<OrderReceipt, 'reference' | 'items' | 'totalMinor' | 'status'>[]
  pending: Sitting['orders']
  browsers: { id: number; authorizedAt: string }[]
}
interface Overview {
  restaurant: string
  currency: string
  tableCount: number
  orders: PendingOrder[]
  sessions: Sitting[]
}

const labels: Record<Classification, string> = {
  first: 'First order',
  additional: 'Authorized browser',
  unknown: 'Unknown browser',
  stale: 'Review required',
}
const tones: Record<Classification, string> = {
  first: 'attention', additional: 'positive', unknown: 'attention', stale: 'danger',
}
const staff = '/api/staff'
const date = (stamp: string) => new Date(stamp.replace(' ', 'T') + 'Z')
const time = (stamp: string) => date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function elapsed(stamp: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - date(stamp).getTime()) / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

function OrderLines({ items, currency }: { items: PendingOrder['items']; currency: string }) {
  return <ul className="cash-lines">{items.map((item, index) => (
    <li key={index}>
      <div><strong>{item.quantity} × {item.name}</strong>
        <span>{money(item.unitPriceMinor, currency)} each</span>
        {item.instructions && <p>{item.instructions}</p>}
      </div>
      <strong>{money(item.unitPriceMinor * item.quantity, currency)}</strong>
    </li>
  ))}</ul>
}

function ActionDialog({ session, currency, busy, onClose, onSettle }: {
  session: Sitting
  currency: string
  busy: boolean
  onClose: () => void
  onSettle: () => void
}) {
  const element = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = element.current
    node?.showModal()
    return () => node?.close()
  }, [])
  return (
    <dialog ref={element} className="cash-confirm" aria-labelledby="settle-heading" onCancel={event => {
      event.preventDefault()
      if (!busy) onClose()
    }}>
      <h2 id="settle-heading">Settle Table {session.tableNumber}?</h2>
      <p>Confirm that you collected <strong>{money(session.confirmedTotalMinor, currency)}</strong> outside this app. Settlement closes this sitting and removes browser access.</p>
      {session.orders.some(order => order.status !== 'served') &&
        <p className="cash-callout attention">This sitting has unfinished kitchen orders. They will stay on the kitchen display after settlement.</p>}
      <div className="cash-actions">
        <button className="cash-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="cash-button destructive" type="button" disabled={busy} onClick={onSettle}>Confirm settlement</button>
      </div>
    </dialog>
  )
}

export function Cashier() {
  const [search] = useSearchParams()
  const tableFilter = search.get('table')
  const [auth, setAuth] = useState<'checking' | 'signed-out' | 'signed-in'>('checking')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [selected, setSelected] = useState<PendingOrder>()
  const [openSession, setOpenSession] = useState<number>()
  const [settlement, setSettlement] = useState<Sitting>()
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now)
  const inFlight = useRef(false)
  const refreshVersion = useRef(0)

  function clearSession() {
    refreshVersion.current++
    setAuth('signed-out')
    setOverview(null)
    setSelected(undefined)
    setOpenSession(undefined)
    setSettlement(undefined)
    setVerified(false)
    setNotice('')
  }

  async function refresh() {
    const version = ++refreshVersion.current
    try {
      const state = await request<Overview>(staff + '/overview')
      if (refreshVersion.current !== version) return
      setOverview(state)
      setAuth('signed-in')
    } catch (error) {
      if (refreshVersion.current !== version) return
      if (error instanceof RequestError && error.status === 401) clearSession()
      else {
        setError('Could not load the cashier workspace. Check your connection.')
        setAuth(value => value === 'checking' ? 'signed-out' : value)
      }
    }
  }

  useEffect(() => {
    void refresh()
    const ticker = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      refreshVersion.current++
      window.clearInterval(ticker)
    }
  }, [])

  const live = useLiveUpdate('/', 'cashier:changed', auth === 'signed-in', () => { void refresh() })

  async function action(path: string, payload: object, onSuccess: () => void, reload = true) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await post(staff + path, payload)
      onSuccess()
    } catch (error) {
      if (error instanceof RequestError && error.status === 401 && path !== '/login') clearSession()
      setError(error instanceof RequestError ? error.message : 'Could not complete the action. Check the current state before retrying.')
    } finally {
      if (reload) await refresh()
      inFlight.current = false
      setBusy(false)
    }
  }

  function review(order: PendingOrder) {
    setSelected(order)
    setVerified(false)
    setError('')
  }

  if (auth !== 'signed-in' || !overview) return <StaffLogin title="Cashier dashboard" checking={auth === 'checking'}
    busy={busy} error={error} login={credential => { void action('/login', { credential }, () => {}) }} />

  const { currency, orders, sessions, tableCount } = overview
  const current = orders.find(order => order.reference === selected?.reference)
  const changed = Boolean(current && selected && current.reviewKey !== selected.reviewKey)
  const selectedSitting = sessions.find(session => session.id === openSession) ??
    sessions.find(session => session.tableNumber === tableFilter)
  const queue = tableFilter ? orders.filter(order => order.tableNumber === tableFilter) : orders
  const bills = sessions.filter(session => session.billRequestedAt)

  return (
    <div className="cashier">
      <header className="cash-header">
        <div className="cash-wrap cash-header-inner">
          <div><Link to="/" className="cash-brand">{overview.restaurant}</Link><h1>Cashier dashboard</h1></div>
          <div className="cash-header-actions">
            <span className={`cash-live ${live ? 'positive' : 'attention'}`} role="status">
              <i aria-hidden="true" />{live ? 'Live updates' : 'Reconnecting'}
            </span>
            <button type="button" className="cash-button" disabled={busy} onClick={() => { void action('/logout', {}, clearSession, false) }}>Sign out</button>
          </div>
        </div>
      </header>
      <main className="cash-wrap">
        <dl className="cash-metrics">
          <div><dt>Pending orders</dt><dd>{orders.length}</dd></div>
          <div><dt>Occupied tables</dt><dd>{sessions.length}</dd></div>
          <div><dt>Available tables</dt><dd>{tableCount - sessions.length}</dd></div>
          <div><dt>Bill requests</dt><dd>{bills.length}</dd></div>
        </dl>
        {error && <p className="cash-message danger" role="alert">{error}</p>}
        {notice && <p className="cash-message positive" role="status">{notice}</p>}
        <div className="cash-queue-layout">
          <section className="cash-panel" aria-labelledby="queue-heading">
            <h2 id="queue-heading">Incoming orders</h2>
            {tableFilter && <p className="cash-empty">Table {tableFilter} · <Link to="/cashier">Show all tables</Link></p>}
            {queue.length ? <ul className="cash-queue">
              {queue.map(order => <li key={order.reference}>
                <button type="button" onClick={() => review(order)} aria-pressed={selected?.reference === order.reference}>
                  <span className="queue-primary"><strong>Table {order.tableNumber}</strong><strong>{money(order.totalMinor, currency)}</strong></span>
                  <span className="queue-meta"><span>{order.reference}</span><span>{time(order.createdAt)} · {order.itemCount} {order.itemCount === 1 ? 'item' : 'items'}</span></span>
                  <span className={`cash-tag ${tones[order.classification]}`}>{labels[order.classification]}</span>
                </button>
              </li>)}
            </ul> : <p className="cash-empty">No pending orders.</p>}
          </section>
          <section className="cash-panel cash-detail" aria-labelledby="order-heading">
            <h2 id="order-heading">Order details</h2>
            {selected && current ? <>
              <div className="cash-detail-title">
                <div><h3>Table {selected.tableNumber}</h3><p>{selected.reference} · {time(selected.createdAt)}</p></div>
                <span className={`cash-tag ${tones[selected.classification]}`}>{labels[selected.classification]}</span>
              </div>
              <OrderLines items={selected.items} currency={currency} />
              <div className="cash-total"><span>Order total</span><strong>{money(selected.totalMinor, currency)}</strong></div>
              {changed ? <div className="cash-callout attention">
                <p>The sitting or browser authorization changed while this order was open.</p>
                <button type="button" className="cash-button" onClick={() => review(current)}>Review updated request</button>
              </div> : selected.classification === 'first' || selected.classification === 'unknown' ? (
                <label className="cash-callout attention verify-order">
                  <input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />
                  {selected.classification === 'first'
                    ? `I verified in person that this order belongs to the customers seated at Table ${selected.tableNumber}.`
                    : `I verified in person that this customer belongs to the group currently seated at Table ${selected.tableNumber}.`}
                </label>
              ) : selected.classification === 'stale' ? (
                <p className="cash-callout danger">This request cannot be approved under its original sitting or browser authorization. Reject it to resolve it.</p>
              ) : <p className="cash-callout positive">This browser is authorized for the current sitting.</p>}
              <div className="cash-actions">
                <button type="button" className="cash-button destructive-outline" disabled={busy} onClick={() => {
                  void action(`/orders/${selected.reference}/reject`, {}, () => {
                    setSelected(undefined)
                    setNotice('Order rejected.')
                  })
                }}>Reject order</button>
                <button type="button" className="cash-button primary" disabled={busy || changed || selected.classification === 'stale' ||
                  (selected.classification !== 'additional' && !verified)} onClick={() => {
                  void action(`/orders/${selected.reference}/approve`, { reviewKey: selected.reviewKey, verified }, () => {
                    setSelected(undefined)
                    setNotice('Order approved.')
                  })
                }}>Approve order</button>
              </div>
            </> : <p className="cash-empty">{selected ? 'This request has already been resolved.' : 'Select an order to review its items and verification status.'}</p>}
          </section>
        </div>
        <div className="cash-session-layout">
          <section className="cash-panel" aria-labelledby="session-heading">
            <h2 id="session-heading">Active table sessions</h2>
            {sessions.length ? <ul className="cash-tables">
              {sessions.map(session => <li key={session.id}>
                <button type="button" aria-pressed={openSession === session.id} onClick={() => setOpenSession(session.id)}>
                  <strong>Table {session.tableNumber}</strong>
                  <span>{elapsed(session.openedAt, now)} · {session.browsers.length} {session.browsers.length === 1 ? 'browser' : 'browsers'}</span>
                  <strong>{money(session.confirmedTotalMinor, currency)}</strong>
                  <span className={`cash-tag ${session.billRequestedAt ? 'attention' : 'positive'}`}>{session.billRequestedAt ? 'Bill requested' : 'Ordering open'}</span>
                </button>
              </li>)}
            </ul> : <p className="cash-empty">No active sessions.</p>}
          </section>
          <section className="cash-panel bills-panel" aria-labelledby="bills-heading">
            <h2 id="bills-heading">Bill requests</h2>
            {bills.length ? <ul className="cash-tables">{bills.map(session => <li key={session.id}>
              <button type="button" onClick={() => setOpenSession(session.id)}>
                <strong>Table {session.tableNumber}</strong>
                <span>{time(session.billRequestedAt!)}</span>
                <strong>{money(session.confirmedTotalMinor, currency)}</strong>
                <span>{session.unresolvedCount ? `${session.unresolvedCount} unresolved` : 'Ready to settle'}</span>
              </button>
            </li>)}</ul> : <p className="cash-empty">No bill requests.</p>}
          </section>
        </div>
        {selectedSitting && <section className="cash-panel sitting-detail" aria-label="Selected table session">
          <div className="cash-detail-title">
            <div><h2>Table {selectedSitting.tableNumber} session</h2><p>Started {time(selectedSitting.openedAt)} · {elapsed(selectedSitting.openedAt, now)}</p></div>
            <span className={`cash-tag ${selectedSitting.billRequestedAt ? 'attention' : 'positive'}`}>{selectedSitting.billRequestedAt ? 'Bill requested' : 'Ordering open'}</span>
          </div>
          <div className="cash-session-columns">
            <div>
              <h3>Orders</h3>
              <div className="cash-total"><span>Confirmed bill</span><strong>{money(selectedSitting.confirmedTotalMinor, currency)}</strong></div>
              {[...selectedSitting.orders, ...selectedSitting.pending].map(order => (
                <details key={order.reference}>
                  <summary>{order.reference} · {preparationLabel(order.status)} · {money(order.totalMinor, currency)}</summary>
                  <OrderLines items={order.items} currency={currency} />
                </details>
              ))}
              <div className="cash-total"><span>Pending authorized</span><strong>{money(selectedSitting.pendingTotalMinor, currency)}</strong></div>
            </div>
            <div>
              <h3>Authorized browsers ({selectedSitting.browsers.length})</h3>
              <ul className="cash-browsers">{selectedSitting.browsers.map(browser => (
                <li key={browser.id}>
                  <span>Browser {browser.id} · {time(browser.authorizedAt)}</span>
                  <button type="button" className="cash-button destructive-outline" disabled={busy} onClick={() => {
                    void action(`/sessions/${selectedSitting.id}/browsers/${browser.id}/revoke`, {}, () => setNotice('Browser access revoked.'))
                  }}>Revoke access</button>
                </li>
              ))}</ul>
              {selectedSitting.billRequestedAt && <>
                {selectedSitting.unresolvedCount > 0 && <p className="cash-callout attention">Resolve {selectedSitting.unresolvedCount} pending {selectedSitting.unresolvedCount === 1 ? 'request' : 'requests'} before settling.</p>}
                <div className="cash-actions">
                  <button type="button" className="cash-button" disabled={busy} onClick={() => {
                    void action(`/sessions/${selectedSitting.id}/reopen`, { billRevision: selectedSitting.billRevision }, () => setNotice('Ordering reopened.'))
                  }}>Reopen ordering</button>
                  <button type="button" className="cash-button primary" disabled={busy || selectedSitting.unresolvedCount > 0} onClick={() => setSettlement(selectedSitting)}>Settle bill</button>
                </div>
              </>}
            </div>
          </div>
        </section>}
      </main>
      {settlement && <ActionDialog session={settlement} currency={currency} busy={busy} onClose={() => setSettlement(undefined)} onSettle={() => {
        setSettlement(undefined)
        void action(`/sessions/${settlement.id}/settle`, {
          totalMinor: settlement.confirmedTotalMinor, billRevision: settlement.billRevision, confirmed: true,
        }, () => {
          setOpenSession(undefined)
          setNotice(`Table ${settlement.tableNumber} settled and available.`)
        })
      }} />}
    </div>
  )
}
