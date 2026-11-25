import express from 'express'
import type { Router } from 'express'
import { HttpError } from './http-error.ts'
import type { StaffAuth } from './staff-auth.ts'
import type { Notify, Sessions } from './sessions.ts'
import { restaurant } from './restaurant.ts'
import type { KitchenChange } from './kitchen.ts'

function id(value: string) {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new HttpError(400, 'INVALID_ID', 'This record could not be identified.')
  }
  return parsed
}

export function staffRoutes(auth: StaffAuth, sessions: Sessions, notify: Notify,
  kitchen: Router, kitchenChanged: (change: KitchenChange) => void, tables: Router) {
  const router = express.Router()
  router.use(auth.router)
  router.use(express.json({ limit: '4kb' }))
  router.use(auth.requireStaff)
  router.use('/kitchen', kitchen)
  router.use('/tables', tables)
  router.get('/overview', (_request, response) => {
    response.json({ ...sessions.overview(), restaurant: restaurant.name, currency: restaurant.currency })
  })
  router.post('/orders/:reference/:decision', (request, response) => {
    const { reference, decision } = request.params
    if (decision !== 'approve' && decision !== 'reject') throw new HttpError(404, 'NOT_FOUND', 'Action not found.')
    const change = sessions.resolveOrder(reference, decision, request.body?.reviewKey, request.body?.verified)
    if (change) {
      notify(change.kind, change.browsers)
      if (decision === 'approve') kitchenChanged({ kind: 'approved', reference })
    }
    response.sendStatus(204)
  })
  router.post('/sessions/:sessionId/browsers/:authorizationId/revoke', (request, response) => {
    notify('browser-revoked', sessions.revoke(id(request.params.sessionId), id(request.params.authorizationId)))
    response.sendStatus(204)
  })
  router.post('/sessions/:sessionId/reopen', (request, response) => {
    notify('ordering-reopened', sessions.reopen(id(request.params.sessionId), request.body?.billRevision))
    response.sendStatus(204)
  })
  router.post('/sessions/:sessionId/settle', (request, response) => {
    notify('settled', sessions.settle(id(request.params.sessionId), request.body?.billRevision, request.body?.confirmed, request.body?.totalMinor))
    kitchenChanged({ kind: 'settled' })
    response.sendStatus(204)
  })
  return router
}
