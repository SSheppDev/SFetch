import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Database, AlertCircle, Loader2, User, CheckCircle2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useOrg } from '@/lib/orgContext'
import { type AvailableOrg, type AvailableOrgsResponse } from '@/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'

type PageState =
  | { status: 'loading' }
  | { status: 'cli-error'; message: string }
  | { status: 'no-orgs' }
  | { status: 'ready'; orgs: AvailableOrg[] }

export default function Onboarding() {
  const navigate = useNavigate()
  const { refresh: refreshOrgs, setActiveOrgId, orgs: registeredOrgs } = useOrg()
  const [pageState, setPageState] = useState<PageState>({ status: 'loading' })
  const [registering, setRegistering] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<AvailableOrgsResponse>('/orgs/available')
      .then((res) => {
        if (!res.mounted) {
          setPageState({
            status: 'cli-error',
            message:
              'The ~/.sfdx directory is not accessible. Make sure it is mounted into the Docker container.',
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
            'Could not reach the API or read ~/.sfdx. Check that Docker is running.',
        })
      })
  }, [])

  async function handleRegister(org: AvailableOrg) {
    const key = org.alias ?? org.username
    setRegistering(org.orgId)
    try {
      await api.post('/orgs', { aliasOrUsername: key })
      await refreshOrgs()
      await setActiveOrgId(org.orgId)
      navigate('/objects', { replace: true })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to register org',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setRegistering(null)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[var(--color-background)] px-4 py-12">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-[var(--color-primary)] flex items-center justify-center">
          <Database className="h-6 w-6 text-white" />
        </div>
        <h1 className="text-2xl font-bold text-[var(--color-foreground)]">
          {registeredOrgs.length > 0 ? 'Add another Salesforce org' : 'Welcome to sfetch'}
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          {registeredOrgs.length > 0
            ? 'Pick another org to register. Each org gets its own Postgres schema.'
            : 'Connect a Salesforce org to get started'}
        </p>
      </div>

      {pageState.status === 'loading' && (
        <div className="flex items-center gap-2 text-[var(--color-muted-foreground)]">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Checking for Salesforce orgs…</span>
        </div>
      )}

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
              No Salesforce orgs were found in ~/.sfdx. Authenticate at least one org first.
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

      {pageState.status === 'ready' && (
        <div className="w-full max-w-md space-y-3">
          <p className="text-sm text-center text-[var(--color-muted-foreground)]">
            Select an org to register:
          </p>
          {pageState.orgs.map((org) => {
            const label = org.alias ?? org.username
            const isRegistered = org.registered
            const isThisRegistering = registering === org.orgId
            return (
              <button
                key={org.orgId}
                onClick={() => !isRegistered && handleRegister(org)}
                disabled={registering !== null || isRegistered}
                className="w-full text-left rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 hover:border-[var(--color-primary)] hover:bg-[var(--color-accent)] transition-colors disabled:opacity-60 disabled:pointer-events-none focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-[var(--color-secondary)] flex items-center justify-center flex-shrink-0">
                      {isThisRegistering ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--color-primary)]" />
                      ) : isRegistered ? (
                        <CheckCircle2 className="h-4 w-4 text-[var(--color-primary)]" />
                      ) : (
                        <User className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-[var(--color-foreground)]">
                        {label}
                      </p>
                      <p className="text-xs text-[var(--color-muted-foreground)]">{org.username}</p>
                      <p className="text-[10px] font-mono text-[var(--color-muted-foreground)] mt-0.5">
                        {org.orgId}
                      </p>
                    </div>
                  </div>
                  {isRegistered && (
                    <Badge variant="secondary" className="text-xs">
                      Registered
                    </Badge>
                  )}
                </div>
              </button>
            )
          })}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1"
              onClick={() => window.location.reload()}
              disabled={registering !== null}
            >
              Refresh org list
            </Button>
            {registeredOrgs.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="flex-1"
                onClick={() => navigate('/objects')}
                disabled={registering !== null}
              >
                Back to app
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
