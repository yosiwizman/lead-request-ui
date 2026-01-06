import { useState, useRef, useCallback } from 'react'
import './App.css'

type Scope = 'Residential' | 'Commercial' | 'Both'
type UseCase = 'call' | 'email' | 'both'
type AppStatus = 'idle' | 'loading' | 'building' | 'success' | 'error'
type CoverageFieldName = 'first_name' | 'last_name' | 'address' | 'city' | 'state' | 'zip' | 'phone' | 'email'

interface QualitySummary {
  totalFetched: number
  kept: number
  filteredMissingPhone: number
  filteredInvalidEmail: number
  filteredDnc: number
  missingNameOrAddressCount: number
}

interface FieldCoverageBlock {
  total: number
  present: Record<CoverageFieldName, number>
  pct: Record<CoverageFieldName, number>
}

interface FieldCoverage {
  coverageFetched: FieldCoverageBlock
  coverageKept: FieldCoverageBlock
}

interface BuildingDetails {
  audienceId: string
  leadRequest: string
  zipCodes: string
  leadScope: string
  useCase: UseCase
  requestId: string
}

const MAX_POLL_DURATION_MS = 60000 // 60 seconds max polling
const POLL_INTERVAL_MS = 2000 // Poll every 2 seconds

function App() {
  const [leadRequest, setLeadRequest] = useState('')
  const [zipCodes, setZipCodes] = useState('')
  const [scope, setScope] = useState<Scope>('Residential')
  const [useCase, setUseCase] = useState<UseCase>('both')
  const [status, setStatus] = useState<AppStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [signedUrl, setSignedUrl] = useState<string>('')
  const [leadCount, setLeadCount] = useState<number>(0)
  const [qualitySummary, setQualitySummary] = useState<QualitySummary | null>(null)
  const [fieldCoverage, setFieldCoverage] = useState<FieldCoverage | null>(null)
  const [fieldCoverageExpanded, setFieldCoverageExpanded] = useState(false)
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
          useCase: details.useCase,
          requestId: details.requestId,
        }),
      })

      const data = await res.json()

      // Success!
      if (res.ok && data.ok) {
        stopPolling()
        setLeadCount(data.count || 0)
        setSignedUrl(data.signedUrl || '')
        setQualitySummary(data.quality || null)
        setFieldCoverage(data.fieldCoverage || null)
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
    setQualitySummary(null)
    setFieldCoverage(null)
    setFieldCoverageExpanded(false)
    setBuildingDetails(null)

    try {
      const res = await fetch('/api/leads/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadRequest: leadRequest.trim(),
          zipCodes: zipCodes,
          leadScope: scope.toLowerCase(),
          useCase: useCase,
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
          useCase: data.error.details?.useCase || useCase,
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
      setQualitySummary(data.quality || null)
      setFieldCoverage(data.fieldCoverage || null)
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
            <label htmlFor="useCase">Quality Preset</label>
            <select
              id="useCase"
              value={useCase}
              onChange={(e) => setUseCase(e.target.value as UseCase)}
            >
              <option value="call">Call Leads (Phone-first)</option>
              <option value="email">Email Leads (Validated email only)</option>
              <option value="both">Call + Email (Best available)</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="scope">Target</label>
            <select
              id="scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="Residential">Residential (B2C)</option>
              <option value="Commercial">Commercial (B2B)</option>
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
              
              {qualitySummary && (
                <div className="quality-summary">
                  <h4>Quality Summary</h4>
                  <ul>
                    <li>Total fetched: {qualitySummary.totalFetched}</li>
                    <li>Kept: {qualitySummary.kept}</li>
                    {qualitySummary.filteredMissingPhone > 0 && (
                      <li>Filtered (no phone): {qualitySummary.filteredMissingPhone}</li>
                    )}
                    {qualitySummary.filteredInvalidEmail > 0 && (
                      <li>Filtered (invalid email): {qualitySummary.filteredInvalidEmail}</li>
                    )}
                    {qualitySummary.filteredDnc > 0 && (
                      <li>Filtered (DNC): {qualitySummary.filteredDnc}</li>
                    )}
                    {qualitySummary.missingNameOrAddressCount > 0 && (
                      <li>Missing name/address: {qualitySummary.missingNameOrAddressCount}</li>
                    )}
                  </ul>
                </div>
              )}
              
              {fieldCoverage && (
                <div className="field-coverage">
                  <button 
                    className="field-coverage-toggle"
                    onClick={() => setFieldCoverageExpanded(!fieldCoverageExpanded)}
                    type="button"
                  >
                    {fieldCoverageExpanded ? '▼' : '▶'} Field Coverage Diagnostics
                  </button>
                  
                  {fieldCoverageExpanded && (
                    <div className="field-coverage-content">
                      <div className="coverage-block">
                        <h5>Before Filtering ({fieldCoverage.coverageFetched.total} contacts)</h5>
                        <table className="coverage-table">
                          <thead>
                            <tr>
                              <th>Field</th>
                              <th>Count</th>
                              <th>%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email'] as CoverageFieldName[]).map(field => (
                              <tr key={field} className={fieldCoverage.coverageFetched.pct[field] === 0 ? 'coverage-zero' : ''}>
                                <td>{field.replace('_', ' ')}</td>
                                <td>{fieldCoverage.coverageFetched.present[field]}</td>
                                <td>{fieldCoverage.coverageFetched.pct[field]}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      
                      <div className="coverage-block">
                        <h5>After Filtering ({fieldCoverage.coverageKept.total} leads)</h5>
                        <table className="coverage-table">
                          <thead>
                            <tr>
                              <th>Field</th>
                              <th>Count</th>
                              <th>%</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email'] as CoverageFieldName[]).map(field => (
                              <tr key={field} className={fieldCoverage.coverageKept.pct[field] === 0 ? 'coverage-zero' : ''}>
                                <td>{field.replace('_', ' ')}</td>
                                <td>{fieldCoverage.coverageKept.present[field]}</td>
                                <td>{fieldCoverage.coverageKept.pct[field]}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      
                      {/* Enrichment recommendation */}
                      {(fieldCoverage.coverageFetched.pct.first_name <= 5 || 
                        fieldCoverage.coverageFetched.pct.address <= 5 || 
                        fieldCoverage.coverageFetched.pct.email <= 5) && (
                        <div className="enrichment-notice">
                          ⚠️ <strong>Enrichment may be needed:</strong> Name, address, or email coverage is very low ({`<`}5%).
                          Consider using a data enrichment service to fill in missing contact details.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              
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