import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

export type InputProps = React.ComponentProps<"input"> & {
  label?: string
  error?: string
  containerClassName?: string
}

function Input({
  className,
  type,
  label,
  error,
  id,
  containerClassName,
  ...props
}: InputProps) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  const errorId = error ? `${inputId}-error` : undefined

  return (
    <div className={cn("flex w-full max-w-[342px] flex-col gap-2", containerClassName)}>
      {label ? (
        <label
          htmlFor={inputId}
          className="flex h-5 w-full items-center font-sans text-base leading-none text-label"
        >
          {label}
        </label>
      ) : null}
      <InputPrimitive
        id={inputId}
        type={type}
        data-slot="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={cn(
          "h-11 w-full min-w-0 rounded-[10px] border border-border bg-white px-2.5 font-sans text-base text-foreground outline-none transition-colors",
          "placeholder:text-placeholder",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
          type === "password" &&
            "placeholder:font-[family-name:var(--font-sans)] placeholder:text-[15px] placeholder:text-password-placeholder",
          className
        )}
        {...props}
      />
      {error ? (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { Input }
