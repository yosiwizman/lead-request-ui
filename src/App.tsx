import { useState, useRef, useCallback } from 'react'
import './App.css'

type Scope = 'Residential' | 'Commercial' | 'Both'
type AppStatus = 'idle' | 'loading' | 'building' | 'success' | 'error'

interface BuildingDetails {
  audienceId: string
  leadRequest: string
  zipCodes: string
  leadScope: string
  requestId: string
}

const MAX_POLL_DURATION_MS = 60000 // 60 seconds max polling
const POLL_INTERVAL_MS = 2000 // Poll every 2 seconds

function App() {
  const [leadRequest, setLeadRequest] = useState('')
  const [zipCodes, setZipCodes] = useState('')
  const [scope, setScope] = useState<Scope>('Residential')
  const [status, setStatus] = useState<AppStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [signedUrl, setSignedUrl] = useState<string>('')
  const [leadCount, setLeadCount] = useState<number>(0)
  const [buildingDetails, setBuildingDetails] = useState<BuildingDetails | null>(null)
  const [pollElapsed, setPollElapsed] = useState(0)
  
  const pollStartRef = useRef<number>(0)
  const pollTimerRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const pollStatus = useCallback(async (details: BuildingDetails) => {
    const elapsed = Date.now() - pollStartRef.current
    setPollElapsed(Math.floor(elapsed / 1000))

    // Timeout after MAX_POLL_DURATION_MS
    if (elapsed > MAX_POLL_DURATION_MS) {
      stopPolling()
      setErrorMessage(`Audience still building after ${MAX_POLL_DURATION_MS / 1000}s. Try again later. (ID: ${details.audienceId})`)
      setStatus('error')
      return
    }

    try {
      const res = await fetch('/api/leads/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audienceId: details.audienceId,
          leadRequest: details.leadRequest,
          zipCodes: details.zipCodes,
          leadScope: details.leadScope,
          requestId: details.requestId,
        }),
      })

      const data = await res.json()

      // Success!
      if (res.ok && data.ok) {
        stopPolling()
        setLeadCount(data.count || 0)
        setSignedUrl(data.signedUrl || '')
        setStatus('success')
        setBuildingDetails(null)
        return
      }

      // Still building - continue polling
      if (res.status === 202 && data.error?.code === 'provider_building') {
        // Keep polling, state already set
        return
      }

      // Hard error (404 no results, or other error)
      stopPolling()
      const msg = data?.error?.message || 'Failed to generate leads'
      const audienceId = data?.error?.details?.audienceId || details.audienceId
      setErrorMessage(`${msg} (Audience ID: ${audienceId})`)
      setStatus('error')
      setBuildingDetails(null)
    } catch {
      stopPolling()
      setErrorMessage('Network error while polling. Try again.')
      setStatus('error')
      setBuildingDetails(null)
    }
  }, [stopPolling])

  const startPolling = useCallback((details: BuildingDetails) => {
    setBuildingDetails(details)
    pollStartRef.current = Date.now()
    setPollElapsed(0)
    setStatus('building')

    // Start polling interval
    pollTimerRef.current = window.setInterval(() => {
      pollStatus(details)
    }, POLL_INTERVAL_MS)

    // Also poll immediately
    pollStatus(details)
  }, [pollStatus])

  const handleGenerate = async () => {
    if (!leadRequest.trim() || !zipCodes.trim()) {
      setErrorMessage('Please fill in both fields')
      setStatus('error')
      return
    }

    // Stop any existing polling
    stopPolling()
    
    setStatus('loading')
    setErrorMessage('')
    setSignedUrl('')
    setLeadCount(0)
    setBuildingDetails(null)

    try {
      const res = await fetch('/api/leads/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadRequest: leadRequest.trim(),
          zipCodes: zipCodes,
          leadScope: scope.toLowerCase(),
        }),
      })

      const data = await res.json()

      // Handle 202 building response - start polling
      if (res.status === 202 && data.error?.code === 'provider_building') {
        const details: BuildingDetails = {
          audienceId: data.error.details?.audienceId || '',
          leadRequest: data.error.details?.leadRequest || leadRequest.trim(),
          zipCodes: data.error.details?.zipCodes || zipCodes,
          leadScope: data.error.details?.leadScope || scope.toLowerCase(),
          requestId: data.error.details?.requestId || '',
        }
        startPolling(details)
        return
      }

      // Handle error responses
      if (!res.ok || !data.ok) {
        const msg = data?.error?.message || 'Failed to generate leads'
        const audienceId = data?.error?.details?.audienceId
        setErrorMessage(audienceId ? `${msg} (Audience ID: ${audienceId})` : msg)
        setStatus('error')
        return
      }

      // Immediate success
      setLeadCount(data.count || 0)
      setSignedUrl(data.signedUrl || '')
      setStatus('success')
    } catch {
      setErrorMessage('Failed to generate leads')
      setStatus('error')
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Lead Request</h1>
      </header>

      <main className="main">
        <div className="form">
          <div className="form-group">
            <label htmlFor="leadRequest">Lead Request</label>
            <input
              id="leadRequest"
              type="text"
              placeholder="roofing in Miami"
              value={leadRequest}
              onChange={(e) => setLeadRequest(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="zipCodes">ZIP Codes</label>
            <input
              id="zipCodes"
              type="text"
              placeholder="33101,33130"
              value={zipCodes}
              onChange={(e) => setZipCodes(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="scope">Scope</label>
            <select
              id="scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="Residential">Residential</option>
              <option value="Commercial">Commercial</option>
              <option value="Both">Both</option>
            </select>
          </div>

          <button
            className="btn-primary"
            onClick={handleGenerate}
            disabled={status === 'loading' || status === 'building'}
          >
            {status === 'loading' ? 'Generating...' : status === 'building' ? 'Building...' : 'Generate Leads'}
          </button>
        </div>

        <div className="results">
          {status === 'error' && (
            <div className="error">{errorMessage}</div>
          )}

          {status === 'loading' && (
            <div className="loading">Generating leads...</div>
          )}

          {status === 'building' && buildingDetails && (
            <div className="loading">
              <p>Building audience... ({pollElapsed}s)</p>
              <p style={{ fontSize: '0.875rem', color: '#666', marginTop: '0.5rem' }}>
                ID: {buildingDetails.audienceId.slice(0, 8)}...
              </p>
            </div>
          )}

          {status === 'success' && signedUrl && (
            <div className="success">
              <p>Generated {leadCount} leads</p>
              <a className="btn-download" href={signedUrl} target="_blank" rel="noopener noreferrer">
                Download CSV
              </a>
              <p style={{ marginTop: '0.75rem', color: '#666' }}>
                Link expires in 24 hours
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

export default App