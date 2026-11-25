import { describe, expect, it } from "vitest"

import { matchAskCommands, matchScopeArg, parseAskCommand, resolveScope, scopeChoices, smallTalk } from "./ask-commands"

describe("parseAskCommand", () => {
  it("leaves questions alone", () => {
    expect(parseAskCommand("how do I fix a flat")).toBeNull()
    expect(parseAskCommand("is 1/2 cup enough")).toBeNull()
  })
  it("reads names, aliases and arguments", () => {
    expect(parseAskCommand("/help")).toMatchObject({
      kind: "command",
      command: { name: "help" },
      arg: "",
    })
    expect(parseAskCommand("  /NEW ")).toMatchObject({
      kind: "command",
      command: { name: "clear" },
    })
    expect(parseAskCommand("/in  Vehicles ")).toMatchObject({
      command: { name: "in" },
      arg: "Vehicles",
    })
    expect(parseAskCommand("/f what about kids?")).toMatchObject({
      command: { name: "fresh" },
      arg: "what about kids?",
    })
  })
  it("flags unknown commands", () => {
    expect(parseAskCommand("/bogus thing")).toEqual({
      kind: "unknown",
      name: "bogus",
    })
  })
})

describe("matchAskCommands", () => {
  it("lists everything for a bare slash and narrows as you type", () => {
    expect(matchAskCommands("/").length).toBeGreaterThan(5)
    expect(matchAskCommands("/c").map((c) => c.name)).toEqual(["clear", "copy"])
    expect(matchAskCommands("/new").map((c) => c.name)).toEqual(["clear"])
    expect(matchAskCommands("/in ")).toEqual([])
  })
})

describe("scopes", () => {
  const choices = scopeChoices(
    ["Vehicles", "Medical", "Home", "Homestead"],
    [
      { name: "Reference", spaces: ["Medical"] },
      { name: "Empty", spaces: [] },
    ],
  )
  it("skips empty sections", () => {
    expect(choices.map((c) => c.label)).toEqual(["All spaces", "Reference", "Vehicles", "Medical", "Home", "Homestead"])
  })
  it("resolves exact, prefix and all", () => {
    expect(resolveScope("all", choices).match?.value).toBe("")
    expect(resolveScope("home", choices).match?.value).toBe("space:Home")
    expect(resolveScope("veh", choices).match?.value).toBe("space:Vehicles")
    expect(resolveScope("ref", choices).match?.value).toBe("section:Reference")
  })
  it("asks when it's ambiguous or unknown", () => {
    expect(resolveScope("hom", choices).options.map((c) => c.label)).toEqual(["Home", "Homestead"])
    expect(resolveScope("cooking", choices)).toEqual({ options: [] })
  })
  it("suggests while typing the argument", () => {
    expect(matchScopeArg("/in ", choices)).toHaveLength(6)
    expect(matchScopeArg("/in med", choices).map((c) => c.label)).toEqual(["Medical"])
    expect(matchScopeArg("/help", choices)).toEqual([])
  })
})

describe("smallTalk", () => {
  it("spots greetings, thanks and asking for help", () => {
    expect(smallTalk("Hi")).toBe("hello")
    expect(smallTalk("hey there!")).toBe("hello")
    expect(smallTalk("Good morning")).toBe("hello")
    expect(smallTalk("Can you help me?")).toBe("help")
    expect(smallTalk("hi, can you help me")).toBe("help")
    expect(smallTalk("what can you do")).toBe("help")
    expect(smallTalk("Are you an AI?")).toBe("help")
    expect(smallTalk("thanks!")).toBe("thanks")
    expect(smallTalk("ok thank you so much")).toBe("thanks")
    expect(smallTalk("bye")).toBe("bye")
  })
  it("leaves real questions alone", () => {
    expect(smallTalk("can you help me fix a flat")).toBeNull()
    expect(smallTalk("help my dog ate chocolate")).toBeNull()
    expect(smallTalk("what is this rash")).toBeNull()
    expect(smallTalk("Sichuan")).toBeNull()
    expect(smallTalk("how does a furnace work")).toBeNull()
  })
})
