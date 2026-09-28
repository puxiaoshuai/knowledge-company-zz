/** 企业知识库品牌标：中心节点向外辐射，表示知识汇聚 */
export function BrandLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ display: 'block', flexShrink: 0, filter: 'drop-shadow(0 0 6px rgba(46, 168, 255, 0.55))' }}
    >
      <defs>
        <linearGradient id="kh-logo-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1a7dff" />
          <stop offset="1" stopColor="#00c0e8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#kh-logo-bg)" />
      <path
        d="M16 12.6V8.6M19.1 17.8l3.9 2.2M12.9 17.8L9 20"
        stroke="#eaf6ff"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="3.4" fill="#fff" />
      <circle cx="16" cy="7.2" r="2" fill="#8ef1ff" />
      <circle cx="24.8" cy="21.2" r="2" fill="#8ef1ff" />
      <circle cx="7.2" cy="21.2" r="2" fill="#8ef1ff" />
      <circle cx="16" cy="7.2" r="1.15" fill="#0b1120" />
      <circle cx="24.8" cy="21.2" r="1.15" fill="#0b1120" />
      <circle cx="7.2" cy="21.2" r="1.15" fill="#0b1120" />
    </svg>
  )
}
