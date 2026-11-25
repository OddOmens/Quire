import { describe, expect, it } from "vitest"

import { isLocalRev, keeps, noteAddress, pageName, snippetAt, uniquePath } from "./offline"

describe("keeps", () => {
  it("keeps the answers pages are read from", () => {
    for (const url of ["/api/tree", "/api/spaces", "/api/spaces/Work", "/api/spaces/Work/tasks", "/api/notes/Work/Plan.md", "/api/tables/Work/Budget.md", "/api/calendar?from=2026-11-01&to=2026-12-05", "/api/auth/session"]) {
      expect(keeps(url), url).toBe(true)
    }
  })
  it("leaves out what isn't a page: history, exports, devices, backups, the trash", () => {
    for (const url of ["/api/tables/Work/Budget.md/history", "/api/tables/Work/Budget.md/export", "/api/history/Work/Plan.md", "/api/sessions", "/api/backup", "/api/trash", "/api/attachments", "/api/shares", "/api/spaces/Work/export"]) {
      expect(keeps(url), url).toBe(false)
    }
  })
  it("keeps a database in a space named like an action", () => {
    expect(keeps("/api/tables/export/history.md")).toBe(true)
  })
})

describe("noteAddress", () => {
  it("is the address the app asks for a page at", () => {
    expect(noteAddress("Work/Trip notes #2.md")).toBe("/api/notes/Work/Trip%20notes%20%232.md")
  })
})

describe("pageName", () => {
  it("names a page the way the server does", () => {
    expect(pageName("  Trip   notes ")).toBe("Trip notes")
    expect(pageName("a/b:c?")).toBe("a-b-c-")
    expect(pageName("..hidden")).toBe("hidden")
    expect(pageName("   ")).toBe("Untitled")
    expect([...pageName("x".repeat(200))].length).toBe(120)
  })
})

describe("uniquePath", () => {
  it("numbers a name that's taken", () => {
    const taken = new Set(["Work/Plan.md", "Work/Plan 2.md"])
    expect(uniquePath("Work/New.md", (p) => taken.has(p))).toBe("Work/New.md")
    expect(uniquePath("Work/Plan.md", (p) => taken.has(p))).toBe("Work/Plan 3.md")
  })
})

describe("snippetAt", () => {
  it("shows the text around a match on one line", () => {
    const text = `${"a ".repeat(60)}\nneedle here\n${"b ".repeat(80)}`
    const s = snippetAt(text, text.indexOf("needle"), 6)
    expect(s).toContain("needle here")
    expect(s.startsWith("…") && s.endsWith("…")).toBe(true)
    expect(s).not.toContain("\n")
  })
  it("falls back to the start of the page", () => {
    expect(snippetAt("Hello\nworld", -1, 0)).toBe("Hello world")
  })
})

describe("isLocalRev", () => {
  it("tells a rev made on this device from the server's", () => {
    expect(isLocalRev("local:3")).toBe(true)
    expect(isLocalRev("e2a1b5bb")).toBe(false)
    expect(isLocalRev(undefined)).toBe(false)
  })
})
