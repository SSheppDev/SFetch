import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, AlertCircle, Loader2, User } from 'lucide-react'
import { api } from '@/lib/api'
import { type Org } from '@/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'

interface OrgsResponse {
  mounted: boolean
  orgs: Org[]
}

type PageState =
  | { status: 'loading' }
  | { status: 'cli-error'; message: string }
  | { status: 'no-orgs' }
  | { status: 'ready'; orgs: Org[] }

export default function Onboarding() {
  const navigate = useNavigate()
  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [selecting, setSelecting] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<OrgsResponse>('/orgs')
      .then((res) => {
        if (!res.mounted) {
          setPageState({
            status: 'cli-error',
            message:
              'The ~/.sf directory is not accessible. Make sure it is mounted into the Docker container.',
          })
          return
        }
        if (res.orgs.length === 0) {
          setPageState({ status: 'no-orgs' })
          return
        }
        setPageState({ status: 'ready', orgs: res.orgs })
      })
      .catch(() => {
        setPageState({
          status: 'cli-error',
          message:
            'Could not reach the API or read ~/.sf. Check that Docker is running.',
        })
      })
  }, [])

  async function handleSelectOrg(alias: string) {
    setSelecting(alias)
    try {
      await api.post('/orgs/active', { alias })
      navigate('/objects', { replace: true })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to set active org',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSelecting(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--color-background)] px-4">
      {/* Header */}
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-[var(--color-primary)] flex items-center justify-center">
          <Database className="h-6 w-6 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-[var(--color-foreground)]">Welcome to sfetch</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Connect a Salesforce org to get started
        </p>
      </div>

      {/* Loading */}
      {pageState.status === 'loading' && (
        <div className="flex items-center gap-2 text-[var(--color-muted-foreground)]">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Checking for Salesforce orgs…</span>
        </div>
      )}

      {/* CLI not mounted / error */}
      {pageState.status === 'cli-error' && (
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-[var(--color-destructive)]" />
              <CardTitle className="text-base">Salesforce CLI not found</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-[var(--color-muted-foreground)]">{pageState.message}</p>
            <div className="rounded-md bg-[var(--color-muted)] px-3 py-2">
              <p className="text-xs font-medium text-[var(--color-foreground)] mb-1">
                To authenticate with Salesforce, run:
              </p>
              <code className="text-xs font-mono text-[var(--color-foreground)]">
                sf org login web --alias my-org
              </code>
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              After authenticating, restart Docker with{' '}
              <code className="font-mono">docker compose restart</code> and refresh this page.
            </p>
          </CardContent>
        </Card>
      )}

      {/* No orgs found */}
      {pageState.status === 'no-orgs' && (
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-amber-500" />
              <CardTitle className="text-base">No orgs authenticated</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No Salesforce orgs were found in ~/.sf. Authenticate at least one org first.
            </p>
            <div className="rounded-md bg-[var(--color-muted)] px-3 py-2">
              <p className="text-xs font-medium text-[var(--color-foreground)] mb-1">
                In your terminal, run:
              </p>
              <code className="text-xs font-mono text-[var(--color-foreground)]">
                sf org login web --alias my-org
              </code>
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Then refresh this page — no restart needed.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Org picker */}
      {pageState.status === 'ready' && (
        <div className="w-full max-w-md space-y-3">
          <p className="text-sm text-center text-[var(--color-muted-foreground)]">
            Select an org to connect:
          </p>
          {pageState.orgs.map((org) => (
            <button
              key={org.alias}
              onClick={() => handleSelectOrg(org.alias)}
              disabled={selecting !== null}
              className="w-full text-left rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 hover:border-[var(--color-primary)] hover:bg-[var(--color-accent)] transition-colors disabled:opacity-60 disabled:pointer-events-none focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-[var(--color-secondary)] flex items-center justify-center flex-shrink-0">
                    {selecting === org.alias ? (
                      <Loader2 className="h-4 w-4 animate-spin text-[var(--color-primary)]" />
                    ) : (
                      <User className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--color-foreground)]">
                      {org.alias}
                    </p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">{org.username}</p>
                  </div>
                </div>
                <Badge variant="secondary" className="text-xs">
                  {org.orgType}
                </Badge>
              </div>
            </button>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => window.location.reload()}
            disabled={selecting !== null}
          >
            Refresh org list
          </Button>
        </div>
      )}
    </div>
  )
}
