// Minimal hash router.
//
// Hand-rolled rather than pulling in react-router, for two reasons: hash routes
// work on any static host with no rewrite rules, and adding a routing dependency
// is a shared decision that would block parallel work while it was debated.
// About 25 lines covers what a tool site needs. Swap it later if routing ever
// gets genuinely complicated.

import { useEffect, useState } from 'react'

export function currentRoute(): string {
  return window.location.hash.replace(/^#\/?/, '')
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute)

  useEffect(() => {
    const onChange = () => setRoute(currentRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

export function navigate(route: string) {
  window.location.hash = `#/${route}`
}

export function href(route: string): string {
  return `#/${route}`
}
