import { useLayoutEffect, useRef } from 'react'

type Props = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  ariaLabel?: string
}

export default function AutoGrowTextarea(props: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    element.style.height = '0px'
    element.style.height = `${Math.max(46, element.scrollHeight + 2)}px`
  }, [props.value])
  return (
    <textarea
      ref={ref}
      className={props.className || 'story-lock-textarea compact-rows'}
      aria-label={props.ariaLabel}
      rows={2}
      wrap="soft"
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => props.onChange(event.target.value)}
      style={{ maxHeight: 'none', overflow: 'hidden', resize: 'none', overflowWrap: 'anywhere' }}
    />
  )
}
