// App-icon lockup: a rounded tile in the theme colour (--brand-accent, classic orange by default), a dark bar
// and a white arrow crossing it. The gap around the arrow is painted in the tile colour.
// variant="bare": no tile, for photos and dark backgrounds: a white bar with a black arrow on top.
// variant="light": a white rounded tile with the dark bar and the orange arrow, for photos.
export function CrossroadMark({ size = 22, variant = 'tile' }: { size?: number; variant?: 'tile' | 'bare' | 'light' }) {
  const [w, gap] = size <= 24 ? [12, 22] : size <= 48 ? [10, 20] : [9, 19];
  if (variant === 'bare') return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" className="brand-mark bare">
    <path d="M15 15 L49 49" className="brand-ink" strokeWidth={9} strokeLinecap="round"/>
    <path d="M15 49 L47 17" className="brand-arrow" strokeWidth={9} strokeLinecap="round"/>
    <path d="M30 15 H49 V34" className="brand-arrow" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" className={`brand-mark${variant === 'light' ? ' light' : ''}`}>
    <rect width="64" height="64" rx="16" className="brand-tile"/>
    <g transform="translate(12 12) scale(0.625)">
      <path d="M15 15 L49 49" className="brand-ink" strokeWidth={w} strokeLinecap="round"/>
      <path d="M15 49 L47 17" className="brand-gap" strokeWidth={gap} strokeLinecap="round"/>
      <path d="M15 49 L47 17" className="brand-arrow" strokeWidth={w} strokeLinecap="round"/>
      <path d="M30 15 H49 V34" className="brand-arrow" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round"/>
    </g>
  </svg>;
}

export function Brand({ size = 22 }: { size?: number }) {
  return <span className="brand"><CrossroadMark size={size}/><span className="brand-word">crossroad</span></span>;
}
