import type { TableActions } from "@/hooks/use-table"
import type { Row, TableData, View } from "@/lib/api"

/** What every database view gets from the database it shows. */
export type ViewProps = {
  data: TableData
  table: TableActions
  view: View
  /** The rows the view shows: filtered, searched and sorted. */
  rows: Row[]
  editable: boolean
  /** Opens a row (of this or another database) in the side panel. */
  openRow: (path: string, id: string) => void
}
