import React from 'react';

export type ProviderId = 'deepseek' | 'gemini' | 'chatgpt';

const PROVIDER_IDS: readonly ProviderId[] = ['deepseek', 'gemini', 'chatgpt'] as const;

export const PROVIDER_LOGO_DIR = 'MagNum/src/assets/providers';

// فایل‌های SVG خودت را از پوشهٔ بالا می‌خواند — هیچ لوگویی داخل کد ساخته نمی‌شود.
const modules = import.meta.glob('../../assets/providers/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>;

const baseName = (p: string) =>
  (p.split('/').pop() || '').toLowerCase().replace(/\.svg$/i, '');

const resolved: Record<ProviderId, string | null> = {
  deepseek: null,
  gemini: null,
  chatgpt: null
};

// پاس ۱: تطابق دقیق نام (deepseek.svg)
for (const [p, url] of Object.entries(modules)) {
  const n = baseName(p);
  const hit = PROVIDER_IDS.find(id => n === id);
  if (hit) resolved[hit] = url;
}

// پاس ۲: نام‌های توسعه‌یافته (deepseek-logo.svg / gemini_icon.svg)
for (const [p, url] of Object.entries(modules)) {
  const n = baseName(p);
  const hit = PROVIDER_IDS.find(id => !resolved[id] && n.startsWith(id));
  if (hit) resolved[hit] = url;
}

if (import.meta.env.DEV) {
  const missing = PROVIDER_IDS.filter(id => !resolved[id]);
  if (missing.length) {
    console.warn(
      `[ProviderLogo] فایل SVG پیدا نشد: ${missing
        .map(id => `${PROVIDER_LOGO_DIR}/${id}.svg`)
        .join(' , ')}`
    );
  }
}

export const hasProviderLogo = (id: ProviderId): boolean => Boolean(resolved[id]);
export const providerLogoSrc = (id: ProviderId): string | null => resolved[id];

interface ProviderLogoProps {
  provider: ProviderId;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** brand = رنگ‌های اصلی خود فایل | mono = همان شکل، تک‌رنگ با currentColor */
  variant?: 'brand' | 'mono';
  title?: string;
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({
  provider,
  size = 28,
  className,
  style,
  variant = 'brand',
  title
}) => {
  const src = resolved[provider];

  if (!src) {
    return (
      <span
        className={className}
        role="img"
        aria-label={title || `${provider} logo missing`}
        title={title || `${provider}.svg را در ${PROVIDER_LOGO_DIR} قرار بده`}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          borderRadius: Math.max(3, Math.round(size * 0.22)),
          border: '1px dashed currentColor',
          opacity: 0.45,
          fontSize: Math.max(8, Math.round(size * 0.46)),
          fontWeight: 800,
          lineHeight: 1,
          textTransform: 'uppercase',
          userSelect: 'none',
          ...style
        }}
      >
        {provider.charAt(0)}
      </span>
    );
  }

  if (variant === 'mono') {
    return (
      <span
        className={className}
        role="img"
        aria-label={title || provider}
        title={title}
        style={{
          display: 'inline-block',
          width: size,
          height: size,
          flexShrink: 0,
          backgroundColor: 'currentColor',
          WebkitMaskImage: `url("${src}")`,
          maskImage: `url("${src}")`,
          WebkitMaskRepeat: 'no-repeat',
          maskRepeat: 'no-repeat',
          WebkitMaskPosition: 'center',
          maskPosition: 'center',
          WebkitMaskSize: 'contain',
          maskSize: 'contain',
          ...style
        }}
      />
    );
  }

  return (
    <img
      src={src}
      width={size}
      height={size}
      className={className}
      title={title}
      alt={title || ''}
      aria-hidden={title ? undefined : true}
      draggable={false}
      decoding="async"
      style={{
        display: 'block',
        width: size,
        height: size,
        objectFit: 'contain',
        flexShrink: 0,
        userSelect: 'none',
        ...style
      }}
    />
  );
};
