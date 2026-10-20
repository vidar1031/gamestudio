// 设置页图标（16px / 1.5 描边 / currentColor；线性风格，与既有界面 glyphs 同规格）
import type { SVGProps } from 'react'

function IconBase(props: SVGProps<SVGSVGElement> & { children?: React.ReactNode }) {
  const { children, ...rest } = props
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconScript(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" /><path d="M6 8h5M6 11h5" /></>) })
}

export function IconPrompt(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><path d="M2 8l3-5 2 3 3-4 4 6-3 5H5z" /><circle cx="5.5" cy="10.5" r="0.8" /></>) })
}

export function IconTranslate(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><path d="M2 4h6M5 2v2c0 3-2 5-3.5 6M5.5 6c.5 2 2 4 4 5" /><path d="M8.5 14l2.5-6 2.5 6M9.5 11.5h3" /></>) })
}

export function IconReview(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z" /><path d="M5.5 8l2 2 3-3.5" /></>) })
}

export function IconImage(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="5.5" cy="6.5" r="1" /><path d="M2 11l3.5-3 2.5 2 2.5-2.5L14 11" /></>) })
}

export function IconVoice(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><rect x="6" y="2" width="4" height="7" rx="2" /><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" /></>) })
}

export function IconVideo(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><rect x="2" y="4" width="8.5" height="9" rx="1.5" /><path d="M10.5 7l3.5-2v7l-3.5-2" /></>) })
}

export function IconPalette(p: SVGProps<SVGSVGElement>) {
  return IconBase({
    ...p,
    children: (<><path d="M8 2a6 6 0 0 0 0 12c1 0 1.5-.7 1.5-1.5S9 11 9.8 11h1.7A2.5 2.5 0 0 0 14 8.5C14 5 11.3 2 8 2z" /><circle cx="5.5" cy="6.5" r="0.7" /><circle cx="8" cy="5" r="0.7" /><circle cx="10.5" cy="6.5" r="0.7" /></>)
  })
}

export function IconStorage(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><path d="M2 5l1.5-2.5h9L14 5M2 5v8h12V5" /><path d="M6 8.5h4" /></>) })
}

export function IconKey(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><circle cx="5.5" cy="5.5" r="3" /><path d="M7.8 7.8L13 13M11.5 9.5l1.5 1.5M10 11l1.2 1.2" /></>) })
}

export function IconNetwork(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2.2 2.2 2.2 9.8 0 12M8 2c-2.2 2.2-2.2 9.8 0 12" /></>) })
}

export function IconDiag(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: <path d="M2 9h3l1.5-4 3 7L11 9h3" /> })
}

export function IconAbout(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: (<><circle cx="8" cy="8" r="6" /><path d="M8 7.5V12" /><circle cx="8" cy="4.8" r="0.8" fill="currentColor" stroke="none" /></>) })
}

export function IconMatrix(p: SVGProps<SVGSVGElement>) {
  return IconBase({
    ...p,
    children: (<><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></>)
  })
}

export function IconChevron(p: SVGProps<SVGSVGElement>) {
  return IconBase({ ...p, children: <path d="M5 3l5 5-5 5" /> })
}

// 2026-10-20 守护台关联卡：链环节图标（同 16×16 / 1.5 描边规格）
export function IconLink(p: SVGProps<SVGSVGElement>) {
  return IconBase({
    ...p,
    children: (<><path d="M6.5 9.5a3.5 3.5 0 0 0 5 .5l2-2a3.5 3.5 0 0 0-5-5l-1 1" /><path d="M9.5 6.5a3.5 3.5 0 0 0-5-.5l-2 2a3.5 3.5 0 0 0 5 5l1-1" /></>)
  })
}
