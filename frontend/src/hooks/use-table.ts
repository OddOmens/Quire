import { useCallback, useMemo, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { errorMessage } from "@/hooks/use-vault"
import { api, ApiError, type Column, type Row, type Schema, type TableData, type View } from "@/lib/api"

/**
 * A database's rows and columns, and every way to change them. Changes show
 * at once and are sent one after another; the server's answer (with
 * formulas worked out again) replaces the guess when the last one lands.
 */
export function useTable(path: string) {
  const qc = useQueryClient()
  const key = useMemo(() => ["table", path], [path])
  const query = useQuery({ queryKey: key, queryFn: () => api.table(path), enabled: !!path })
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const pending = useRef(0)

  const run = useCallback(
    <T extends TableData>(guess: ((d: TableData) => TableData) | null, call: () => Promise<T>): Promise<T | undefined> => {
      void qc.cancelQueries({ queryKey: key, exact: true })
      const before = qc.getQueryData<TableData>(key)
      if (before && guess) qc.setQueryData<TableData>(key, guess(before))
      pending.current++
      const p = chain.current.then(async () => {
        try {
          const res = await call()
          if (pending.current === 1) qc.setQueryData(key, res)
          return res
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            toast.warning("This database changed on another device", { description: "Showing the latest version. Make your change again." })
          } else {
            toast.error(errorMessage(e))
          }
          void qc.invalidateQueries({ queryKey: key, exact: true })
          return undefined
        } finally {
          pending.current--
          // Other databases may roll up from this one.
          void qc.invalidateQueries({ queryKey: ["table"], predicate: (q) => q.queryKey[1] !== path })
          void qc.invalidateQueries({ queryKey: ["calendar"] })
        }
      })
      chain.current = p
      return p
    },
    [qc, key, path],
  )

  /** Sets cells as typed: row id → column id → text. */
  const setCells = useCallback(
    (updates: { id: string; cells: Record<string, string> }[]) => {
      const byRow = new Map(updates.map((u) => [u.id, u.cells]))
      return run(
        (d) => ({ ...d, rows: d.rows.map((r) => (byRow.has(r.id) ? { ...r, cells: withCells(r.cells, byRow.get(r.id)!) } : r)) }),
        () => api.updateRows(path, updates),
      )
    },
    [run, path],
  )

  const setCell = useCallback((row: string, column: string, value: string) => setCells([{ id: row, cells: { [column]: value } }]), [setCells])

  /** Adds rows before `before` (or last) and resolves to the new rows' ids. */
  const addRows = useCallback(
    async (rows: { cells: Record<string, string> }[] = [{ cells: {} }], before = "") => {
      const old = new Set((qc.getQueryData<TableData>(key)?.rows ?? []).map((r) => r.id))
      const temp: Row[] = rows.map((r, i) => ({ id: `new-${Date.now()}-${i}`, created: new Date().toISOString(), cells: { ...r.cells } }))
      const res = await run(
        (d) => {
          const at = before ? d.rows.findIndex((r) => r.id === before) : -1
          const next = [...d.rows]
          next.splice(at < 0 ? next.length : at, 0, ...temp)
          return { ...d, rows: next }
        },
        () => api.addRows(path, rows, before),
      )
      return res ? res.rows.filter((r) => !old.has(r.id)).map((r) => r.id) : []
    },
    [run, path, qc, key],
  )

  const deleteRows = useCallback(
    (ids: string[]) => {
      const gone = new Set(ids)
      return run((d) => ({ ...d, rows: d.rows.filter((r) => !gone.has(r.id)) }), () => api.deleteRows(path, ids))
    },
    [run, path],
  )

  /** Moves rows, in the order given, before `before` or last. */
  const moveRows = useCallback(
    (ids: string[], before = "") => {
      const moving = new Set(ids)
      return run(
        (d) => {
          const picked = ids.map((id) => d.rows.find((r) => r.id === id)).filter((r): r is Row => !!r)
          const rest = d.rows.filter((r) => !moving.has(r.id))
          const at = before ? rest.findIndex((r) => r.id === before) : -1
          rest.splice(at < 0 ? rest.length : at, 0, ...picked)
          return { ...d, rows: rest }
        },
        () => api.moveRows(path, ids, before),
      )
    },
    [run, path],
  )

  const saveSchema = useCallback(
    (schema: Schema) => {
      const rev = qc.getQueryData<TableData>(key)?.rev
      return run((d) => ({ ...d, schema }), () => api.saveSchema(path, schema, pending.current > 1 ? undefined : rev))
    },
    [run, path, qc, key],
  )

  const current = () => qc.getQueryData<TableData>(key)?.schema

  /** Changes one column's settings. */
  const updateColumn = useCallback(
    (id: string, patch: Partial<Column>) => {
      const s = current()
      if (!s) return
      return saveSchema({ ...s, columns: s.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) })
    },
    [saveSchema], // eslint-disable-line react-hooks/exhaustive-deps
  )

  /** Changes one view's settings. */
  const updateView = useCallback(
    (id: string, patch: Partial<View>) => {
      const s = current()
      if (!s) return
      return saveSchema({ ...s, views: s.views.map((v) => (v.id === id ? { ...v, ...patch } : v)) })
    },
    [saveSchema], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const importRows = useCallback((file: File) => run(null, () => api.importRows(path, file)), [run, path])

  const restore = useCallback((revision: number) => run(null, () => api.restoreTable(path, revision)), [run, path])

  return { ...query, setCell, setCells, addRows, deleteRows, moveRows, saveSchema, updateColumn, updateView, importRows, restore }
}

export type TableActions = ReturnType<typeof useTable>

function withCells(cells: Record<string, string>, patch: Record<string, string>) {
  const next = { ...cells }
  for (const [k, v] of Object.entries(patch)) {
    if (v === "") delete next[k]
    else next[k] = v
  }
  return next
}
