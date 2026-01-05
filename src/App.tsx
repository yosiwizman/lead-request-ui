import { useState } from 'react'
import './App.css'

type Scope = 'Residential' | 'Commercial' | 'Both'

function App() {
  const [leadRequest, setLeadRequest] = useState('')
  const [zipCodes, setZipCodes] = useState('')
  const [scope, setScope] = useState<Scope>('Residential')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [signedUrl, setSignedUrl] = useState<string>('')
  const [leadCount, setLeadCount] = useState<number>(0)

  const handleGenerate = async () => {
    if (!leadRequest.trim() || !zipCodes.trim()) {
      setErrorMessage('Please fill in both fields')
      setStatus('error')
      return
    }

    setStatus('loading')
    setErrorMessage('')
    setSignedUrl('')
    setLeadCount(0)

    try {
      const res = await fetch('/api/leads/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadRequest: leadRequest.trim(),
          zipCodes: zipCodes,
          leadScope: scope.toLowerCase(), // 'residential' | 'commercial' | 'both'
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.ok) {
        const msg = data?.error?.message || 'Failed to generate leads'
        setErrorMessage(msg)
        setStatus('error')
        return
      }

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
            disabled={status === 'loading'}
          >
            {status === 'loading' ? 'Generating...' : 'Generate Leads'}
          </button>
        </div>

        <div className="results">
          {status === 'error' && (
            <div className="error">{errorMessage}</div>
          )}

          {status === 'loading' && (
            <div className="loading">Generating leads...</div>
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