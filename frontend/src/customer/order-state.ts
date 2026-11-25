export interface MenuItem {
  slug: string
  name: string
  description: string
  priceMinor: number
  available: boolean
}

export interface Menu {
  restaurant: string
  currency: string
  categories: { slug: string; name: string; items: MenuItem[] }[]
}

export interface CartLine {
  slug: string
  quantity: number
  instructions: string
}

export interface OrderReceipt {
  reference: string
  idempotencyKey: string
  status: string
  preparationStatus?: string
  tableNumber: string
  currency: string
  totalMinor: number
  items: { name: string; unitPriceMinor: number; quantity: number; instructions: string }[]
}

export function preparationLabel(status: string) {
  switch (status) {
    case 'preparing': return 'Preparing'
    case 'ready': return 'Ready'
    case 'served': return 'Served'
    case 'pending': return 'Pending'
    default: return 'Confirmed'
  }
}

export interface SessionView {
  key: string
  billRequested: boolean
  confirmedTotalMinor: number
  pendingTotalMinor: number
  orders: Pick<OrderReceipt, 'reference' | 'items' | 'totalMinor' | 'status'>[]
  pending: SessionView['orders']
}

export interface CartState {
  lines: CartLine[]
  attempt?: string
  dismissed?: string
}

export const storageKey = (tableCode: string) => 'qr-ordering:cart:' + tableCode
export const lineKey = (line: CartLine) => JSON.stringify([line.slug, line.instructions])

export function readCart(tableCode: string): CartState {
  if (typeof window === 'undefined') return { lines: [] }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(tableCode)) ?? '{}')
    const lines = Array.isArray(saved.lines) ? saved.lines.slice(0, 30).filter((line: CartLine) =>
      line && typeof line.slug === 'string' && Number.isInteger(line.quantity) &&
      line.quantity > 0 && line.quantity <= 20 && typeof line.instructions === 'string' && line.instructions.length <= 240,
    ) : []
    return {
      lines,
      attempt: typeof saved.attempt === 'string' && /^[0-9a-f]{32}$/.test(saved.attempt) && lines.length ? saved.attempt : undefined,
      dismissed: typeof saved.dismissed === 'string' ? saved.dismissed : undefined,
    }
  } catch {
    return { lines: [] }
  }
}

export function saveCart(tableCode: string, state: CartState) {
  try {
    localStorage.setItem(storageKey(tableCode), JSON.stringify(state))
  } catch {
    // Cart edits still work in memory when storage is disabled.
  }
}

export function newAttempt() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('')
}

export function money(amountMinor: number, currency: string) {
  return new Intl.NumberFormat('en-PK', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    minimumFractionDigits: amountMinor % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100)
}

export class RequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const timeout = AbortSignal.timeout(15_000)
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const response = await fetch(path, { ...options, signal })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new RequestError(error?.error?.message ?? 'The restaurant could not be reached. Please try again.', response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export function post<T = void>(path: string, data = {}) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
