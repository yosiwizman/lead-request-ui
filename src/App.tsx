import { useState } from 'react'
import './App.css'
import { generateMockLeads, downloadCSV } from './services/leadService'
import type { Lead } from './types'

type Scope = 'Residential' | 'Commercial' | 'Both'

function App() {
  const [leadRequest, setLeadRequest] = useState('')
  const [zipCodes, setZipCodes] = useState('')
  const [scope, setScope] = useState<Scope>('Residential')
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [leads, setLeads] = useState<Lead[]>([])
  const [errorMessage, setErrorMessage] = useState('')

  const handleGenerate = async () => {
    if (!leadRequest.trim() || !zipCodes.trim()) {
      setErrorMessage('Please fill in both fields')
      setStatus('error')
      return
    }

    setStatus('loading')
    setErrorMessage('')

    try {
      const zips = zipCodes.split(',').map(z => z.trim()).filter(Boolean)
      const generatedLeads = await generateMockLeads(leadRequest, zips, scope)
      setLeads(generatedLeads)
      setStatus('success')
    } catch {
      setErrorMessage('Failed to generate leads')
      setStatus('error')
    }
  }

  const handleDownload = () => {
    downloadCSV(leads)
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

          {status === 'success' && leads.length > 0 && (
            <div className="success">
              <p>Generated {leads.length} leads</p>
              <button className="btn-download" onClick={handleDownload}>
                Download CSV
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
