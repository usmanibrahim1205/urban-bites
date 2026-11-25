import { useEffect, useState } from 'react'
import { Link, Outlet, Route, Routes } from 'react-router-dom'
import { CustomerRoute } from './customer/OrderMenu'
import { Cashier } from './staff/Cashier'
import { Kitchen } from './staff/Kitchen'
import { TableManagement } from './staff/TableManagement'

interface PublicTable {
  number: string
  tableCode: string
}

async function readApi<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal })
  if (response.status === 400 || response.status === 404) throw new Error('Table code is invalid or unknown.')
  if (!response.ok) throw new Error('The demo server is unavailable.')
  return response.json()
}

const staffRoutes = [
  { path: '/cashier', label: 'Cashier dashboard' },
  { path: '/kitchen', label: 'Kitchen display' },
  { path: '/tables', label: 'Table management' },
]

function useApi<T>(path: string) {
  const [result, setResult] = useState<{ data?: T; error?: string }>({})
  useEffect(() => {
    const request = new AbortController()
    readApi<T>(path, request.signal).then(
      data => setResult({ data }),
      error => {
        if (!request.signal.aborted) {
          setResult({ error: error instanceof Error ? error.message : 'The demo server is unavailable.' })
        }
      },
    )
    return () => request.abort()
  }, [path])
  return result
}

function Launcher() {
  const { data, error } = useApi<{ restaurant: string; tables: PublicTable[] }>('/api/demo/tables')
  return (
    <>
      <header className="border-b border-stone-300 pb-7">
        <p className="mb-3 font-semibold text-orange-800">Demo launcher</p>
        <h1 className="font-serif text-5xl font-medium sm:text-6xl">{data?.restaurant ?? 'Restaurant ordering'}</h1>
      </header>
      <section aria-labelledby="customer-heading" className="py-7">
        <h2 id="customer-heading" className="mb-4 text-xl font-semibold">Public customer ordering</h2>
        {error && <p role="alert">{error}</p>}
        {!data && !error && <p role="status">Loading tables…</p>}
        {data?.tables.length === 0 && <p>No demo tables are available. Run <code>npm run db:seed</code>.</p>}
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {data?.tables.map(table => (
            <li key={table.tableCode}>
              <Link className="table-link" to={`/menu/${table.tableCode}`}>Table {table.number}</Link>
            </li>
          ))}
        </ul>
      </section>
      <nav aria-labelledby="staff-heading" className="border-t border-stone-300 pt-7">
        <h2 id="staff-heading" className="mb-4 text-xl font-semibold">Staff sign-in required</h2>
        <ul className="space-y-3">
          {staffRoutes.map(({ path, label }) => <li key={path}><Link to={path}>{label}</Link></li>)}
        </ul>
      </nav>
    </>
  )
}

function Placeholder({ title, children = 'This interface is reserved for a later phase.' }: {
  title: string
  children?: string
}) {
  return (
    <>
      <Link to="/">Demo launcher</Link>
      <h1 className="mt-7 font-serif text-4xl">{title}</h1>
      <p className="mt-4" role="status">{children}</p>
    </>
  )
}

export function App() {
  return (
    <Routes>
      <Route path="/menu/:tableCode" element={<CustomerRoute />} />
      <Route path="/cashier" element={<Cashier />} />
      <Route path="/kitchen" element={<Kitchen />} />
      <Route path="/tables" element={<TableManagement />} />
      <Route element={<main className="mx-auto max-w-3xl px-6 py-12 sm:py-16"><Outlet /></main>}>
        <Route path="/" element={<Launcher />} />
        <Route path="*" element={<Placeholder title="Page not found">Choose an interface from the demo launcher.</Placeholder>} />
      </Route>
    </Routes>
  )
}
