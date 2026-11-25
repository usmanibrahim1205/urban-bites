import QRCode from 'qrcode'

export function parseQrOrigin(value: unknown) {
  if (typeof value !== 'string' || value.trim().length > 256 || !/^https?:\/\/[^\s/@?#\\]+\/*$/i.test(value.trim())) {
    throw new Error('Provide an HTTP or HTTPS origin with no credentials, path, query or fragment.')
  }
  const origin = new URL(value.trim())
  const host = origin.hostname.replace(/\.$/, '')
  const hostnameValid = host.startsWith('[') || (host.length <= 253 && host.split('.').every(
    label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
  ))
  if (!hostnameValid || ['0.0.0.0', '[::]'].includes(host) || origin.port === '0') {
    throw new Error('Use an address that identifies the host computer.')
  }
  return new URL(origin.origin)
}

export function qrOriginSettings(origin: URL) {
  const host = origin.hostname.replace(/\.$/, '')
  return {
    baseUrl: origin.origin,
    loopback: host === 'localhost' || host.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(host) ||
      host === '[::1]' || host.startsWith('[::ffff:7f'),
  }
}

function tableUrl(origin: URL, tableCode: string) {
  return new URL('/menu/' + encodeURIComponent(tableCode), origin).href
}

export function createTableQr(origin: URL, tableCode: string): Promise<string> {
  return QRCode.toString(tableUrl(origin, tableCode), { type: 'svg', margin: 4 })
}

export function createTableQrPng(origin: URL, tableCode: string): Promise<Buffer> {
  return QRCode.toBuffer(tableUrl(origin, tableCode), { type: 'png', margin: 4, scale: 10 })
}
