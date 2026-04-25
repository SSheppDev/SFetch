import { useEffect, useState } from 'react'
import { Loader2, GripVertical } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { api } from '@/lib/api'
import { type SyncOrderItem } from '@/types'
import { toast } from '@/components/ui/use-toast'

// ---------------------------------------------------------------------------
// Single draggable row
// ---------------------------------------------------------------------------

function SortableRow({ item, index }: { item: SyncOrderItem; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.objectApiName })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 px-4 py-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] touch-none"
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <span className="w-6 text-xs tabular-nums text-[var(--color-muted-foreground)] text-right select-none">
        {index + 1}
      </span>

      <span className="font-mono text-sm text-[var(--color-foreground)]">
        {item.objectApiName}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SyncOrder() {
  const [items, setItems] = useState<SyncOrderItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const sensors = useSensors(useSensor(PointerSensor))

  useEffect(() => {
    api
      .get<SyncOrderItem[]>('/sync-order')
      .then(setItems)
      .catch(() => toast({ variant: 'destructive', title: 'Failed to load sync order' }))
      .finally(() => setLoading(false))
  }, [])

  async function saveOrder(ordered: SyncOrderItem[]) {
    setSaving(true)
    try {
      const payload = ordered.map((item, i) => ({
        objectApiName: item.objectApiName,
        syncOrder: i,
      }))
      await api.put('/sync-order', payload)
      setItems(payload)
    } catch {
      toast({ variant: 'destructive', title: 'Failed to save sync order' })
    } finally {
      setSaving(false)
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = items.findIndex((i) => i.objectApiName === active.id)
    const newIndex = items.findIndex((i) => i.objectApiName === over.id)
    const reordered = arrayMove(items, oldIndex, newIndex)

    // Optimistic update
    setItems(reordered)
    void saveOrder(reordered)
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--color-muted-foreground)]" />
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Sync Order</h1>
        <p className="text-sm text-[var(--color-muted-foreground)] mt-4">
          No objects are enabled. Enable objects on the Objects page first.
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4 max-w-xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Sync Order</h1>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
            Drag to set the order objects sync in. Objects at the top sync first.
          </p>
        </div>
        {saving && <Loader2 className="h-4 w-4 animate-spin text-[var(--color-muted-foreground)] mt-1" />}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={items.map((i) => i.objectApiName)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-1.5">
            {items.map((item, index) => (
              <SortableRow key={item.objectApiName} item={item} index={index} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}
