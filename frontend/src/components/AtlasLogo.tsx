/**
 * ATLAS Brandmark - Hexagonal Prism & Celestial Alpha Geometric Logo.
 *
 * Designed with:
 *   - Outer Hex Shield (security & institutional robustness)
 *   - Dual-pillar faceted Alpha 'A' (growth & alpha generation)
 *   - Luminous horizon crossbar with cyber gradient
 *   - Benchmark star point at the apex
 */

import { memo } from 'react'

interface AtlasLogoProps {
  size?: number
  className?: string
}

export const AtlasLogo = memo(function AtlasLogo({
  size = 24,
  className = '',
}: AtlasLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`atlas-logo ${className}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="atlas-grad-primary" x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00f0ff" />
          <stop offset="45%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id="atlas-grad-accent" x1="8" y1="18.5" x2="24" y2="18.5" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#00f0ff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#a855f7" stopOpacity="0.95" />
        </linearGradient>
        <filter id="atlas-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* Outer Hex Shield Frame */}
      <path
        d="M16 2.5L28.5 9.5V22.5L16 29.5L3.5 22.5V9.5L16 2.5Z"
        stroke="url(#atlas-grad-primary)"
        strokeWidth="1.8"
        strokeLinejoin="round"
        fill="rgba(0, 240, 255, 0.06)"
      />

      {/* Internal Radial Geometry */}
      <path
        d="M16 2.5V29.5"
        stroke="url(#atlas-grad-primary)"
        strokeWidth="0.75"
        strokeDasharray="2 2"
        opacity="0.3"
      />

      {/* Dynamic Geometric 'A' Peak */}
      <path
        d="M16 6.8L23.2 23.2H19.6L16 14.5L12.4 23.2H8.8L16 6.8Z"
        fill="url(#atlas-grad-primary)"
        filter="url(#atlas-glow)"
      />

      {/* Floating Laser Horizon Crossbar */}
      <path
        d="M11 18.5H21"
        stroke="url(#atlas-grad-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />

      {/* Core Benchmark Anchor Point */}
      <circle cx="16" cy="11.2" r="1.5" fill="#ffffff" />
    </svg>
  )
})
