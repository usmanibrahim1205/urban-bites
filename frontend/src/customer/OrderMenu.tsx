import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import {
  lineKey, money, newAttempt, post, preparationLabel, readCart, request, RequestError, saveCart,
} from './order-state'
import type { CartLine, CartState, Menu, MenuItem, OrderReceipt, SessionView } from './order-state'
import { TableOrder } from './TableOrder'
import { useLiveUpdate } from '../live'
import './customer.css'

type IconName = 'bag' | 'plus' | 'minus' | 'close' | 'check' | 'table' | 'cutlery'

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths = {
    bag: 'M5 8h14l1 13H4L5 8Zm4 1V6a3 3 0 0 1 6 0v3',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    close: 'm6 6 12 12M18 6 6 18',
    check: 'm5 12 5 5L20 7',
    table: 'M3 10h18M5 10v9m14-9v9M6 6h12l3 4H3l3-4Z',
    cutlery: 'M5 3v6a3 3 0 0 0 6 0V3M8 3v18M18 21V3c-3 2-4 5-4 9h4',
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>
}

function FoodImage({ slug, priority = false }: { slug: string; priority?: boolean }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="food-image">
      {failed
        ? <span className="photo-fallback"><Icon name="cutlery" size={30} /></span>
        : <img alt="" src={`/menu-images/${encodeURIComponent(slug)}.jpg`} loading={priority ? 'eager' : 'lazy'} onError={() => setFailed(true)} />}
    </div>
  )
}

function Stepper({ label, quantity, onChange, disabled }: {
  label: string
  quantity: number
  onChange: (quantity: number) => void
  disabled?: boolean
}) {
  return (
    <div className="stepper" role="group" aria-label={`Quantity for ${label}`}>
      <button type="button" aria-label={`Decrease ${label} quantity`} disabled={disabled || quantity <= 1} onClick={() => onChange(quantity - 1)}><Icon name="minus" size={16} /></button>
      <span aria-live="polite">{quantity}</span>
      <button type="button" aria-label={`Increase ${label} quantity`} disabled={disabled || quantity >= 20} onClick={() => onChange(quantity + 1)}><Icon name="plus" size={16} /></button>
    </div>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return (
    <dialog ref={dialog} className="order-sheet" aria-labelledby="sheet-title" onCancel={event => {
      event.preventDefault()
      onClose()
    }}>
      <div className="sheet-heading">
        <h2 id="sheet-title">{title}</h2>
        <button type="button" className="icon-button close-sheet" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
      {children}
    </dialog>
  )
}

function ItemDetail({ item, currency, onClose, onAdd }: {
  item: MenuItem
  currency: string
  onClose: () => void
  onAdd: (line: CartLine) => boolean
}) {
  const [quantity, setQuantity] = useState(1)
  const [instructions, setInstructions] = useState('')
  const [message, setMessage] = useState('')
  return (
    <Sheet title={item.name} onClose={onClose}>
      <FoodImage slug={item.slug} priority />
      <div className="item-detail">
        <p className="detail-description">{item.description}</p>
        <p className="detail-price">{money(item.priceMinor, currency)}</p>
        <label className="instructions-label" htmlFor="item-instructions">Special instructions <span>Optional</span></label>
        <textarea id="item-instructions" placeholder="Anything we should know?" maxLength={240} rows={2} value={instructions} onChange={event => setInstructions(event.target.value)} />
        {message && <p className="order-error" role="alert">{message}</p>}
        <div className="detail-actions">
          <Stepper label={item.name} quantity={quantity} onChange={setQuantity} />
          <button className="order-primary" type="button" onClick={() => {
            if (onAdd({ slug: item.slug, quantity, instructions: instructions.trim() })) onClose()
            else setMessage('This cart has reached its limit. Adjust quantities in your cart.')
          }}>
            Add to cart <span>{money(item.priceMinor * quantity, currency)}</span>
          </button>
        </div>
      </div>
    </Sheet>
  )
}

const receiptCopy = {
  pending: ['Order sent', 'Awaiting confirmation', 'Your order has been sent to the restaurant for confirmation.'],
  confirmed: ['Order confirmed', 'Confirmed', 'The restaurant has approved your order.'],
  preparing: ['Your order is being prepared', 'Preparing', 'The kitchen has started preparing your order.'],
  ready: ['Your order is ready', 'Ready', 'Your order is ready to be served.'],
  served: ['Order served', 'Served', 'The restaurant has marked your order as served.'],
  rejected: ['Order declined', 'Rejected', 'The restaurant could not accept this request. Please speak with the cashier if you need help.'],
  closed: ['Session closed', 'Session closed', 'The cashier has settled this table’s bill.'],
}

function receiptState(status: string): keyof typeof receiptCopy {
  if (status === 'rejected') return 'rejected'
  if (status === 'session-closed') return 'closed'
  if (status === 'preparing' || status === 'ready' || status === 'served') return status
  return status === 'pending' ? 'pending' : 'confirmed'
}

function Receipt({ order, onMenu, session, children }: {
  order: OrderReceipt
  onMenu: () => void
  session: SessionView | null
  children: ReactNode
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  const state = receiptState(order.status)
  const [title, status, description] = receiptCopy[state]
  return (
    <main className="customer-wrap receipt">
      <div className={`receipt-check ${state}`}><Icon name={state === 'rejected' ? 'close' : 'check'} size={28} /></div>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      <p>{description}</p>
      <div className="receipt-details">
        <div className={`receipt-status ${state}`}><span role="status">{status}</span><span>Table {order.tableNumber}</span></div>
        <p className="order-reference">Order reference <strong>{order.reference}</strong></p>
        {state === 'closed' && order.preparationStatus && <p className="order-reference">Order status <strong>{preparationLabel(order.preparationStatus)}</strong></p>}
        <ul className="receipt-lines">
          {order.items.map((item, index) => (
            <li key={index}>
              <div><strong>{item.quantity} × {item.name}</strong>{item.instructions && <p>{item.instructions}</p>}</div>
              <span>{money(item.unitPriceMinor * item.quantity, order.currency)}</span>
            </li>
          ))}
        </ul>
        <div className="cart-total"><strong>Total</strong><strong>{money(order.totalMinor, order.currency)}</strong></div>
      </div>
      {children}
      <button type="button" className="order-secondary" onClick={onMenu}>{session && !session.billRequested ? 'Continue ordering' : 'Back to menu'}</button>
    </main>
  )
}

function CustomerMenu({ tableCode }: { tableCode: string }) {
  const tablePath = `/api/tables/${encodeURIComponent(tableCode)}`
  const ordersPath = tablePath + '/orders'
  const [menu, setMenu] = useState<Menu>()
  const [table, setTable] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [cart, setCart] = useState(() => readCart(tableCode))
  const cartRef = useRef(cart)
  const [order, setOrder] = useState<OrderReceipt | null>(null)
  const [session, setSession] = useState<SessionView | null>(null)
  const [sessionAvailable, setSessionAvailable] = useState(true)
  const [viewOrder, setViewOrder] = useState(false)
  const refreshVersion = useRef(0)
  const [activeCategory, setActiveCategory] = useState('')
  const [item, setItem] = useState<MenuItem>()
  const [cartOpen, setCartOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [sendError, setSendError] = useState('')
  const [announcement, setAnnouncement] = useState('')

  function updateCart(next: CartState) {
    cartRef.current = next
    saveCart(tableCode, next)
    setCart(next)
  }

  async function refresh() {
    const version = ++refreshVersion.current
    try {
      const [{ order: latest }, { session: current }] = await Promise.all([
        request<{ order: OrderReceipt | null }>(ordersPath + '/latest'),
        request<{ session: SessionView | null }>(ordersPath + '/session'),
      ])
      if (version !== refreshVersion.current) return
      setSession(current)
      setSessionAvailable(true)
      if (!latest || latest.idempotencyKey !== cartRef.current.attempt) setOrder(latest)
    } catch (error) {
      if (version === refreshVersion.current) setSessionAvailable(false)
      throw error
    }
  }

  const live = useLiveUpdate('/customer', 'customer:changed', Boolean(menu), () => { void refresh().catch(() => {}) }, event => {
    if (event?.kind === 'browser-revoked' || event?.kind === 'settled') setSessionAvailable(false)
  })

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    async function load() {
      const { table } = await request<{ table: { number: string } }>(tablePath, { signal })
      const [catalog, receipt] = await Promise.all([
        request<Menu>('/api/menu', { signal }),
        request<{ order: OrderReceipt | null }>(ordersPath + '/latest', { signal }),
      ])
      const { session } = await request<{ session: SessionView | null }>(ordersPath + '/session', { signal })
      if (signal.aborted) return
      const latest = receipt.order
      const current = cartRef.current
      if (latest && current.attempt === latest.idempotencyKey) {
        const cleared = { ...current, lines: [], attempt: undefined }
        cartRef.current = cleared
        saveCart(tableCode, cleared)
        setCart(cleared)
      }
      setOrder(latest)
      setSession(session)
      setSessionAvailable(true)
      setMenu(catalog)
      setTable(table.number)
      setActiveCategory(catalog.categories[0]?.slug ?? '')
    }
    load().catch(error => {
      if (!signal.aborted) {
        const invalid = error instanceof RequestError && (error.status === 400 || error.status === 404)
        setLoadError(invalid ? 'We couldn’t find this table. Scan the QR code on your table again.' : 'We couldn’t load the menu. Check your connection and try again.')
      }
    })
    return () => controller.abort()
  }, [tableCode, tablePath, ordersPath, loadAttempt])

  if (!menu) {
    return (
      <main className="customer customer-state">
        <h1>Customer ordering</h1>
        {loadError ? <>
          <p role="alert">{loadError}</p>
          <button type="button" className="order-secondary" onClick={() => {
            setLoadError('')
            setLoadAttempt(value => value + 1)
          }}>Try again</button>
        </> : <p role="status">Loading the menu…</p>}
      </main>
    )
  }

  const catalog = new Map(menu.categories.flatMap(category => category.items).map(entry => [entry.slug, entry]))
  const count = cart.lines.reduce((sum, line) => sum + line.quantity, 0)
  const total = cart.lines.reduce((sum, line) => sum + (catalog.get(line.slug)?.priceMinor ?? 0) * line.quantity, 0)
  const hasUnavailable = cart.lines.some(line => !catalog.get(line.slug)?.available)
  const showReceipt = order && (viewOrder || (order.reference !== cart.dismissed && !count))
  const orderingLocked = Boolean(session?.billRequested)

  function addLine(line: CartLine) {
    if (cart.attempt || orderingLocked) return false
    const existing = cart.lines.find(entry => lineKey(entry) === lineKey(line))
    if (existing ? existing.quantity + line.quantity > 20 : cart.lines.length >= 30) return false
    const lines = existing
      ? cart.lines.map(entry => entry === existing ? { ...entry, quantity: entry.quantity + line.quantity } : entry)
      : [...cart.lines, line]
    updateCart({ ...cart, lines })
    setAnnouncement(`${catalog.get(line.slug)?.name ?? 'Item'} added. ${count + line.quantity} in your cart.`)
    return true
  }

  function editLine(target: CartLine, quantity: number) {
    if (cart.attempt) return
    updateCart({
      ...cart,
      lines: cart.lines.flatMap(line => line !== target ? [line] : quantity ? [{ ...line, quantity }] : []),
    })
    setSendError('')
  }

  async function submit() {
    const current = cartRef.current
    if (sendingRef.current || !sessionAvailable || !current.lines.length || ((hasUnavailable || orderingLocked) && !current.attempt)) return
    sendingRef.current = true
    setSending(true)
    setSendError('')
    const idempotencyKey = current.attempt ?? newAttempt()
    updateCart({ ...current, attempt: idempotencyKey })
    try {
      const { order: saved } = await post<{ order: OrderReceipt }>(ordersPath, {
        idempotencyKey, items: current.lines, sessionKey: session?.key,
      })
      updateCart({ lines: [] })
      setOrder(saved)
      setCartOpen(false)
      await refresh().catch(() => {})
      window.scrollTo(0, 0)
    } catch (error) {
      if (error instanceof RequestError && error.status < 500) {
        updateCart({ ...current, attempt: undefined })
        setSendError(error.message)
        void refresh().catch(() => {})
      } else {
        setSendError('We couldn’t check whether your order was sent. Retry to check safely.')
      }
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  return (
    <div className="customer">
      <header className="customer-header">
        <div className="customer-wrap header-inner">
          <div className="restaurant-brand"><span className="brand-mark"><Icon name="cutlery" /></span>{menu.restaurant}</div>
          <span className="table-indicator"><Icon name="table" size={17} /> Table {table}</span>
        </div>
      </header>
      {(!live || !sessionAvailable) && <p className="customer-wrap bill-paused" role="status">
        {sessionAvailable ? 'Live updates are reconnecting.' : 'Checking table access. Please wait before sending orders.'}
      </p>}
      {showReceipt ? <Receipt order={order} session={sessionAvailable ? session : null} onMenu={() => {
        setViewOrder(false)
        updateCart({ ...cart, dismissed: order.reference })
      }}>
        {sessionAvailable && session && <TableOrder key={session.key} session={session} currency={menu.currency} ordersPath={ordersPath} refresh={refresh} />}
      </Receipt> : (
        <main>
          <div className="customer-wrap">
            <div className="menu-hero">
              <div className="menu-intro">
                <h1>Our menu</h1>
                <p>Explore the menu and order right from your table.</p>
                {order && <button type="button" className="previous-order" onClick={() => {
                  setViewOrder(true)
                  window.scrollTo(0, 0)
                }}>{sessionAvailable && session ? 'View table order' : 'View your last order'}</button>}
                {orderingLocked && <p className="bill-paused" role="status">Bill requested. Ordering is paused.</p>}
              </div>
              <img src="/menu-images/hero.jpg" alt="" />
            </div>
          </div>
          <div className="category-bar">
            <nav aria-label="Menu categories" className="customer-wrap category-nav">
              {menu.categories.map(category => (
                <a key={category.slug} href={`#menu-${category.slug}`} className={activeCategory === category.slug ? 'active' : ''}
                  aria-current={activeCategory === category.slug ? 'location' : undefined}
                  onClick={event => {
                    const section = document.getElementById('menu-' + category.slug)
                    if (section) {
                      event.preventDefault()
                      section.scrollIntoView({ block: 'start' })
                    }
                    setActiveCategory(category.slug)
                  }}>
                  {category.name}
                </a>
              ))}
            </nav>
          </div>
          <div className="customer-wrap menu-content">
            {menu.categories.map(category => (
              <section id={`menu-${category.slug}`} key={category.slug} className="menu-category" aria-labelledby={`heading-${category.slug}`}>
                <h2 id={`heading-${category.slug}`}>{category.name}</h2>
                <ul className="menu-grid">
                  {category.items.map(entry => (
                    <li className="menu-item" key={entry.slug}>
                      <FoodImage slug={entry.slug} />
                      <div className="menu-item-copy">
                        <h3>{entry.available && !cart.attempt && !orderingLocked
                          ? <button type="button" onClick={() => setItem(entry)}>{entry.name}</button>
                          : entry.name}</h3>
                        <p>{entry.description}</p>
                        <div className="menu-item-bottom">
                          <span className="menu-price">{money(entry.priceMinor, menu.currency)}</span>
                          {entry.available
                            ? <button type="button" className="icon-button item-add" disabled={Boolean(cart.attempt) || orderingLocked} aria-label={`Add ${entry.name}`} onClick={() => setItem(entry)}><Icon name="plus" size={19} /></button>
                            : <span className="sold-out">Unavailable</span>}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </main>
      )}
      <p className="sr-only" role="status">{announcement}</p>
      {count > 0 && !showReceipt && <div className="sticky-cart">
        <button type="button" className="order-primary" onClick={() => setCartOpen(true)}>
          <span><Icon name="bag" /> View cart <span className="cart-count">{count}</span></span>
          <strong>{money(total, menu.currency)}</strong>
        </button>
      </div>}
      {item && <ItemDetail key={item.slug} item={item} currency={menu.currency} onClose={() => setItem(undefined)} onAdd={addLine} />}
      {cartOpen && <Sheet title="Your cart" onClose={() => { if (!sending) setCartOpen(false) }}>
        <div className="cart-content">
          {!count && <p>Your cart is empty.</p>}
          <ul className="cart-lines">
            {cart.lines.map(line => {
              const entry = catalog.get(line.slug)
              const name = entry?.name ?? 'Menu item'
              return (
                <li key={lineKey(line)}>
                  <div className="cart-line-heading">
                    <div><h3>{name}</h3><p>{entry ? `${money(entry.priceMinor, menu.currency)} each` : 'Unavailable'}</p></div>
                    {entry && <strong>{money(entry.priceMinor * line.quantity, menu.currency)}</strong>}
                  </div>
                  {line.instructions && <p className="line-note">{line.instructions}</p>}
                  {entry && !entry.available && <p className="order-error">This item is unavailable.</p>}
                  <div className="cart-line-controls">
                    <Stepper label={name} quantity={line.quantity} onChange={quantity => editLine(line, quantity)} disabled={Boolean(cart.attempt)} />
                    <button type="button" className="remove-line" aria-label={`Remove ${name}`} disabled={Boolean(cart.attempt)} onClick={() => editLine(line, 0)}>Remove</button>
                  </div>
                </li>
              )
            })}
          </ul>
          {count > 0 && <>
            <div className="cart-total"><strong>Estimated total</strong><strong>{money(total, menu.currency)}</strong></div>
            {sendError && <p className="order-error" role="alert">{sendError}</p>}
            {hasUnavailable && !cart.attempt && <p className="order-error">Remove unavailable items before sending.</p>}
            {orderingLocked && <p className="bill-paused">Ordering is paused while the bill is being handled.</p>}
            <button type="button" className="order-primary send-order" disabled={sending || !sessionAvailable || ((hasUnavailable || orderingLocked) && !cart.attempt)} onClick={() => { void submit() }}>
              {sending ? 'Sending…' : cart.attempt ? 'Retry order' : 'Send order'}
            </button>
          </>}
        </div>
      </Sheet>}
    </div>
  )
}

export function CustomerRoute() {
  const { tableCode = '' } = useParams()
  return <CustomerMenu key={tableCode} tableCode={tableCode} />
}
