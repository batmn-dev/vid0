/** @vitest-environment jsdom */
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, expect, it } from "vitest"
import { InlineSearchLabel } from "./inline-search-label"

beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})
const container = document.createElement("div")
let root = createRoot(container)
afterEach(() => {
  act(() => root.unmount())
  root = createRoot(container)
})

it("keeps the surrounding label and width placeholder mounted while the accessible count updates", () => {
  const render = (title: string, animate = true) =>
    act(() =>
      root.render(<InlineSearchLabel title={title} running animate={animate} />)
    )
  render("Searching 9 websites")
  const paint = container.querySelector('[aria-hidden="true"]')!
  const surrounding = paint.firstElementChild
  expect(surrounding?.textContent).toBe("Searching 9 websites")
  render("Searching 10 websites")
  expect(container.querySelector('[aria-hidden="true"]')).toBe(paint)
  expect(paint.firstElementChild).toBe(surrounding)
  expect(surrounding?.querySelector(".invisible")?.textContent).toBe("10")
  expect(container.querySelector(".sr-only")?.textContent).toBe(
    "Searching 10 websites"
  )
  render("Searching the web")
  expect(container.textContent).toBe("Searching the web")
  render("Searching 10 websites", false)
  expect(container.textContent).toBe("Searching 10 websites")
  expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
})
