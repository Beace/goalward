/** Read actual accessible values while ignoring animated presentation overlays. */
export function semanticText(element: Element | null): string {
  if (!element || element.getAttribute('aria-hidden') === 'true') return ''
  const read = (node: Element): string => {
    if (node.getAttribute('aria-hidden') === 'true') return ''
    let text = ''
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.textContent ?? ''
      else if (child.nodeType === 1) text += read(child as Element)
    }
    return text
  }
  // Read without cloning the entire trace subtree for every candidate element.
  return read(element).replace(/\s+/g, ' ').trim()
}

export function hasSemanticText(expected: string | RegExp) {
  const matches = (text: string) => typeof expected === 'string' ? text === expected : expected.test(text)
  return (_content: string, element: Element | null) => !!element && matches(semanticText(element)) && !Array.from(element.children).some(child => matches(semanticText(child)))
}
