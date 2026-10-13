/** Read actual accessible values while ignoring animated presentation overlays. */
export function semanticText(element: Element | null): string {
  if (!element || element.getAttribute('aria-hidden') === 'true') return ''
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export function hasSemanticText(expected: string | RegExp) {
  const matches = (text: string) => typeof expected === 'string' ? text === expected : expected.test(text)
  return (_content: string, element: Element | null) => !!element && matches(semanticText(element)) && !Array.from(element.children).some(child => matches(semanticText(child)))
}
