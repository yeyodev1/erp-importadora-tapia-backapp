# CLAUDE.md

API del ERP de Importadora Tapia: reemplaza al "SISTEMA INTEGRADO" de Macio.
La visión y el alcance están en `../VISION.md`; lo que dijo el cliente, con minutos, en `../docs/fuentes/`.

## Commands

- `pnpm dev:memory` — API en :8100 con Mongo en memoria (replica set) y datos de demo. Usuario `admin@importadoratapia.app` / `tapia2026`. **Usa esto para probar; nunca Atlas.**
- `pnpm dev` — contra `DB_URI` del `.env` (debe ser replica set: Atlas lo es).
- `pnpm build` — tsc → `dist/`. `npx tsc --noEmit -p .` para solo tipar.
- `pnpm test` — `node:test` + mongodb-memory-server (`test/*.test.ts`, helpers en `test/helpers.ts`).

## Stack

Express 5 + TypeScript (CommonJS) + Mongoose 8. JWT Bearer con `role`. Vercel (`api/index.ts`).

## Reglas contables (no negociables)

- **Montos en CENTAVOS enteros** en DB y en la API (`12345` = $123.45). Helpers en `src/utils/money.ts`
  (`cents()` valida entrada, `percentOf()`, `costCents()`). Costos unitarios en dólares con 6 decimales.
  Cantidades con 4 decimales (`roundQty`).
- **Todo documento que mueve dinero o stock se graba en `runInTransaction`** (`src/config/transaction.ts`):
  documento + movimientos de inventario + asiento juntos, o nada.
- **Asientos solo vía `accountingService.postEntry(input, actor, session)`**: valida cuadre, cuentas de
  movimiento y mes abierto. Nunca escribas `JournalEntry` directo.
- **No se edita lo contabilizado.** Anular = `accountingService.reverseBySource(docId, motivo, fecha, actor, session)`
  + revertir stock con el movimiento contrario + `status: "anulado"` en el documento.
- **Stock solo vía `inventoryCoreService.applyMovement(...)`**: aplica costo promedio por bodega y devuelve el
  costo de cada línea (`totalCost` en centavos) para armar el asiento. `totalsByGroup()` agrupa por grupo
  de producto (cada `ProductGroup` tiene `accounts.inventory/sales/cost`).
- **Cuentas del mapa contable**: `accountingService.mappedAccount("customers" | "vatSales" | ...)` (ver
  `ACCOUNT_MAP_KEYS` en `settings.model.ts`). No hardcodees códigos de cuenta.
- SRI: los módulos arman un `SriPayload` (`src/services/sri/sri.types.ts`) y llaman `sri.issue(payload)`; guardan `accessKey`, `sriStatus`, `authorizationNumber` y el `xml` en su documento. Nunca bloquees la grabación por el SRI.
- Numeración: `sequenceService.next(clave, session)`; documentos SRI con `nextDocNumber(tipo, estab, pto, session)`.
- Bancos/cajas: todo movimiento de dinero en una cuenta bancaria o caja (depósito de un cobro, cheque de un pago) se registra con `bankCoreService.recordMovement(...)` además del asiento; los cheques toman número con `takeCheckNumber`. La conciliación cruza `BankMovement`.
- Autor: `actorOf(req)` (`src/utils/actor.ts`) en el controller y se pasa al service.
- Fechas de documento: `parseDay()` de `src/utils/dates.ts` (mediodía UTC, AAAA-MM-DD).

## Arquitectura

routes → controllers (sin lógica) → services (lanzan `CustomError("mensaje", status)`) → models.

- Un router por módulo ya montado en `src/routes/index.ts`: `/api/inventory`, `/sales`, `/receivables`,
  `/purchases`, `/banks`, `/accounting`, `/taxes`, `/dashboard`. Agrega tus rutas en el archivo del módulo;
  no toques `index.ts`.
- Roles: `requireRoles("contabilidad", ...)` de `roles.middleware.ts` (admin pasa siempre; auditor solo GET).
  Roles: admin, contabilidad, facturacion, cartera, bodega, vendedor, auditor.
- Catálogos ya hechos (`/api/catalog/*`): accounts, bank-accounts (bancos y cajas con su cuenta contable), parties (cliente/proveedor/empleado en un solo modelo
  `Party`), warehouses (GYE `001-001`, UIO `002-001`), product-groups, products. `/api/settings` (empresa,
  mapa contable, cierre de mes `PUT /settings/lock`, usuarios).
- Listados: `{ items, total, page, pages }`. Respuestas con cuerpo desnudo.
- Env solo en `src/config/env.ts`.

## Convenciones

- Comillas dobles, punto y coma, 2 espacios. **Máximo 300 líneas por archivo**: si crece, parte el service.
- Exports nombrados (routers `export default`). Controllers importados como namespace.
- Archivos `x.controller.ts`, `x.routes.ts`, `x.service.ts`, `x.model.ts`.
- Identificadores en inglés; dominio, comentarios y mensajes de error en español.
- Comentarios explican el porqué. Toda lógica con dinero lleva su prueba en `test/<modulo>.test.ts`.
