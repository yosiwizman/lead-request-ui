import type { Lead } from '../types'

const FIRST_NAMES = ['John', 'Jane', 'Mike', 'Sarah', 'David', 'Emily', 'Chris', 'Lisa', 'Tom', 'Anna']
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez']
const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Maple Dr', 'Cedar Ln', 'Elm St', 'Park Ave', 'Lake Rd']
const CITIES = ['Miami', 'Tampa', 'Orlando', 'Jacksonville', 'Fort Lauderdale']

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function generatePhone(): string {
  return `(${Math.floor(Math.random() * 900) + 100}) ${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 9000) + 1000}`
}

function generateEmail(firstName: string, lastName: string): string {
  const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']
  return `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${randomItem(domains)}`
}

export async function generateMockLeads(
  request: string,
  zips: string[],
  scope: 'Residential' | 'Commercial' | 'Both'
): Promise<Lead[]> {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 800))

  const leads: Lead[] = []
  const count = Math.floor(Math.random() * 10) + 5 // 5-14 leads

  for (let i = 0; i < count; i++) {
    const firstName = randomItem(FIRST_NAMES)
    const lastName = randomItem(LAST_NAMES)
    const leadType = scope === 'Both' 
      ? randomItem(['Residential', 'Commercial']) 
      : scope

    leads.push({
      first_name: firstName,
      last_name: lastName,
      address: `${Math.floor(Math.random() * 9999) + 1} ${randomItem(STREETS)}`,
      city: randomItem(CITIES),
      state: 'FL',
      zip: randomItem(zips),
      phone: generatePhone(),
      email: generateEmail(firstName, lastName),
      lead_type: leadType,
      tags: request,
      source: 'lead-request-ui'
    })
  }

  return leads
}

export function downloadCSV(leads: Lead[]): void {
  const headers = ['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'lead_type', 'tags', 'source']
  
  const csvContent = [
    headers.join(','),
    ...leads.map(lead => 
      headers.map(h => `"${String(lead[h as keyof Lead]).replace(/"/g, '""')}"`).join(',')
    )
  ].join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `leads_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
