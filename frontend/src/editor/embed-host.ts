import type { ComponentType } from "react"

import type { EditorEnv } from "@/editor/extensions"

type ReadOnlyEditor = ComponentType<{ markdown: string; editable: boolean; compact?: boolean; env: Omit<EditorEnv, "slashItems"> }>

/**
 * The page editor, for showing an embedded page with. page-editor.tsx fills
 * this in; importing it from the embed view directly would be a cycle.
 */
export const embedHost: { Editor: ReadOnlyEditor | null } = { Editor: null }
