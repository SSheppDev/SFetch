import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { type Field } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from '@/components/ui/use-toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface PendingChange {
  field: Field
  enabling: boolean
}

export default function Fields() {
  const { name } = useParams<{ name: string }>()
  const [fields, setFields] = useState<Field[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null)
  const [savingField, setSavingField] = useState<string | null>(null)

  const fetchFields = useCallback(async () => {
    if (!name) return
    try {
      const data = await api.get<Field[]>(`/objects/${name}/fields`)
      setFields(data)
    } catch {
      toast({ variant: 'destructive', title: 'Failed to load fields' })
    } finally {
      setLoading(false)
    }
  }, [name])

  useEffect(() => {
    fetchFields()
  }, [fetchFields])

  function handleCheckChange(field: Field, checked: boolean) {
    setPendingChange({ field, enabling: checked })
  }

  async function confirmChange() {
    if (!pendingChange || !name) return
    const { field, enabling } = pendingChange
    setSavingField(field.apiName)
    setPendingChange(null)
    try {
      await api.patch(`/objects/${name}/fields/${field.apiName}`, { enabled: enabling })
      setFields((prev) =>
        prev.map((f) => (f.apiName === field.apiName ? { ...f, enabled: enabling } : f))
      )
      toast({
        title: enabling ? `${field.label} re-enabled` : `${field.label} removed`,
        description: enabling
          ? 'Column will be backfilled on the next full sync.'
          : 'Column dropped from the local database.',
      })
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to update field',
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSavingField(null)
    }
  }

  async function handleSelectAll() {
    const disabled = fields.filter((f) => !f.enabled)
    for (const f of disabled) {
      setSavingField(f.apiName)
      try {
        await api.patch(`/objects/${name}/fields/${f.apiName}`, { enabled: true })
        setFields((prev) => prev.map((x) => (x.apiName === f.apiName ? { ...x, enabled: true } : x)))
      } catch {
        // continue
      }
    }
    setSavingField(null)
    toast({ title: 'All fields enabled' })
  }

  async function handleDeselectAll() {
    const enabled = fields.filter((f) => f.enabled)
    for (const f of enabled) {
      setSavingField(f.apiName)
      try {
        await api.patch(`/objects/${name}/fields/${f.apiName}`, { enabled: false })
        setFields((prev) => prev.map((x) => (x.apiName === f.apiName ? { ...x, enabled: false } : x)))
      } catch {
        // continue
      }
    }
    setSavingField(null)
    toast({ title: 'All fields disabled' })
  }

  const objectLabel = name ?? ''
  const enabledCount = fields.filter((f) => f.enabled).length

  return (
    <div className="p-6 space-y-5">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)]">
        <Link to="/objects" className="hover:text-[var(--color-foreground)] transition-colors">
          Objects
        </Link>
        <ChevronRight className="h-4 w-4" />
        <span className="text-[var(--color-foreground)] font-medium">{objectLabel}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{objectLabel} Fields</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
            {enabledCount} of {fields.length} fields enabled
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleSelectAll} disabled={loading}>
            Select all
          </Button>
          <Button variant="outline" size="sm" onClick={handleDeselectAll} disabled={loading}>
            Deselect all
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] bg-[var(--color-muted)]">
              <th className="text-center w-12 px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                On
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                Field Label
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                API Name
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                SF Type
              </th>
              <th className="text-left px-4 py-2.5 font-medium text-[var(--color-muted-foreground)]">
                PG Type
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="py-12 text-center">
                  <Loader2 className="h-5 w-5 animate-spin mx-auto text-[var(--color-muted-foreground)]" />
                </td>
              </tr>
            )}
            {!loading && fields.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="py-12 text-center text-sm text-[var(--color-muted-foreground)]"
                >
                  No fields found for this object
                </td>
              </tr>
            )}
            {fields.map((field) => (
              <tr
                key={field.apiName}
                className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-accent)] transition-colors"
              >
                <td className="px-4 py-3 text-center">
                  {savingField === field.apiName ? (
                    <Loader2 className="h-4 w-4 animate-spin mx-auto text-[var(--color-muted-foreground)]" />
                  ) : (
                    <Checkbox
                      checked={field.enabled}
                      onCheckedChange={(checked) =>
                        handleCheckChange(field, checked === true)
                      }
                      disabled={savingField !== null}
                      aria-label={`${field.enabled ? 'Disable' : 'Enable'} ${field.label}`}
                    />
                  )}
                </td>
                <td className="px-4 py-3 font-medium text-[var(--color-foreground)]">
                  {field.label}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--color-muted-foreground)]">
                  {field.apiName}
                </td>
                <td className="px-4 py-3">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {field.sfType}
                  </Badge>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--color-muted-foreground)]">
                  {field.pgType}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Confirm dialog */}
      <Dialog
        open={pendingChange !== null}
        onOpenChange={(open) => !open && setPendingChange(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingChange?.enabling
                ? `Re-add ${pendingChange.field.label}?`
                : `Remove ${pendingChange?.field.label} from sync?`}
            </DialogTitle>
            <DialogDescription>
              {pendingChange?.enabling
                ? 'The column will be added back and backfilled on the next full sync.'
                : 'This will drop the column from the local database immediately.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingChange(null)}>
              Cancel
            </Button>
            <Button
              variant={pendingChange?.enabling ? 'default' : 'destructive'}
              onClick={confirmChange}
            >
              {pendingChange?.enabling ? 'Re-add field' : 'Remove field'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
