import { useEffect, useState } from 'react'

// Desmos calculator API. The key is public-facing by design (it ships in the
// script URL), so it is safe to embed in the client bundle.
const DESMOS_API_KEY = '4ce86a2f75db4ee7b6b768467894caed'
const DESMOS_SRC = `https://www.desmos.com/api/v1.12/calculator.js?apiKey=${DESMOS_API_KEY}`

let loadPromise = null

function loadDesmos() {
  if (typeof window !== 'undefined' && window.Desmos) return Promise.resolve(window.Desmos)
  if (loadPromise) return loadPromise
  loadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = DESMOS_SRC
    s.async = true
    s.onload = () => resolve(window.Desmos)
    s.onerror = () => { loadPromise = null; reject(new Error('Failed to load Desmos')) }
    document.head.appendChild(s)
  })
  return loadPromise
}

// Loads the Desmos script once (shared across all calculator instances) and
// reports when window.Desmos is ready.
export function useDesmos() {
  const [ready, setReady] = useState(() => typeof window !== 'undefined' && Boolean(window.Desmos))
  const [error, setError] = useState(false)

  useEffect(() => {
    if (ready) return
    let alive = true
    loadDesmos()
      .then(() => { if (alive) setReady(true) })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [ready])

  return { ready, error }
}
