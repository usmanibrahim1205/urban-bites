import { useRef, useState } from 'react'
import { money, post, preparationLabel } from './order-state'
import type { SessionView } from './order-state'

export function TableOrder({ session, currency, ordersPath, refresh }: {
  session: SessionView
  currency: string
  ordersPath: string
  refresh: () => Promise<void>
}) {
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const pending = useRef(false)

  async function bill() {
    if (pending.current) return
    pending.current = true
    setSending(true)
    setError('')
    try {
      await post(ordersPath + '/bill', { sessionKey: session.key })
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not request the bill. Please try again.')
      await refresh().catch(() => {})
    } finally {
      pending.current = false
      setSending(false)
    }
  }

  return (
    <section className="customer-session" aria-labelledby="table-order-heading">
      <h2 id="table-order-heading">Your table order</h2>
      <div className="session-amount"><strong>Confirmed bill</strong><strong>{money(session.confirmedTotalMinor, currency)}</strong></div>
      {session.pending.length > 0 && <div className="session-amount"><span>Your pending requests</span><span>{money(session.pendingTotalMinor, currency)}</span></div>}
      {session.orders.length > 0 && <details>
        <summary>Confirmed orders ({session.orders.length})</summary>
        {session.orders.map(order => (
          <div className="session-history" key={order.reference}>
            <div className="session-amount"><strong>{order.reference}</strong><strong>{money(order.totalMinor, currency)}</strong></div>
            <p>{preparationLabel(order.status)}</p>
            <ul>{order.items.map((item, index) => <li key={index}>{item.quantity} × {item.name}</li>)}</ul>
          </div>
        ))}
      </details>}
      {session.pending.length > 0 && <details>
        <summary>Pending requests ({session.pending.length})</summary>
        {session.pending.map(order => (
          <div className="session-history" key={order.reference}>
            <div className="session-amount"><strong>{order.reference}</strong><strong>{money(order.totalMinor, currency)}</strong></div>
            <ul>{order.items.map((item, index) => <li key={index}>{item.quantity} × {item.name}</li>)}</ul>
          </div>
        ))}
      </details>}
      {session.billRequested
        ? <p className="bill-paused" role="status">Bill requested. Ordering is paused.</p>
        : <button type="button" className="order-secondary" disabled={sending} onClick={() => { void bill() }}>{sending ? 'Requesting…' : 'Request bill'}</button>}
      {error && <p className="order-error" role="alert">{error}</p>}
    </section>
  )
}
