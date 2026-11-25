import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { post, request, RequestError } from '../customer/order-state'
import { useLiveUpdate } from '../live'
import { StaffLogin } from './StaffLogin'
import './kitchen.css'

type Stage = 'approved' | 'preparing' | 'ready'
interface Ticket {
  reference: string
  tableNumber: string
  status: Stage
  approvedAt: string
  sittingClosedAt: string | null
  additional: boolean
  items: { name: string; quantity: number; instructions: string }[]
}
interface Board { restaurant: string; tickets: Ticket[] }

const lanes = [
  { stage: 'approved', title: 'New orders', action: 'start', button: 'Start preparing' },
  { stage: 'preparing', title: 'Preparing', action: 'ready', button: 'Mark ready' },
  { stage: 'ready', title: 'Ready', action: 'serve', button: 'Mark served' },
] as const
const loadError = 'Could not load the kitchen display. Check your connection.'

function elapsed(approvedAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(approvedAt.replace(' ', 'T') + 'Z')) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function Kitchen() {
  const [board, setBoard] = useState<Board | null>(null)
  const [initial, setInitial] = useState(true)
  const [busy, setBusy] = useState(false)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  const [sound, setSound] = useState(false)
  const audio = useRef<AudioContext | null>(null)
  const known = useRef(new Set<string>())
  const sequence = useRef(0)
  const authBusy = useRef(false)
  const actions = useRef(new Set<string>())

  async function refresh() {
    const version = ++sequence.current
    try {
      const state = await request<Board>('/api/staff/kitchen')
      if (version !== sequence.current) return
      for (const ticket of state.tickets) known.current.add(ticket.reference)
      setBoard(state)
      setError(message => message === loadError ? '' : message)
    } catch (cause) {
      if (version !== sequence.current) return
      if (cause instanceof RequestError && cause.status === 401) {
        setBoard(null)
        setSound(false)
      } else setError(loadError)
    } finally {
      if (version === sequence.current) setInitial(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      sequence.current++
      window.clearInterval(timer)
      if (audio.current) void audio.current.close()
    }
  }, [])

  async function toggleSound() {
    if (sound) {
      setSound(false)
      return
    }
    try {
      const context = audio.current ??= new AudioContext()
      await context.resume()
      setSound(context.state === 'running')
    } catch {
      setError('Sound is unavailable. New tickets will still be visible.')
    }
  }

  const live = useLiveUpdate('/', 'kitchen:changed', Boolean(board), () => { void refresh() }, event => {
    if (event?.kind !== 'approved' || typeof event.reference !== 'string' || known.current.has(event.reference)) return
    known.current.add(event.reference)
    const context = audio.current
    if (!sound || context?.state !== 'running') return
    const tone = context.createOscillator()
    const volume = context.createGain()
    const start = context.currentTime
    tone.frequency.value = 660
    volume.gain.setValueAtTime(0.0001, start)
    volume.gain.exponentialRampToValueAtTime(0.08, start + 0.025)
    volume.gain.exponentialRampToValueAtTime(0.0001, start + 0.26)
    tone.connect(volume).connect(context.destination)
    tone.start(start)
    tone.stop(start + 0.27)
  })

  async function authenticate(action: 'login' | 'logout', credential?: string) {
    if (authBusy.current) return
    authBusy.current = true
    setBusy(true)
    setError('')
    try {
      await post('/api/staff/' + action, { credential })
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff access could not be updated.')
    } finally {
      authBusy.current = false
      setBusy(false)
    }
  }

  async function advance(reference: string, action: typeof lanes[number]['action']) {
    if (actions.current.has(reference)) return
    actions.current.add(reference)
    setWorking(new Set(actions.current))
    setError('')
    try {
      await post(`/api/staff/kitchen/orders/${encodeURIComponent(reference)}/${action}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the ticket.')
    } finally {
      await refresh()
      actions.current.delete(reference)
      setWorking(new Set(actions.current))
    }
  }

  if (!board) return <StaffLogin title="Kitchen display" checking={initial} busy={busy} error={error}
    login={credential => { void authenticate('login', credential) }} />

  return (
    <div className="kitchen">
      <header className="kitchen-header">
        <div className="kitchen-heading">
          <Link to="/">{board.restaurant}</Link>
          <h1>Kitchen display</h1>
        </div>
        <div className="kitchen-tools">
          <span className={live ? 'kitchen-live' : 'kitchen-offline'} role="status"><i aria-hidden="true" />{live ? 'Live updates' : 'Reconnecting'}</span>
          <time dateTime={new Date(now).toISOString()}>{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          <button type="button" aria-pressed={sound} onClick={() => { void toggleSound() }}>{sound ? 'Mute sound' : 'Enable sound'}</button>
          <button type="button" disabled={busy} onClick={() => { void authenticate('logout') }}>Sign out</button>
        </div>
      </header>
      {error && <p className="kitchen-error" role="alert">{error}</p>}
      <main className="kitchen-board" aria-label="Kitchen order board">
        {lanes.map(lane => {
          const tickets = board.tickets.filter(ticket => ticket.status === lane.stage)
          return (
            <section className={`kitchen-lane ${lane.stage}`} aria-labelledby={`lane-${lane.stage}`} key={lane.stage}>
              <h2 id={`lane-${lane.stage}`}>{lane.title} <span>{tickets.length}</span></h2>
              <ul className="kitchen-tickets">
                {tickets.map(ticket => (
                  <li key={ticket.reference}>
                    <article className="kitchen-ticket" aria-label={`Ticket ${ticket.reference}`}>
                      <header>
                        <div><h3>Table {ticket.tableNumber}</h3><p className="ticket-reference">{ticket.reference}</p></div>
                        <time className="ticket-age" dateTime={ticket.approvedAt.replace(' ', 'T') + 'Z'} aria-label="Time since approval">{elapsed(ticket.approvedAt, now)}</time>
                      </header>
                      <div className="ticket-flags">
                        {ticket.sittingClosedAt && <span className="ticket-closed">Sitting closed</span>}
                        {ticket.additional && <span>Additional order</span>}
                      </div>
                      <ul className="ticket-items">
                        {ticket.items.map((item, index) => (
                          <li key={index}><strong><span>{item.quantity} ×</span> {item.name}</strong>
                            {item.instructions && <p>{item.instructions}</p>}
                          </li>
                        ))}
                      </ul>
                      <button type="button" disabled={working.has(ticket.reference)} onClick={() => { void advance(ticket.reference, lane.action) }}>{lane.button}</button>
                    </article>
                  </li>
                ))}
              </ul>
              {!tickets.length && <p className="kitchen-empty">No tickets</p>}
            </section>
          )
        })}
      </main>
    </div>
  )
}
