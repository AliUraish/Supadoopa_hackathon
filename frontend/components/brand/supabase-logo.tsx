import { useId } from "react";

// The official Supabase mark (supabase/supabase apps/www/public/images/supabase-logo-icon.svg),
// unmodified. Also served as /brand/supabase-logo-icon.svg for textures and <img>.
export function SupabaseLogo({ size = 20, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg
      width={(size * 109) / 113}
      height={size}
      viewBox="0 0 109 113"
      fill="none"
      className={className}
      role="img"
      aria-label="Supabase"
    >
      <path
        fill={`url(#${id}a)`}
        d="M63.708 110.284c-2.86 3.601-8.658 1.628-8.727-2.97l-1.007-67.251h45.22c8.19 0 12.758 9.46 7.665 15.874z"
      />
      <path
        fill={`url(#${id}b)`}
        fillOpacity=".2"
        d="M63.708 110.284c-2.86 3.601-8.658 1.628-8.727-2.97l-1.007-67.251h45.22c8.19 0 12.758 9.46 7.665 15.874z"
      />
      <path
        fill="#3ecf8e"
        d="M45.317 2.071c2.86-3.601 8.657-1.628 8.726 2.97l.442 67.251H9.83c-8.19 0-12.759-9.46-7.665-15.875z"
      />
      <defs>
        <linearGradient id={`${id}a`} x1="53.974" x2="94.163" y1="54.974" y2="71.829" gradientUnits="userSpaceOnUse">
          <stop stopColor="#249361" />
          <stop offset="1" stopColor="#3ecf8e" />
        </linearGradient>
        <linearGradient id={`${id}b`} x1="36.156" x2="54.484" y1="30.578" y2="65.081" gradientUnits="userSpaceOnUse">
          <stop />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
