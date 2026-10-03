// Doorway's own mark: a door frame, slightly ajar, with green light in the opening.

export function DoorwayMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="4.25" y="2.25" width="15.5" height="19.5" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 5.5h9v13h-9z" fill="#3ECF8E" />
      <path d="M7.5 5.5 12.5 7v10l-5 1.5z" fill="#121212" />
      <circle cx="11" cy="12" r="0.8" fill="#3ECF8E" />
    </svg>
  );
}

export function DoorwayLogo({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-text ${className ?? ""}`}>
      <DoorwayMark />
      <span className="text-[15px] font-semibold tracking-tight">Doorway</span>
    </span>
  );
}
