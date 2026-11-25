import { useState } from 'react'
import { Link } from 'react-router-dom'
import './cashier.css'

export function StaffLogin({ title, checking, busy, error, login }: {
  title: string
  checking: boolean
  busy: boolean
  error: string
  login: (credential: string) => void
}) {
  const [credential, setCredential] = useState('')
  return (
    <main className="cashier cash-login">
      <Link to="/">Demo launcher</Link>
      <h1>{title}</h1>
      {checking ? <p role="status">Checking staff access…</p> : (
        <form onSubmit={event => {
          event.preventDefault()
          login(credential)
        }}>
          <label htmlFor="staff-password">Staff password</label>
          <input id="staff-password" type="password" autoComplete="current-password" required maxLength={512} value={credential}
            onChange={event => setCredential(event.target.value)} />
          <button className="cash-button primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}
      {error && <p className="cash-message danger" role="alert">{error}</p>}
    </main>
  )
}
