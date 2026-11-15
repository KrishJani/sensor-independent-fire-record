import type { CSSProperties } from 'react';

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  label: string;
  className?: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  disabled,
}: Props<T>) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );
  const style = { '--count': options.length } as CSSProperties;

  return (
    <div
      className={`segmented material ${disabled ? 'is-disabled' : ''} ${className ?? ''}`}
      role="tablist"
      aria-label={label}
      aria-disabled={disabled}
      style={style}
    >
      <span className="segmented__thumb" style={{ transform: `translateX(${index * 100}%)` }} />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          disabled={disabled}
          className="segmented__item"
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
