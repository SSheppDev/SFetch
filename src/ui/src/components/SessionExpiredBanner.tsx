import { useEffect, useState } from 'react'
import { SF_SESSION_EXPIRED_EVENT } from '@/lib/api'
import { Button } from '@/components/ui/button'

const REFRESH_COMMAND = 'npm run export-tokens'

export function SessionExpiredBanner() {
  const [visible, setVisible] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const handler = () => setVisible(true)
    window.addEventListener(SF_SESSION_EXPIRED_EVENT, handler)
    return () => window.removeEventListener(SF_SESSION_EXPIRED_EVENT, handler)
  }, [])

  if (!visible) return null

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(REFRESH_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard API unavailable — ignore
    }
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-black px-4 py-3 shadow-md flex items-center justify-between gap-4">
      <div className="text-sm flex items-center gap-2 flex-wrap">
        <strong>Salesforce tokens need refresh.</strong>
        <span>Run this in your sfetch directory, then reload:</span>
        <code
          className="px-2 py-0.5 bg-black/15 rounded font-mono text-xs cursor-pointer hover:bg-black/25"
          onClick={copyCommand}
          title="Click to copy"
        >
          {copied ? 'copied!' : REFRESH_COMMAND}
        </code>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="default" size="sm" onClick={() => window.location.reload()}>
          Reload
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setVisible(false)}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
