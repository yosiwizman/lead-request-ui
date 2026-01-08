import { useState, useRef, useCallback, useEffect, Component, type ReactNode } from 'react'
import './App.css'

// ─────────────────────────────────────────────────────────────────────────────
// Error Boundary - catches rendering errors and shows fallback UI
// ─────────────────────────────────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('React Error Boundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app">
          <header className="header">
            <h1>Lead Request</h1>
          </header>
          <main className="main">
            <div className="error-boundary">
              <h2>Something went wrong</h2>
              <p>An unexpected error occurred. Please try reloading the page.</p>
              <p className="error-detail">{this.state.error?.message || 'Unknown error'}</p>
              <button
                className="btn-primary"
                onClick={() => window.location.reload()}
              >
                Reload Page
              </button>
            </div>
          </main>
        </div>
      )
    }
    return this.props.children
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Extract error message from API response
// Handles both string errors and { code, message } objects
// ─────────────────────────────────────────────────────────────────────────────

function getErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.code === 'string') return obj.code
  }
  return fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Scope = 'Residential' | 'Commercial' | 'Both'
type UseCase = 'call' | 'email' | 'both'
type QualityTier = 'hot' | 'balanced' | 'scale'
type AppStatus = 'idle' | 'loading' | 'building' | 'building_long' | 'success' | 'error'
type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated'
type CoverageFieldName = 'first_name' | 'last_name' | 'address' | 'city' | 'state' | 'zip' | 'phone' | 'email'

interface MatchByTierCounts {
  high: number
  medium: number
  low: number
}

interface MatchScoreDistribution {
  score0: number
  score1: number
  score2: number
  score3: number
}

interface QualitySummary {
  totalFetched: number
  kept: number
  filteredMissingPhone: number
  filteredInvalidEmail: number
  filteredInvalidEmailEsp: number
  filteredEmailTooOld: number
  filteredDnc: number
  filteredLowMatchScore: number
  missingNameOrAddressCount: number
  matchByTier: MatchByTierCounts
  matchScoreDistribution: MatchScoreDistribution
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
  exportId?: string
}

interface SuppressionInfo {
  suppressedCount: number
  suppressedStates: string[]
}

interface QualityGateInfo {
  deliveredCount: number
  requestedCount: number
  rejectedByQualityCount: number
  minQualityScoreUsed: number
  avgQualityScore: number
  p90QualityScore: number
  pctWireless: number
  pctWithAddress: number
  warning?: string
}

interface ExportItem {
  id: string
  createdAt: string
  provider: string
  leadRequest: string
  zipCodes: string[]
  target: number
  useCase: string | null
  status: string
  errorCode: string | null
  errorMessage: string | null
  totalFetched: number | null
  kept: number | null
  hasFile: boolean
  lastSignedUrlAt: string | null
}

const MAX_POLL_ATTEMPTS = 30 // Hard cap on poll attempts
const DEFAULT_POLL_SECONDS = 3 // Default backoff if server doesn't specify

function App() {
  // ─────────────────────────────────────────────────────────────────────────
  // Auth state
  // ─────────────────────────────────────────────────────────────────────────
  const [authStatus, setAuthStatus] = useState<AuthStatus>('checking')
  const [passcode, setPasscode] = useState('')
  const [loginError, setLoginError] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)

  // ─────────────────────────────────────────────────────────────────────────
  // Export history state
  // ─────────────────────────────────────────────────────────────────────────
  const [exports, setExports] = useState<ExportItem[]>([])
  const [exportsLoading, setExportsLoading] = useState(false)
  const [exportsError, setExportsError] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [regeneratingIds, setRegeneratingIds] = useState<Set<string>>(new Set())

  // ─────────────────────────────────────────────────────────────────────────
  // Form state
  // ─────────────────────────────────────────────────────────────────────────
  const [leadRequest, setLeadRequest] = useState('')
  const [zipCodes, setZipCodes] = useState('')
  const [scope, setScope] = useState<Scope>('Residential')
  const [useCase, setUseCase] = useState<UseCase>('both')
  const [qualityTier, setQualityTier] = useState<QualityTier>('balanced')
  const [minMatchScore, setMinMatchScore] = useState<number>(3) // Default 3 for call leads
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [status, setStatus] = useState<AppStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [signedUrl, setSignedUrl] = useState<string>('')
  const [leadCount, setLeadCount] = useState<number>(0)
  const [qualitySummary, setQualitySummary] = useState<QualitySummary | null>(null)
  const [fieldCoverage, setFieldCoverage] = useState<FieldCoverage | null>(null)
  const [fieldCoverageExpanded, setFieldCoverageExpanded] = useState(false)
  const [buildingDetails, setBuildingDetails] = useState<BuildingDetails | null>(null)
  const [pollElapsed, setPollElapsed] = useState(0)
  const [pollAttempts, setPollAttempts] = useState(0)
  const [nextPollSeconds, setNextPollSeconds] = useState(DEFAULT_POLL_SECONDS)
  const [suppressionInfo, setSuppressionInfo] = useState<SuppressionInfo | null>(null)
  const [qualityGateInfo, setQualityGateInfo] = useState<QualityGateInfo | null>(null)
  
  const pollStartRef = useRef<number>(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ─────────────────────────────────────────────────────────────────────────
  // Check auth status on mount
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' })
        if (res.ok) {
          setAuthStatus('authenticated')
        } else {
          setAuthStatus('unauthenticated')
        }
      } catch {
        setAuthStatus('unauthenticated')
      }
    }
    checkAuth()
  }, [])

  // ─────────────────────────────────────────────────────────────────────────
  // Login handler
  // ─────────────────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoginLoading(true)
    setLoginError('')

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ passcode }),
      })

      if (res.ok) {
        setAuthStatus('authenticated')
        setPasscode('')
      } else {
        const data = await res.json()
        setLoginError(getErrorMessage(data.error, 'Invalid passcode'))
      }
    } catch {
      setLoginError('Network error. Please try again.')
    } finally {
      setLoginLoading(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Load export history
  // ─────────────────────────────────────────────────────────────────────────
  const loadExports = async () => {
    setExportsLoading(true)
    setExportsError('')

    try {
      const res = await fetch('/api/exports/list', { credentials: 'include' })
      const data = await res.json()

      if (res.ok && data.ok) {
        setExports(data.exports || [])
      } else {
        setExportsError(getErrorMessage(data.error, 'Failed to load exports'))
      }
    } catch {
      setExportsError('Network error loading exports')
    } finally {
      setExportsLoading(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Regenerate signed URL for an export
  // ─────────────────────────────────────────────────────────────────────────
  const regenerateSignedUrl = async (exportId: string) => {
    setRegeneratingIds(prev => new Set(prev).add(exportId))

    try {
      const res = await fetch('/api/exports/signed-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ exportId }),
      })

      const data = await res.json()

      if (res.ok && data.ok && data.signedUrl) {
        // Open in new tab
        window.open(data.signedUrl, '_blank')
      } else {
        alert(getErrorMessage(data.error, 'Failed to generate download link'))
      }
    } catch {
      alert('Network error. Please try again.')
    } finally {
      setRegeneratingIds(prev => {
        const next = new Set(prev)
        next.delete(exportId)
        return next
      })
    }
  }

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  // Use a ref to break the circular dependency between pollStatus and scheduleNextPoll
  const pollStatusRef = useRef<(details: BuildingDetails) => Promise<void>>()

  const scheduleNextPoll = useCallback((details: BuildingDetails, delaySeconds: number) => {
    pollTimerRef.current = setTimeout(() => {
      pollStatusRef.current?.(details)
    }, delaySeconds * 1000)
  }, [])

  const pollStatus = useCallback(async (details: BuildingDetails) => {
    const elapsed = Date.now() - pollStartRef.current
    setPollElapsed(Math.floor(elapsed / 1000))

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
          exportId: details.exportId,
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
        // Set suppression info if present
        if (data.suppressedCount > 0) {
          setSuppressionInfo({
            suppressedCount: data.suppressedCount,
            suppressedStates: data.suppressedStates || [],
          })
        }
        // Set quality gate info if present
        if (data.qualityGate) {
          setQualityGateInfo(data.qualityGate)
        }
        setStatus('success')
        setBuildingDetails(null)
        return
      }

      // Still building - continue polling with server-recommended backoff
      if (res.status === 202 && data.error?.code === 'provider_building') {
        const serverPollAttempts = data.error?.details?.pollAttempts ?? 0
        const serverNextPoll = data.error?.details?.nextPollSeconds ?? DEFAULT_POLL_SECONDS
        
        setPollAttempts(serverPollAttempts)
        setNextPollSeconds(serverNextPoll)
        
        // Schedule next poll with exponential backoff from server
        scheduleNextPoll(details, serverNextPoll)
        return
      }

      // Building long - exceeded max interactive attempts, moved to background processing
      if (res.status === 202 && data.status === 'building_long') {
        stopPolling()
        setPollAttempts(data.pollAttempts ?? MAX_POLL_ATTEMPTS)
        setNextPollSeconds(data.nextPollSeconds ?? 300)
        setStatus('building_long')
        // Keep buildingDetails for display but stop active polling
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
  }, [stopPolling, scheduleNextPoll])

  // Keep the ref up to date with the latest pollStatus
  useEffect(() => {
    pollStatusRef.current = pollStatus
  }, [pollStatus])

  const startPolling = useCallback((details: BuildingDetails) => {
    setBuildingDetails(details)
    pollStartRef.current = Date.now()
    setPollElapsed(0)
    setPollAttempts(0)
    setNextPollSeconds(DEFAULT_POLL_SECONDS)
    setStatus('building')

    // Poll immediately - subsequent polls will use server-recommended backoff
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
    setSuppressionInfo(null)
    setQualityGateInfo(null)
    setPollAttempts(0)
    setNextPollSeconds(DEFAULT_POLL_SECONDS)

    try {
      // Build request body - only include minMatchScore for call useCase if it differs from default
      const requestBody: Record<string, unknown> = {
        leadRequest: leadRequest.trim(),
        zipCodes: zipCodes,
        leadScope: scope.toLowerCase(),
        useCase: useCase,
        qualityTier: qualityTier,
      }
      // Include minMatchScore if useCase is 'call' (explicit control) or if user changed it
      if (useCase === 'call') {
        requestBody.minMatchScore = minMatchScore
      }
      
      const res = await fetch('/api/leads/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
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
          exportId: data.error.details?.exportId,
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
      // Set suppression info if present
      if (data.suppressedCount > 0) {
        setSuppressionInfo({
          suppressedCount: data.suppressedCount,
          suppressedStates: data.suppressedStates || [],
        })
      }
      // Set quality gate info if present
      if (data.qualityGate) {
        setQualityGateInfo(data.qualityGate)
      }
      setStatus('success')
    } catch {
      setErrorMessage('Failed to generate leads')
      setStatus('error')
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Format date for display
  // ─────────────────────────────────────────────────────────────────────────
  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleString()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render auth checking state
  // ─────────────────────────────────────────────────────────────────────────
  if (authStatus === 'checking') {
    return (
      <div className="app">
        <div className="loading">Checking authentication...</div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render login screen
  // ─────────────────────────────────────────────────────────────────────────
  if (authStatus === 'unauthenticated') {
    return (
      <div className="app">
        <header className="header">
          <h1>Lead Request</h1>
        </header>
        <main className="main">
          <div className="login-container">
            <h2>Enter Passcode</h2>
            <form onSubmit={handleLogin}>
              <div className="form-group">
                <input
                  type="password"
                  placeholder="Passcode"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  autoFocus
                />
              </div>
              {loginError && <div className="error">{loginError}</div>}
              <button
                type="submit"
                className="btn-primary"
                disabled={loginLoading || !passcode.trim()}
              >
                {loginLoading ? 'Logging in...' : 'Login'}
              </button>
            </form>
          </div>
        </main>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render authenticated app
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <header className="header">
        <h1>Lead Request</h1>
        <button
          className="btn-history"
          onClick={() => {
            setShowHistory(!showHistory)
            if (!showHistory && exports.length === 0) {
              loadExports()
            }
          }}
        >
          {showHistory ? 'Hide History' : 'Export History'}
        </button>
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
            <p className="preset-helper">
              {useCase === 'call' && 'Requires phone; excludes DNC for B2C; ranks by match accuracy.'}
              {useCase === 'email' && 'Requires Valid(Esp) email + recent activity; ranks by match accuracy.'}
              {useCase === 'both' && 'Keeps best phone or email; excludes DNC for B2C calls.'}
            </p>
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

          <div className="form-group">
            <label htmlFor="qualityTier">Lead Heat</label>
            <select
              id="qualityTier"
              value={qualityTier}
              onChange={(e) => setQualityTier(e.target.value as QualityTier)}
            >
              <option value="hot">🔥 Hot Leads (High intent only)</option>
              <option value="balanced">⚖️ Balanced (High + Medium intent)</option>
              <option value="scale">📈 Scale (More volume)</option>
            </select>
            <p className="preset-helper">
              {qualityTier === 'hot' && 'Best for dialers: High-intent leads, stricter match accuracy, sorted by quality score.'}
              {qualityTier === 'balanced' && 'Default: Mix of high and medium intent leads for steady pipeline.'}
              {qualityTier === 'scale' && 'For volume campaigns: Includes medium and low intent, broader reach.'}
            </p>
          </div>

          {/* Advanced Options - only shown for Call Leads */}
          {useCase === 'call' && (
            <div className="advanced-options">
              <button
                type="button"
                className="advanced-toggle"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? '▼' : '▶'} Advanced Options
              </button>
              
              {showAdvanced && (
                <div className="advanced-content">
                  <div className="form-group">
                    <label htmlFor="minMatchScore">Minimum Match Score</label>
                    <select
                      id="minMatchScore"
                      value={minMatchScore}
                      onChange={(e) => setMinMatchScore(parseInt(e.target.value, 10))}
                    >
                      <option value="3">3 - High only (ADDRESS+EMAIL)</option>
                      <option value="2">2 - Medium+ (NAME+ADDRESS)</option>
                      <option value="1">1 - Low+ (any match)</option>
                      <option value="0">0 - No filtering</option>
                    </select>
                    <p className="preset-helper">
                      Filter leads by match accuracy. Higher scores = more reliable contact data.
                      Default is 3 (High) for best dialer results.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            className="btn-primary"
            onClick={handleGenerate}
            disabled={status === 'loading' || status === 'building' || status === 'building_long'}
          >
            {status === 'loading' ? 'Generating...' : (status === 'building' || status === 'building_long') ? 'Building...' : 'Generate Leads'}
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
                Poll {pollAttempts}/{MAX_POLL_ATTEMPTS} • Next check in {nextPollSeconds}s
              </p>
              <p style={{ fontSize: '0.75rem', color: '#999', marginTop: '0.25rem' }}>
                ID: {buildingDetails.audienceId.slice(0, 8)}...
              </p>
            </div>
          )}

          {status === 'building_long' && buildingDetails && (
            <div className="building-long-notice">
              <p><strong>Still building in provider</strong></p>
              <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                This is taking longer than usual. We'll keep checking in the background every 5 minutes.
              </p>
              <p style={{ fontSize: '0.875rem', marginTop: '0.5rem' }}>
                You can close this page — check <strong>Export History</strong> later to download your leads.
              </p>
              <p style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.75rem' }}>
                Export ID: {buildingDetails.exportId?.slice(0, 8) || buildingDetails.audienceId.slice(0, 8)}...
              </p>
              <button
                className="btn-secondary"
                style={{ marginTop: '1rem' }}
                onClick={() => {
                  setStatus('idle')
                  setBuildingDetails(null)
                }}
              >
                Start New Request
              </button>
            </div>
          )}

          {status === 'success' && signedUrl && (
            <div className="success">
              {/* Quality Gate delivery info */}
              {qualityGateInfo ? (
                <>
                  <p className="delivery-summary">
                    Delivered <strong>{qualityGateInfo.deliveredCount}</strong> of {qualityGateInfo.requestedCount} requested
                    <span className="quality-gate-tier"> (Quality Gate: {qualityTier === 'hot' ? '🔥 Hot' : qualityTier === 'balanced' ? '⚖️ Balanced' : '📈 Scale'} ≥{qualityGateInfo.minQualityScoreUsed})</span>
                  </p>
                  {qualityGateInfo.warning && (
                    <p className="quality-gate-warning">
                      ⚠️ {qualityGateInfo.warning}
                    </p>
                  )}
                  <div className="quality-gate-stats">
                    <span className="stat">Avg Score: <strong>{qualityGateInfo.avgQualityScore}</strong></span>
                    <span className="stat">P90 Score: <strong>{qualityGateInfo.p90QualityScore}</strong></span>
                    <span className="stat">Wireless: <strong>{qualityGateInfo.pctWireless}%</strong></span>
                    <span className="stat">With Address: <strong>{qualityGateInfo.pctWithAddress}%</strong></span>
                  </div>
                </>
              ) : (
                <p>Generated {leadCount} leads</p>
              )}
              {suppressionInfo && suppressionInfo.suppressedCount > 0 && (
                <p className="suppression-notice">
                  {suppressionInfo.suppressedCount} lead{suppressionInfo.suppressedCount !== 1 ? 's' : ''} suppressed
                  {suppressionInfo.suppressedStates.length > 0 && (
                    <> (states: {suppressionInfo.suppressedStates.join(', ')})</>  
                  )}
                </p>
              )}
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
                    {qualitySummary.filteredInvalidEmailEsp > 0 && (
                      <li>Filtered (not Valid Esp): {qualitySummary.filteredInvalidEmailEsp}</li>
                    )}
                    {qualitySummary.filteredEmailTooOld > 0 && (
                      <li>Filtered (stale email): {qualitySummary.filteredEmailTooOld}</li>
                    )}
                    {qualitySummary.filteredDnc > 0 && (
                      <li>Filtered (DNC): {qualitySummary.filteredDnc}</li>
                    )}
                    {qualitySummary.filteredLowMatchScore > 0 && (
                      <li>Filtered (low match score): {qualitySummary.filteredLowMatchScore}</li>
                    )}
                    {qualitySummary.missingNameOrAddressCount > 0 && (
                      <li>Missing name/address: {qualitySummary.missingNameOrAddressCount}</li>
                    )}
                  </ul>
                  {qualitySummary.matchByTier && (
                    <div className="match-tier-summary">
                      <h5>Match Accuracy</h5>
                      <div className="tier-badges">
                        <span className="tier-badge tier-high" title="Address + Email match">
                          High: {qualitySummary.matchByTier.high}
                        </span>
                        <span className="tier-badge tier-medium" title="Name + Address match">
                          Med: {qualitySummary.matchByTier.medium}
                        </span>
                        <span className="tier-badge tier-low" title="Other match methods">
                          Low: {qualitySummary.matchByTier.low}
                        </span>
                      </div>
                    </div>
                  )}
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

        {/* ────────────────────────────────────────────────────────────────── */}
        {/* Export History Panel                                              */}
        {/* ────────────────────────────────────────────────────────────────── */}
        {showHistory && (
          <div className="export-history">
            <div className="export-history-header">
              <h3>Export History</h3>
              <button
                className="btn-refresh"
                onClick={loadExports}
                disabled={exportsLoading}
              >
                {exportsLoading ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {exportsError && <div className="error">{exportsError}</div>}

            {!exportsLoading && exports.length === 0 && (
              <p className="no-exports">No exports yet</p>
            )}

            {exports.length > 0 && (
              <div className="export-list">
                {exports.map((exp) => (
                  <div key={exp.id} className={`export-item status-${exp.status}`}>
                    <div className="export-item-header">
                      <span className="export-date">{formatDate(exp.createdAt)}</span>
                      <span className={`export-status status-${exp.status}`}>
                        {exp.status === 'building_long' ? 'Building (background)' : exp.status}
                      </span>
                    </div>
                    <div className="export-item-details">
                      <div className="export-request">{exp.leadRequest}</div>
                      <div className="export-meta">
                        ZIPs: {exp.zipCodes.slice(0, 3).join(', ')}
                        {exp.zipCodes.length > 3 && ` +${exp.zipCodes.length - 3} more`}
                        {exp.kept !== null && ` • ${exp.kept} leads`}
                      </div>
                    </div>
                    {exp.status === 'success' && exp.hasFile && (
                      <button
                        className="btn-download-small"
                        onClick={() => regenerateSignedUrl(exp.id)}
                        disabled={regeneratingIds.has(exp.id)}
                      >
                        {regeneratingIds.has(exp.id) ? 'Getting...' : 'Get Download Link'}
                      </button>
                    )}
                    {exp.status === 'error' && exp.errorMessage && (
                      <div className="export-error">{exp.errorMessage}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// Wrap App in ErrorBoundary for production resilience
function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

export default AppWithErrorBoundary
