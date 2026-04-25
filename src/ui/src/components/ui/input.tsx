import { type InputHTMLAttributes } from 'react'

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`flex h-9 w-full rounded-md border border-[var(--color-border)] bg-transparent px-3 py-1 text-sm text-[var(--color-foreground)] shadow-sm transition-colors placeholder:text-[var(--color-muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    />
  )
}
